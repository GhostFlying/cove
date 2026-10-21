// Package dial implements the D14 client daemon: the single per-user owner
// of the client tsnet node. CLI commands reach it over a Unix socket in a
// 0700 directory and ask it either for a control operation (status, login,
// logout, stop) or for a byte stream to a server node identified by its
// stable node ID. The node never listens on any tailnet port.
//
// Ownership is decided by a kernel flock on run/lock, never by the presence
// of the socket file: the lock is taken before the node state is opened,
// the socket is unlinked before the lock is released, and the kernel
// releases the lock when the process dies. A stale socket left by a killed
// owner is therefore removed by whichever process next holds the lock.
package dial

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fsutil"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/pipe"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// Bounds. The socket is reachable only by the owning user, so these guard
// against honest mistakes (a stuck client, a runaway script), not attacks.
const (
	handshakeTimeout     = 10 * time.Second
	defaultDialTimeout   = 15 * time.Second
	maxDialTimeout       = 60 * time.Second
	defaultLoginTimeout  = 60 * time.Second
	maxLoginTimeout      = 5 * time.Minute
	logoutControlTimeout = 10 * time.Second
	peerLookupWindow     = 5 * time.Second
	maxStreams           = 256
	maxConns             = 512
	maxLabelBytes        = 200
)

// Config configures the daemon.
type Config struct {
	// Home is the client tsnet directory, <cove home>/tsnet-client. The node
	// state lives in Home/state and the lock and socket in Home/run.
	Home        string
	Hostname    string
	ControlURL  string
	IdleTimeout time.Duration
	Build       string
	Start       node.Starter
	// NodeLogf receives verbose tsnet logs; nil discards them.
	NodeLogf func(format string, args ...any)
	// Logf receives the daemon's own one-line events. They never contain
	// secrets: only stream IDs, stable node IDs and ports.
	Logf func(format string, args ...any)
	// Pause, if set, is called at named points so a test fixture can stop
	// or kill the process there (see PROTOCOL.md, "Test pause points").
	Pause func(point string)
}

// Paths returns the lock and socket paths for a client tsnet directory.
func Paths(home string) (lock, socket string) {
	return filepath.Join(home, "run", "lock"), filepath.Join(home, "run", "dial.sock")
}

// ErrLocked reports that another daemon owns the directory.
var ErrLocked = fsutil.ErrLocked

type stream struct {
	info  proto.StreamInfo
	local net.Conn
	peer  net.Conn
}

type daemon struct {
	cfg  Config
	mgr  *node.Manager
	ln   net.Listener
	sock string

	// ctl serializes login, logout and stop (write side) against status and
	// dial setup (read side). Holding the read side until a new stream is
	// registered guarantees logout and stop see every stream.
	ctl sync.RWMutex

	mu         sync.Mutex
	conns      int
	lastActive time.Time
	streams    map[string]*stream
	nextID     uint64
	closing    bool

	shutdownOnce sync.Once
	done         chan struct{}
}

// Run takes ownership of cfg.Home and serves until idle, stopped or ctx
// ends. It returns ErrLocked without touching anything else when another
// process owns the directory.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.Pause == nil {
		cfg.Pause = func(string) {}
	}
	if cfg.IdleTimeout <= 0 {
		return errors.New("idle timeout must be positive")
	}
	runDir := filepath.Join(cfg.Home, "run")
	if err := fsutil.EnsurePrivateDir(cfg.Home); err != nil {
		return err
	}
	if err := fsutil.EnsurePrivateDir(runDir); err != nil {
		return err
	}
	lockPath, sock := Paths(cfg.Home)
	if err := fsutil.CheckSocketPath(sock); err != nil {
		return err
	}
	lock, err := fsutil.Lock(lockPath)
	if err != nil {
		return err
	}
	// Closing the lock file is the last thing Run does, after the socket is
	// gone, so a new owner never finds a live daemon behind a stale socket.
	defer lock.Close()
	cfg.Pause("locked")

	// We hold the lock, so any socket file here belongs to a dead owner.
	if err := os.Remove(sock); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing stale socket: %w", err)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	if err := os.Chmod(sock, 0o600); err != nil {
		ln.Close()
		return err
	}

	d := &daemon{
		cfg:  cfg,
		ln:   ln,
		sock: sock,
		mgr: node.NewManager(node.Config{
			StateDir:   filepath.Join(cfg.Home, "state"),
			Hostname:   cfg.Hostname,
			ControlURL: cfg.ControlURL,
			Logf:       cfg.NodeLogf,
		}, cfg.Start),
		lastActive: time.Now(),
		streams:    map[string]*stream{},
		done:       make(chan struct{}),
	}
	// The socket is ready before the node: hello and status answer at once
	// and dial requests wait (boundedly) for the restored node.
	d.ctl.Lock()
	go func() {
		defer d.ctl.Unlock()
		d.mgr.Boot()
	}()
	cfg.Logf("dial: listening pid=%d", os.Getpid())

	go d.acceptLoop()
	go d.idleLoop()
	select {
	case <-ctx.Done():
		d.shutdown("signal")
	case <-d.done:
	}
	<-d.done
	cfg.Pause("unlinked")
	d.closeStreams()
	d.ctl.Lock()
	d.mgr.Close()
	d.ctl.Unlock()
	cfg.Logf("dial: exited")
	return nil
}

// shutdown stops accepting and unlinks the socket. The lock stays held
// until Run returns.
func (d *daemon) shutdown(reason string) {
	d.shutdownOnce.Do(func() {
		d.mu.Lock()
		d.closing = true
		d.mu.Unlock()
		d.ln.Close()
		os.Remove(d.sock)
		d.cfg.Logf("dial: shutting down (%s)", reason)
		close(d.done)
	})
}

func (d *daemon) acceptLoop() {
	for {
		c, err := d.ln.Accept()
		if err != nil {
			d.shutdown("listener closed")
			return
		}
		d.mu.Lock()
		if d.closing || d.conns >= maxConns {
			d.mu.Unlock()
			c.Close()
			continue
		}
		d.conns++
		d.mu.Unlock()
		go func() {
			defer d.release()
			d.handle(c)
		}()
	}
}

func (d *daemon) release() {
	d.mu.Lock()
	d.conns--
	d.lastActive = time.Now()
	d.mu.Unlock()
}

// idleLoop exits the daemon after IdleTimeout with no connection at all:
// an open stream or an in-flight control request keeps it alive.
func (d *daemon) idleLoop() {
	period := min(max(d.cfg.IdleTimeout/10, 50*time.Millisecond), time.Second)
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-d.done:
			return
		case <-t.C:
		}
		d.mu.Lock()
		idle := d.conns == 0 && time.Since(d.lastActive) >= d.cfg.IdleTimeout
		d.mu.Unlock()
		if idle {
			d.shutdown("idle")
			return
		}
	}
}

func (d *daemon) hello() proto.Hello {
	return proto.Hello{
		Protocol: proto.Version,
		Build:    d.cfg.Build,
		Mode:     "dial",
		PID:      os.Getpid(),
		Streams:  d.streamList(),
	}
}

func (d *daemon) handle(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(handshakeTimeout))
	br := bufio.NewReader(c)
	req, err := proto.ReadRequest(br)
	if err != nil {
		writeErr(c, req, err)
		return
	}
	if req.Op != proto.OpHello {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "the first request must be hello"))
		return
	}
	clientProtocol := req.Protocol
	if proto.WriteFrame(c, proto.Succeed(req, d.hello())) != nil {
		return
	}
	req, err = proto.ReadRequest(br)
	if err != nil {
		// A client that only wanted the hello simply closes.
		if !errors.Is(err, io.EOF) {
			writeErr(c, req, err)
		}
		return
	}
	// hello and stop are frozen across versions so any client can replace
	// any daemon; everything else needs the same protocol.
	if req.Op != proto.OpStop && clientProtocol != proto.Version {
		writeErr(c, req, proto.Errorf(proto.CodeProtocolMismatch,
			"client protocol %d, daemon protocol %d", clientProtocol, proto.Version))
		return
	}
	c.SetDeadline(time.Time{})
	ctx := context.Background()
	switch req.Op {
	case proto.OpStatus:
		d.ctl.RLock()
		st, err := d.mgr.Status(ctx)
		d.ctl.RUnlock()
		st.Streams = d.streamList()
		reply(c, req, st, err)
	case proto.OpLogin:
		d.ctl.Lock()
		st, err := d.mgr.Login(ctx, req.AuthKey, clamp(req.TimeoutMs, defaultLoginTimeout, maxLoginTimeout))
		d.ctl.Unlock()
		reply(c, req, st, err)
	case proto.OpLogout:
		d.ctl.Lock()
		st, err := d.logout(ctx, req.Force)
		d.ctl.Unlock()
		reply(c, req, st, err)
	case proto.OpStop:
		d.ctl.Lock()
		err := d.checkStreams(req.Force)
		if err == nil {
			d.closeStreams()
		}
		d.ctl.Unlock()
		// Unlink the socket before answering, so a CLI that sees the reply
		// and reconnects can never reach this exiting daemon.
		if err == nil {
			d.shutdown("stop request")
		}
		reply(c, req, struct{}{}, err)
	case proto.OpDial:
		d.dial(ctx, c, br, req)
	default:
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "unknown op %q", req.Op))
	}
}

func (d *daemon) logout(ctx context.Context, force bool) (proto.Status, error) {
	if err := d.checkStreams(force); err != nil {
		return proto.Status{}, err
	}
	d.closeStreams()
	return d.mgr.Logout(ctx, logoutControlTimeout)
}

// checkStreams refuses a disruptive request while streams are active unless
// the owner forced it, and lists the streams so the CLI can show them.
func (d *daemon) checkStreams(force bool) error {
	if force {
		return nil
	}
	if list := d.streamList(); len(list) > 0 {
		e := proto.Errorf(proto.CodeActiveStreams, "%d active stream(s); retry with force to close them", len(list))
		e.Streams = list
		return e
	}
	return nil
}

func (d *daemon) dial(ctx context.Context, c net.Conn, br *bufio.Reader, req proto.Request) {
	if req.Target == nil || req.Target.StableNodeID == "" {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "dial needs target.stableNodeID"))
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "port must be 1-65535"))
		return
	}
	if len(req.Label) > maxLabelBytes {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "label exceeds %d bytes", maxLabelBytes))
		return
	}
	want := req.Target.StableNodeID
	ctx, cancel := context.WithTimeout(ctx, clamp(req.TimeoutMs, defaultDialTimeout, maxDialTimeout))
	defer cancel()

	d.ctl.RLock()
	peerConn, info, err := d.openPeer(ctx, want, req.Port)
	var s *stream
	if err == nil {
		s, err = d.register(c, peerConn, want, req.Port, req.Label)
		if err != nil {
			peerConn.Close()
		}
	}
	d.ctl.RUnlock()
	if err != nil {
		writeErr(c, req, err)
		return
	}
	defer d.unregister(s.info.ID)
	if proto.WriteFrame(c, proto.Succeed(req, proto.DialResult{StreamID: s.info.ID, Peer: info})) != nil {
		peerConn.Close()
		return
	}
	d.cfg.Logf("dial: stream %s opened to %s port %d", s.info.ID, want, req.Port)
	pipe.Join(c, br, peerConn)
	d.cfg.Logf("dial: stream %s closed", s.info.ID)
}

// openPeer connects to the peer with stable ID want. The address comes from
// the netmap entry for that ID, never from DNS, and the connection is kept
// only if WhoIs on its remote address reports the same stable ID, so a node
// that took over the server's MagicDNS name cannot receive the stream.
func (d *daemon) openPeer(ctx context.Context, want string, port int) (net.Conn, proto.NodeInfo, error) {
	n, err := d.mgr.Running(ctx, time.Until(deadline(ctx)))
	if err != nil {
		return nil, proto.NodeInfo{}, err
	}
	return openVerified(ctx, n, want, port)
}

// openVerified dials stable node ID want on port over n and verifies the
// remote end with WhoIs.
func openVerified(ctx context.Context, n node.Node, want string, port int) (net.Conn, proto.NodeInfo, error) {
	var (
		info proto.NodeInfo
		ip   string
		err  error
	)
	// Right after a node comes up its netmap may still be filling in.
	lookupCtx, cancel := context.WithTimeout(ctx, peerLookupWindow)
	defer cancel()
	for {
		info, ip, err = n.LookupPeer(lookupCtx, want)
		if !errors.Is(err, node.ErrPeerNotFound) {
			break
		}
		select {
		case <-time.After(200 * time.Millisecond):
			continue
		case <-lookupCtx.Done():
		}
		break
	}
	if errors.Is(err, node.ErrPeerNotFound) {
		return nil, info, proto.Errorf(proto.CodePeerNotFound, "no peer with stable node ID %s is visible", want)
	}
	if err != nil {
		return nil, info, proto.Errorf(proto.CodeNodeUnavailable, "%v", err)
	}
	conn, err := n.Dial(ctx, net.JoinHostPort(ip, strconv.Itoa(port)))
	if err != nil {
		return nil, info, proto.Errorf(proto.CodeDialFailed, "%v", err)
	}
	who, err := n.WhoIs(ctx, conn.RemoteAddr().String())
	if err != nil {
		conn.Close()
		return nil, info, proto.Errorf(proto.CodePeerMismatch, "cannot verify the peer: %v", err)
	}
	if who.StableNodeID != want {
		conn.Close()
		return nil, info, proto.Errorf(proto.CodePeerMismatch,
			"connected peer is %s, not %s", who.StableNodeID, want)
	}
	return conn, who, nil
}

func (d *daemon) register(local, peer net.Conn, target string, port int, label string) (*stream, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closing {
		return nil, proto.Errorf(proto.CodeShuttingDown, "daemon is shutting down")
	}
	if len(d.streams) >= maxStreams {
		return nil, proto.Errorf(proto.CodeTooManyStreams, "%d streams are open", len(d.streams))
	}
	d.nextID++
	s := &stream{
		info: proto.StreamInfo{
			ID:           "s" + strconv.FormatUint(d.nextID, 10),
			StableNodeID: target,
			Port:         port,
			Label:        label,
			StartedAt:    time.Now().UTC().Format(time.RFC3339),
		},
		local: local,
		peer:  peer,
	}
	d.streams[s.info.ID] = s
	return s, nil
}

func (d *daemon) unregister(id string) {
	d.mu.Lock()
	delete(d.streams, id)
	d.mu.Unlock()
}

func (d *daemon) closeStreams() {
	d.mu.Lock()
	list := make([]*stream, 0, len(d.streams))
	for _, s := range d.streams {
		list = append(list, s)
	}
	d.mu.Unlock()
	for _, s := range list {
		s.local.Close()
		s.peer.Close()
	}
}

func (d *daemon) streamList() []proto.StreamInfo {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]proto.StreamInfo, 0, len(d.streams))
	for _, s := range d.streams {
		out = append(out, s.info)
	}
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.ParseUint(out[i].ID[1:], 10, 64)
		b, _ := strconv.ParseUint(out[j].ID[1:], 10, 64)
		return a < b
	})
	return out
}

func reply(c net.Conn, req proto.Request, result any, err error) {
	if err != nil {
		writeErr(c, req, err)
		return
	}
	proto.WriteFrame(c, proto.Succeed(req, result))
}

func writeErr(c net.Conn, req proto.Request, err error) {
	if errors.Is(err, proto.ErrFrameTooLarge) {
		err = proto.Errorf(proto.CodeBadRequest, "frame exceeds %d bytes", proto.MaxFrameBytes)
	}
	proto.WriteFrame(c, proto.Fail(req, err))
}

func clamp(ms int, def, maxD time.Duration) time.Duration {
	if ms <= 0 {
		return def
	}
	return min(time.Duration(ms)*time.Millisecond, maxD)
}

func deadline(ctx context.Context) time.Time {
	t, _ := ctx.Deadline()
	return t
}
