// Package serve implements the D10 server-side helper: a child process of
// the Cove server that joins the tailnet as its own node, listens only on
// the ports the server asks for, and hands each accepted connection to the
// server's Unix forward socket preceded by a header with the WhoIs result.
//
// The control channel is the process's stdin/stdout, so the auth key can
// only arrive from the supervising server and the helper exits when that
// server goes away (stdin EOF).
package serve

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fsutil"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/pipe"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

const (
	defaultLoginTimeout  = 60 * time.Second
	maxLoginTimeout      = 5 * time.Minute
	logoutControlTimeout = 10 * time.Second
	whoIsTimeout         = 5 * time.Second
	forwardDialTimeout   = 5 * time.Second
	// maxConns bounds forwarded connections across all ports. The Cove
	// server applies its own, tighter unauthenticated-connection budget;
	// this only keeps the helper's file descriptors bounded.
	maxConns = 512
	maxPorts = 16
)

// Config configures serve mode.
type Config struct {
	// Home is the server tsnet directory, <cove home>/tsnet. Node state
	// lives in Home/state.
	Home       string
	Hostname   string
	ControlURL string
	// ForwardSocket is the Unix socket the Cove server listens on. Its
	// directory must already exist, be owned by this user and be 0700.
	ForwardSocket string
	Build         string
	Start         node.Starter
	NodeLogf      func(format string, args ...any)
	Logf          func(format string, args ...any)
	In            io.Reader
	Out           io.Writer
}

type server struct {
	cfg Config
	mgr *node.Manager

	// ctl serializes node lifecycle operations (login, logout, setPorts,
	// boot, shutdown) against status.
	ctl sync.RWMutex
	// desired is the port set the Cove server asked for; it is reapplied
	// whenever a node starts. listeners holds the open ones. Both are
	// guarded by ctl.
	desired   []int
	listeners map[int]net.Listener

	outMu sync.Mutex
	out   io.Writer

	connMu sync.Mutex
	conns  int

	wg sync.WaitGroup
}

// Run serves until stdin reaches EOF or ctx ends. Node state is kept on
// exit; only an explicit logout deletes it.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if err := fsutil.EnsurePrivateDir(cfg.Home); err != nil {
		return err
	}
	if err := fsutil.CheckSocketPath(cfg.ForwardSocket); err != nil {
		return err
	}
	if err := fsutil.CheckPrivateDir(filepath.Dir(cfg.ForwardSocket)); err != nil {
		return fmt.Errorf("forward socket directory: %w", err)
	}
	s := &server{
		cfg: cfg,
		mgr: node.NewManager(node.Config{
			StateDir:   filepath.Join(cfg.Home, "state"),
			Hostname:   cfg.Hostname,
			ControlURL: cfg.ControlURL,
			Logf:       cfg.NodeLogf,
		}, cfg.Start),
		listeners: map[int]net.Listener{},
		out:       cfg.Out,
	}
	s.ctl.Lock()
	go func() {
		defer s.ctl.Unlock()
		s.mgr.Boot()
	}()

	frames := make(chan proto.Request)
	readErr := make(chan error, 1)
	go func() {
		br := bufio.NewReader(cfg.In)
		for {
			req, err := proto.ReadRequest(br)
			if err != nil {
				var pe *proto.Error
				if errors.As(err, &pe) {
					s.write(proto.Fail(req, pe))
					continue
				}
				readErr <- err
				return
			}
			frames <- req
		}
	}()

	helloSeen, helloProtocol := false, 0
	var reason string
loop:
	for {
		select {
		case <-ctx.Done():
			reason = "signal"
			break loop
		case err := <-readErr:
			reason = "control channel closed"
			if !errors.Is(err, io.EOF) {
				reason = "control channel error: " + err.Error()
			}
			break loop
		case req := <-frames:
			if !helloSeen {
				if req.Op != proto.OpHello {
					s.write(proto.Fail(req, proto.Errorf(proto.CodeBadRequest, "the first request must be hello")))
					continue
				}
				helloSeen, helloProtocol = true, req.Protocol
				s.write(proto.Succeed(req, proto.Hello{
					Protocol: proto.Version, Build: cfg.Build, Mode: "serve", PID: os.Getpid(), Streams: []proto.StreamInfo{},
				}))
				continue
			}
			if helloProtocol != proto.Version {
				s.write(proto.Fail(req, proto.Errorf(proto.CodeProtocolMismatch,
					"client protocol %d, helper protocol %d", helloProtocol, proto.Version)))
				continue
			}
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				s.handle(ctx, req)
			}()
		}
	}
	cfg.Logf("serve: shutting down (%s)", reason)
	s.ctl.Lock()
	s.closeListeners()
	s.mgr.Close()
	s.ctl.Unlock()
	return nil
}

func (s *server) write(resp proto.Response) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	proto.WriteFrame(s.out, resp)
}

func (s *server) handle(ctx context.Context, req proto.Request) {
	reply := func(result any, err error) {
		if err != nil {
			s.write(proto.Fail(req, err))
			return
		}
		s.write(proto.Succeed(req, result))
	}
	switch req.Op {
	case proto.OpHello:
		reply(nil, proto.Errorf(proto.CodeBadRequest, "hello was already sent"))
	case proto.OpStatus:
		s.ctl.RLock()
		st, err := s.status(ctx)
		s.ctl.RUnlock()
		reply(st, err)
	case proto.OpLogin:
		s.ctl.Lock()
		timeout := defaultLoginTimeout
		if req.TimeoutMs > 0 {
			timeout = min(time.Duration(req.TimeoutMs)*time.Millisecond, maxLoginTimeout)
		}
		before := s.mgr.Node()
		st, err := s.mgr.Login(ctx, req.AuthKey, timeout)
		if s.mgr.Node() != before {
			// A key login replaces the node object; listeners of the old
			// node are dead and are reopened on the new one.
			s.closeListeners()
		}
		if lerr := s.reconcile(); err == nil && lerr != nil {
			err = lerr
		}
		st.Ports = s.ports()
		s.ctl.Unlock()
		reply(st, err)
	case proto.OpLogout:
		s.ctl.Lock()
		s.closeListeners()
		st, err := s.mgr.Logout(ctx, logoutControlTimeout)
		s.ctl.Unlock()
		reply(st, err)
	case proto.OpSetPorts:
		s.ctl.Lock()
		err := s.setPorts(req.Ports)
		var st proto.Status
		if err == nil {
			st, err = s.status(ctx)
		}
		s.ctl.Unlock()
		reply(st, err)
	default:
		reply(nil, proto.Errorf(proto.CodeBadRequest, "unknown op %q", req.Op))
	}
}

func (s *server) status(ctx context.Context) (proto.Status, error) {
	st, err := s.mgr.Status(ctx)
	if err != nil {
		return st, err
	}
	st.Ports = s.ports()
	return st, nil
}

func (s *server) ports() []int {
	out := make([]int, 0, len(s.listeners))
	for p := range s.listeners {
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

func (s *server) setPorts(ports []int) error {
	if len(ports) > maxPorts {
		return proto.Errorf(proto.CodeBadRequest, "at most %d ports", maxPorts)
	}
	want := slices.Clone(ports)
	slices.Sort(want)
	want = slices.Compact(want)
	for _, p := range want {
		if p < 1 || p > 65535 {
			return proto.Errorf(proto.CodeBadRequest, "port %d is out of range", p)
		}
	}
	s.desired = want
	return s.reconcile()
}

// reconcile opens the desired ports that are not open and closes the rest.
// Closing a listener never touches connections it already accepted, so
// closing the pairing port leaves established business connections alone.
// Without a node (logged out) nothing is open; the desired set is kept and
// applied by the next login.
func (s *server) reconcile() error {
	// tsnet accepts a listener before the node is Running, so a node that
	// is still coming up or waiting for login gets its ports immediately.
	n := s.mgr.Node()
	if n == nil {
		s.closeListeners()
		return nil
	}
	for p, ln := range s.listeners {
		if !slices.Contains(s.desired, p) {
			ln.Close()
			delete(s.listeners, p)
		}
	}
	var failed []string
	for _, p := range s.desired {
		if _, ok := s.listeners[p]; ok {
			continue
		}
		ln, err := n.Listen(p)
		if err != nil {
			failed = append(failed, fmt.Sprintf("%d: %v", p, err))
			continue
		}
		s.listeners[p] = ln
		go s.acceptLoop(n, p, ln)
	}
	if len(failed) > 0 {
		return proto.Errorf(proto.CodeListenFailed, "cannot listen on %v", failed)
	}
	return nil
}

func (s *server) closeListeners() {
	for p, ln := range s.listeners {
		ln.Close()
		delete(s.listeners, p)
	}
}

func (s *server) acceptLoop(n node.Node, port int, ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		s.connMu.Lock()
		if s.conns >= maxConns {
			s.connMu.Unlock()
			c.Close()
			continue
		}
		s.conns++
		s.connMu.Unlock()
		go func() {
			defer func() {
				s.connMu.Lock()
				s.conns--
				s.connMu.Unlock()
			}()
			s.forward(n, port, c)
		}()
	}
}

// forward hands one tailnet connection to the Cove server. The peer
// identity is attached for display and audit only; the Cove server still
// requires a device token on the connection.
func (s *server) forward(n node.Node, port int, c net.Conn) {
	hdr := proto.ForwardHeader{Protocol: proto.Version, Port: port, RemoteAddr: c.RemoteAddr().String()}
	ctx, cancel := context.WithTimeout(context.Background(), whoIsTimeout)
	who, err := n.WhoIs(ctx, hdr.RemoteAddr)
	cancel()
	if err != nil {
		hdr.WhoIsError = err.Error()
	} else {
		hdr.Peer = &who
	}
	uc, err := net.DialTimeout("unix", s.cfg.ForwardSocket, forwardDialTimeout)
	if err != nil {
		s.cfg.Logf("serve: forward socket unavailable for port %d: %v", port, err)
		c.Close()
		return
	}
	if err := proto.WriteFrame(uc, hdr); err != nil {
		uc.Close()
		c.Close()
		return
	}
	peerID := "unknown"
	if hdr.Peer != nil {
		peerID = hdr.Peer.StableNodeID
	}
	s.cfg.Logf("serve: connection on port %d from %s", port, peerID)
	pipe.Join(uc, uc, c)
}
