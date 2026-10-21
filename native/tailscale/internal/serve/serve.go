// Package serve implements the D10 server-side helper: a child process of
// the Cove server that joins the tailnet as its own node, listens only on
// the ports the server asks for, and hands each accepted connection to the
// server's Unix forward socket preceded by a header with the WhoIs result.
//
// The control channel is the process's stdin/stdout, so the auth key can
// only arrive from the supervising server and the helper exits when that
// server goes away (stdin EOF). On any exit the lifetime context is
// cancelled first, so a pending login returns at once; queued requests are
// refused; and handlers are drained before the node is closed.
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
	drainTimeout         = 15 * time.Second
	// DefaultMaxConns bounds forwarded connections across all ports. The
	// Cove server applies its own, tighter unauthenticated-connection
	// budget; this only keeps the helper's file descriptors bounded.
	DefaultMaxConns = 512
	// DefaultForwardGrace is how long a tailnet peer may keep sending after
	// the Cove server closed its side of a forwarded connection. Without the
	// bound, a peer that never sends again would hold the connection (and a
	// unit of the budget) forever after the server rejected it.
	DefaultForwardGrace = 10 * time.Second
)

// ErrControlChannel reports that the control channel ended abnormally
// (truncated frame, oversized frame, I/O error) rather than by a clean EOF.
var ErrControlChannel = errors.New("control channel failed")

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
	// MaxConns and ForwardGrace default to DefaultMaxConns and
	// DefaultForwardGrace; tests lower them.
	MaxConns     int
	ForwardGrace time.Duration
}

type server struct {
	cfg Config
	mgr *node.Manager

	life   context.Context
	cancel context.CancelFunc

	// ctl serializes node lifecycle operations (status, login, logout,
	// setPorts, boot, shutdown). Status takes it exclusively too: it may
	// settle an identity hold and reopen the listeners.
	ctl sync.Mutex
	// desired is the port set the Cove server asked for; it is reapplied
	// whenever a node starts. listeners holds the open ones. Both are
	// guarded by ctl.
	desired   []int
	listeners map[int]net.Listener

	outMu sync.Mutex
	out   io.Writer

	mu       sync.Mutex
	closing  bool
	handlers sync.WaitGroup
	conns    int
}

// Run serves until stdin reaches EOF or ctx ends, returning nil. It returns
// an error wrapping ErrControlChannel if the control channel ended
// abnormally. Node state is kept on exit; only an explicit logout deletes
// it.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.MaxConns <= 0 {
		cfg.MaxConns = DefaultMaxConns
	}
	if cfg.ForwardGrace <= 0 {
		cfg.ForwardGrace = DefaultForwardGrace
	}
	if !proto.ValidBuild(cfg.Build) {
		return fmt.Errorf("invalid build identifier %q", cfg.Build)
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
	// The manager places an identity hold under ctl, before the login it
	// guards starts; the listeners close in that same step and reopen only
	// through reconcile, once the manager reports the node usable again.
	s.mgr.OnHold(s.closeListeners)
	s.life, s.cancel = context.WithCancel(context.Background())
	defer s.cancel()
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
			var pe *proto.Error
			switch {
			case err == nil:
				select {
				case frames <- req:
				case <-s.life.Done():
					return
				}
			case errors.As(err, &pe):
				// A complete line that is not a valid request: the stream is
				// still in sync, so answer and continue.
				s.write(proto.Fail(req, pe))
			case errors.Is(err, proto.ErrFrameTooLarge):
				// The rest of the oversized line is unread and cannot be
				// trusted to resynchronize; answer, then end the channel.
				s.write(proto.Fail(req, err))
				readErr <- fmt.Errorf("%w: frame exceeds %d bytes", ErrControlChannel, proto.MaxFrameBytes)
				return
			case errors.Is(err, io.EOF):
				readErr <- nil
				return
			default:
				readErr <- fmt.Errorf("%w: %v", ErrControlChannel, err)
				return
			}
		}
	}()

	helloSeen, helloProtocol := false, 0
	var reason string
	var result error
loop:
	for {
		select {
		case <-ctx.Done():
			reason = "signal"
			break loop
		case err := <-readErr:
			reason, result = "control channel closed", err
			if err != nil {
				reason = err.Error()
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
			s.mu.Lock()
			s.handlers.Add(1)
			s.mu.Unlock()
			go func() {
				defer s.handlers.Done()
				s.handle(req)
			}()
		}
	}
	cfg.Logf("serve: shutting down (%s)", reason)
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.cancel()
	if !waitTimeout(&s.handlers, drainTimeout) {
		cfg.Logf("serve: handlers still running after %v; closing anyway", drainTimeout)
	}
	s.ctl.Lock()
	s.closeListeners()
	s.mgr.Close()
	s.ctl.Unlock()
	return result
}

func (s *server) write(resp proto.Response) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	proto.WriteResponse(s.out, resp)
}

func (s *server) isClosing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closing
}

var errShuttingDown = proto.Errorf(proto.CodeShuttingDown, "helper is shutting down")

func (s *server) handle(req proto.Request) {
	ctx := s.life
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
		s.ctl.Lock()
		st, err := s.status(ctx)
		s.ctl.Unlock()
		reply(st, err)
	case proto.OpLogin:
		s.ctl.Lock()
		st, err := s.login(ctx, req)
		s.ctl.Unlock()
		reply(st, err)
	case proto.OpLogout:
		s.ctl.Lock()
		var st proto.Status
		err := error(errShuttingDown)
		if !s.isClosing() {
			s.closeListeners()
			st, err = s.mgr.Logout(ctx, logoutControlTimeout)
		}
		s.ctl.Unlock()
		reply(st, err)
	case proto.OpSetPorts:
		s.ctl.Lock()
		err := error(errShuttingDown)
		if !s.isClosing() {
			err = s.setPorts(req.Ports)
		}
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

func (s *server) login(ctx context.Context, req proto.Request) (proto.Status, error) {
	if s.isClosing() {
		return proto.Status{}, errShuttingDown
	}
	// A login that could change the node's identity places a hold, which
	// closes the listeners (OnHold) before the login starts; reconcile
	// reopens them only if the node is usable afterwards.
	st, err := s.mgr.Login(ctx, req.AuthKey, proto.Timeout(req.TimeoutMs, defaultLoginTimeout, maxLoginTimeout))
	if lerr := s.reconcile(); err == nil && lerr != nil {
		err = lerr
	}
	st.Ports = s.ports()
	return st, err
}

func (s *server) status(ctx context.Context) (proto.Status, error) {
	if s.isClosing() {
		return proto.Status{}, errShuttingDown
	}
	st, err := s.mgr.Status(ctx)
	if err != nil {
		return st, err
	}
	// Status may have settled a hold, so the listeners follow it here.
	if lerr := s.reconcile(); lerr != nil {
		st.Warnings = append(st.Warnings, lerr.Error())
		st = st.Bounded()
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
	if len(ports) > proto.MaxPorts {
		return proto.Errorf(proto.CodeBadRequest, "at most %d ports", proto.MaxPorts)
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
// Without a usable node (logged out, or held while its identity is not
// confirmed) nothing is open; the desired set is kept and applied once the
// node is usable.
func (s *server) reconcile() error {
	// tsnet accepts a listener before the node is Running, so a node that
	// is still coming up or waiting for login gets its ports immediately.
	n := s.mgr.Usable()
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
		s.mu.Lock()
		if s.closing || s.conns >= s.cfg.MaxConns {
			s.mu.Unlock()
			c.Close()
			continue
		}
		s.conns++
		s.mu.Unlock()
		go func() {
			defer func() {
				s.mu.Lock()
				s.conns--
				s.mu.Unlock()
			}()
			s.forward(n, port, c)
		}()
	}
}

// forward hands one tailnet connection to the Cove server. The peer
// identity is attached for display and audit only; the Cove server still
// requires a device token on the connection.
func (s *server) forward(n node.Node, port int, c net.Conn) {
	hdr := proto.ForwardHeader{Protocol: proto.Version, Port: port, RemoteAddr: proto.Truncate(c.RemoteAddr().String())}
	ctx, cancel := context.WithTimeout(s.life, whoIsTimeout)
	who, err := n.WhoIs(ctx, hdr.RemoteAddr)
	cancel()
	if err != nil {
		hdr.WhoIsError = proto.Truncate(err.Error())
	} else {
		hdr.Peer = &who
	}
	uc, err := net.DialTimeout("unix", s.cfg.ForwardSocket, forwardDialTimeout)
	if err != nil {
		s.cfg.Logf("serve: forward socket unavailable for port %d: %v", port, err)
		c.Close()
		return
	}
	uc.SetWriteDeadline(time.Now().Add(forwardDialTimeout))
	if err := proto.WriteFrame(uc, hdr); err != nil {
		uc.Close()
		c.Close()
		return
	}
	uc.SetWriteDeadline(time.Time{})
	peerID := "unknown"
	if hdr.Peer != nil {
		peerID = hdr.Peer.StableNodeID
	}
	s.cfg.Logf("serve: connection on port %d from %s", port, peerID)
	// The Cove server (uc) is the trusted side: once it closes, the tailnet
	// peer gets ForwardGrace to finish before the connection is torn down.
	pipe.Join(uc, uc, c, s.cfg.ForwardGrace)
}

func waitTimeout(wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}
