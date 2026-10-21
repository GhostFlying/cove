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
//
// Shutdown is one transition, taken under mu: closing becomes true, after
// which no connection is admitted and no stream is registered. Every path
// into it (idle, stop, signal, listener failure) goes through beginShutdown,
// and the idle check and the transition happen in the same critical section
// as admission, so a connection is either admitted before the decision (and
// keeps the daemon alive) or refused after it (closed before any reply).
// After the transition the socket is unlinked and the lifetime context is
// cancelled, so in-flight handlers (a pending login, a dial waiting for the
// node) return; Run waits for all handlers, which lets a stop reply be
// written, before closing the node and releasing the lock.
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
	replyTimeout         = 5 * time.Second
	defaultDialTimeout   = 15 * time.Second
	maxDialTimeout       = 60 * time.Second
	defaultLoginTimeout  = 60 * time.Second
	maxLoginTimeout      = 5 * time.Minute
	logoutControlTimeout = 10 * time.Second
	peerLookupWindow     = 5 * time.Second
	// drainTimeout bounds how long Run waits for handlers after shutdown;
	// every handler is itself bounded by the lifetime context or a deadline.
	drainTimeout = 15 * time.Second
	maxConns     = 512
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

	// life is cancelled by the shutdown transition; every handler uses it.
	life   context.Context
	cancel context.CancelFunc

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
	handlers   sync.WaitGroup
	// waiting holds the connections whose request has not been read yet.
	waiting map[net.Conn]struct{}

	closed chan struct{} // closed once the shutdown transition finished
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
	if !proto.ValidBuild(cfg.Build) {
		return fmt.Errorf("invalid build identifier %q", cfg.Build)
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
	// gone and every handler has finished, so a new owner never finds a live
	// daemon behind a stale socket.
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
		waiting:    map[net.Conn]struct{}{},
		closed:     make(chan struct{}),
	}
	d.life, d.cancel = context.WithCancel(context.Background())
	defer d.cancel()
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
	case <-d.closed:
	}
	<-d.closed
	cfg.Pause("unlinked")
	d.closeStreams()
	if !waitTimeout(&d.handlers, drainTimeout) {
		cfg.Logf("dial: handlers still running after %v; closing anyway", drainTimeout)
	}
	d.ctl.Lock()
	d.mgr.Close()
	d.ctl.Unlock()
	cfg.Logf("dial: exited")
	return nil
}

// beginShutdown performs the closing transition; mu must be held. It
// reports whether this call made the transition.
func (d *daemon) beginShutdownLocked() bool {
	if d.closing {
		return false
	}
	d.closing = true
	return true
}

// finishShutdown runs after a successful transition: no new connection or
// stream can appear, so the socket is unlinked and in-flight work is
// cancelled. The lock stays held until Run returns.
func (d *daemon) finishShutdown(reason string) {
	d.ln.Close()
	os.Remove(d.sock)
	d.cancel()
	// Wake handlers still waiting for a request (for example a client that
	// sent only hello and kept the connection open); otherwise Run would
	// wait for their handshake timeout before exiting.
	d.mu.Lock()
	for c := range d.waiting {
		c.SetReadDeadline(time.Now())
	}
	d.mu.Unlock()
	d.cfg.Logf("dial: shutting down (%s)", reason)
	close(d.closed)
}

func (d *daemon) shutdown(reason string) {
	d.mu.Lock()
	began := d.beginShutdownLocked()
	d.mu.Unlock()
	if began {
		d.finishShutdown(reason)
	}
}

func (d *daemon) isClosing() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closing
}

// admit counts a new connection unless the daemon is closing or full. The
// connection is waiting for its request until requestRead; the caller sets
// its handshake deadline before admit, so a shutdown that shortens the
// deadline afterwards is never overridden.
func (d *daemon) admit(c net.Conn) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closing || d.conns >= maxConns {
		return false
	}
	d.conns++
	d.waiting[c] = struct{}{}
	d.handlers.Add(1)
	return true
}

// requestRead ends the waiting phase of c; from here on the handler is
// cancelled through the lifetime context or by closing its stream.
func (d *daemon) requestRead(c net.Conn) {
	d.mu.Lock()
	delete(d.waiting, c)
	d.mu.Unlock()
}

func (d *daemon) release(c net.Conn) {
	d.mu.Lock()
	delete(d.waiting, c)
	d.conns--
	d.lastActive = time.Now()
	d.mu.Unlock()
	d.handlers.Done()
}

// idleShutdown makes the idle decision and the closing transition in one
// critical section with admit, so no admitted connection is ever cut off by
// an idle exit.
func (d *daemon) idleShutdown(now time.Time) bool {
	d.mu.Lock()
	began := d.conns == 0 && now.Sub(d.lastActive) >= d.cfg.IdleTimeout && d.beginShutdownLocked()
	d.mu.Unlock()
	if began {
		d.finishShutdown("idle")
	}
	return began
}

func (d *daemon) acceptLoop() {
	for {
		c, err := d.ln.Accept()
		if err != nil {
			d.shutdown("listener closed")
			return
		}
		c.SetDeadline(time.Now().Add(handshakeTimeout))
		if !d.admit(c) {
			c.Close()
			continue
		}
		go func() {
			defer d.release(c)
			d.handle(c)
		}()
	}
}

// idleLoop exits the daemon after IdleTimeout with no connection at all:
// an open stream or an in-flight control request keeps it alive.
func (d *daemon) idleLoop() {
	period := min(max(d.cfg.IdleTimeout/10, 50*time.Millisecond), time.Second)
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-d.closed:
			return
		case now := <-t.C:
			if d.idleShutdown(now) {
				return
			}
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

var errShuttingDown = proto.Errorf(proto.CodeShuttingDown, "daemon is shutting down")

// readError reports a failed request read. A read cut short by shutdown
// (finishShutdown expires the read deadline) is SHUTTING_DOWN rather than
// an I/O error.
func (d *daemon) readError(err error) error {
	var pe *proto.Error
	if !errors.As(err, &pe) && d.isClosing() {
		return errShuttingDown
	}
	return err
}

func (d *daemon) handle(c net.Conn) {
	defer c.Close()
	// The handshake deadline was set before admit.
	br := bufio.NewReader(c)
	req, err := proto.ReadRequest(br)
	if err != nil {
		writeErr(c, req, d.readError(err))
		return
	}
	if req.Op != proto.OpHello {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "the first request must be hello"))
		return
	}
	clientProtocol := req.Protocol
	if proto.WriteResponse(c, proto.Succeed(req, d.hello())) != nil {
		return
	}
	req, err = proto.ReadRequest(br)
	d.requestRead(c)
	if err != nil {
		// A client that only wanted the hello simply closes.
		if !errors.Is(err, io.EOF) {
			writeErr(c, req, d.readError(err))
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
	ctx := d.life
	switch req.Op {
	case proto.OpStatus:
		// Without an identity hold status only reads, so it shares ctl with
		// dial setup. Settling a hold (node.Manager) changes the node, which
		// needs the write side; holds are placed only under it, so one seen
		// absent here cannot appear before the read side is released.
		d.ctl.RLock()
		held := d.mgr.Held()
		var st proto.Status
		var err error
		if !held {
			st, err = d.status(ctx)
		}
		d.ctl.RUnlock()
		if held {
			d.ctl.Lock()
			st, err = d.status(ctx)
			d.ctl.Unlock()
		}
		reply(c, req, st, err)
	case proto.OpLogin:
		d.ctl.Lock()
		st, err := d.login(ctx, req)
		d.ctl.Unlock()
		reply(c, req, st, err)
	case proto.OpLogout:
		d.ctl.Lock()
		st, err := d.logout(ctx, req.Force)
		d.ctl.Unlock()
		reply(c, req, st, err)
	case proto.OpStop:
		d.ctl.Lock()
		err := d.stop(req.Force)
		d.ctl.Unlock()
		// The socket is already unlinked, so a CLI that sees this reply and
		// reconnects can never reach this exiting daemon; Run waits for this
		// handler, so the reply is written before the process exits.
		reply(c, req, struct{}{}, err)
	case proto.OpDial:
		d.dial(ctx, c, br, req)
	default:
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "unknown op %q", req.Op))
	}
}

// The lifecycle operations run with ctl held for writing and re-check
// closing first: a request queued behind a stop must not act on a daemon
// that is exiting.

func (d *daemon) status(ctx context.Context) (proto.Status, error) {
	if d.isClosing() {
		return proto.Status{}, errShuttingDown
	}
	st, err := d.mgr.Status(ctx)
	st.Streams = d.streamList()
	return st, err
}

func (d *daemon) login(ctx context.Context, req proto.Request) (proto.Status, error) {
	if d.isClosing() {
		return proto.Status{}, errShuttingDown
	}
	return d.mgr.Login(ctx, req.AuthKey, proto.Timeout(req.TimeoutMs, defaultLoginTimeout, maxLoginTimeout))
}

func (d *daemon) logout(ctx context.Context, force bool) (proto.Status, error) {
	if d.isClosing() {
		return proto.Status{}, errShuttingDown
	}
	if err := d.checkStreams(force); err != nil {
		return proto.Status{}, err
	}
	d.closeStreams()
	return d.mgr.Logout(ctx, logoutControlTimeout)
}

// stop runs with ctl held for writing. The check, the closing transition
// and the unlink happen before ctl is released, so no stream can be
// registered between a successful check and the shutdown (register runs
// under the read side and refuses once closing).
func (d *daemon) stop(force bool) error {
	d.mu.Lock()
	if d.closing {
		d.mu.Unlock()
		return errShuttingDown
	}
	if !force && len(d.streams) > 0 {
		d.mu.Unlock()
		return d.activeStreamsError()
	}
	d.beginShutdownLocked()
	d.mu.Unlock()
	d.finishShutdown("stop request")
	d.closeStreams()
	return nil
}

// checkStreams refuses a disruptive request while streams are active unless
// the owner forced it, and lists the streams so the CLI can show them.
func (d *daemon) checkStreams(force bool) error {
	if force || len(d.streamList()) == 0 {
		return nil
	}
	return d.activeStreamsError()
}

func (d *daemon) activeStreamsError() error {
	list := d.streamList()
	e := proto.Errorf(proto.CodeActiveStreams, "%d active stream(s); retry with force to close them", len(list))
	e.Streams = list
	return e
}

func (d *daemon) dial(ctx context.Context, c net.Conn, br *bufio.Reader, req proto.Request) {
	if req.Target == nil || !proto.ValidNodeID(req.Target.StableNodeID) {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest,
			"dial needs target.stableNodeID of 1-%d letters and digits", proto.MaxNodeIDBytes))
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "port must be 1-65535"))
		return
	}
	if len(req.Label) > proto.MaxLabelBytes {
		writeErr(c, req, proto.Errorf(proto.CodeBadRequest, "label exceeds %d bytes", proto.MaxLabelBytes))
		return
	}
	want := req.Target.StableNodeID
	ctx, cancel := context.WithTimeout(ctx, proto.Timeout(req.TimeoutMs, defaultDialTimeout, maxDialTimeout))
	defer cancel()

	d.ctl.RLock()
	var (
		peerConn net.Conn
		info     proto.NodeInfo
		s        *stream
		err      error
	)
	if d.isClosing() {
		err = errShuttingDown
	} else {
		peerConn, info, err = d.openPeer(ctx, want, req.Port)
	}
	if err == nil {
		s, err = d.register(c, peerConn, want, req.Port, req.Label)
		if err != nil {
			peerConn.Close()
		}
	}
	d.ctl.RUnlock()
	if err != nil && d.life.Err() != nil {
		// Shutdown cancelled the setup, whatever step noticed it (waiting
		// for the node, the peer lookup, the dial or WhoIs). The request's
		// own timeout is a separate deadline on ctx and keeps its error.
		err = errShuttingDown
	}
	if err != nil {
		writeErr(c, req, err)
		return
	}
	defer d.unregister(s.info.ID)
	c.SetWriteDeadline(time.Now().Add(replyTimeout))
	if proto.WriteResponse(c, proto.Succeed(req, proto.DialResult{StreamID: s.info.ID, Peer: info})) != nil {
		peerConn.Close()
		return
	}
	c.SetWriteDeadline(time.Time{})
	d.cfg.Logf("dial: stream %s opened to %s port %d", s.info.ID, want, req.Port)
	// Bytes the CLI sent right after the dial frame are already buffered in
	// br; they are forwarded only now, after the peer was verified. The CLI
	// side is trusted, so its half-close is not time-bounded (grace 0).
	pipe.Join(c, br, peerConn, 0)
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
	// Right after a node comes up its netmap may still be filling in, so a
	// missing peer is retried for a short window. The window only decides
	// whether to retry; each lookup runs under the request's own context, so
	// the window closing during a lookup cannot turn "not found" into a
	// spurious node error.
	window := time.Now().Add(peerLookupWindow)
retry:
	for {
		info, ip, err = n.LookupPeer(ctx, want)
		if !errors.Is(err, node.ErrPeerNotFound) || time.Now().After(window) {
			break
		}
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			break retry
		}
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
			"connected peer is %s, not %s", proto.Truncate(who.StableNodeID), want)
	}
	return conn, who, nil
}

func (d *daemon) register(local, peer net.Conn, target string, port int, label string) (*stream, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closing {
		return nil, errShuttingDown
	}
	if len(d.streams) >= proto.MaxStreams {
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

// reply writes a result or error, bounded so a stalled client cannot keep a
// handler (and so Run) waiting.
func reply(c net.Conn, req proto.Request, result any, err error) {
	if err != nil {
		writeErr(c, req, err)
		return
	}
	c.SetWriteDeadline(time.Now().Add(replyTimeout))
	proto.WriteResponse(c, proto.Succeed(req, result))
}

func writeErr(c net.Conn, req proto.Request, err error) {
	c.SetWriteDeadline(time.Now().Add(replyTimeout))
	proto.WriteResponse(c, proto.Fail(req, err))
}

func deadline(ctx context.Context) time.Time {
	t, _ := ctx.Deadline()
	return t
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
