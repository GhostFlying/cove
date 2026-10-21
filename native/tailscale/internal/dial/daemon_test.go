package dial

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fakenode"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// shortDir is a fresh directory with a path short enough for a Unix socket
// (t.TempDir is too long on macOS).
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "cdt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// bareDaemon is a daemon with a listener and no node, for exercising the
// admission and shutdown state machine directly.
func bareDaemon(t *testing.T) *daemon {
	t.Helper()
	sock := filepath.Join(shortDir(t), "s")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	d := &daemon{
		cfg:        Config{IdleTimeout: time.Minute, Logf: func(string, ...any) {}},
		ln:         ln,
		sock:       sock,
		mgr:        node.NewManager(node.Config{StateDir: filepath.Join(shortDir(t), "state")}, nil),
		lastActive: time.Now(),
		streams:    map[string]*stream{},
		waiting:    map[net.Conn]struct{}{},
		closed:     make(chan struct{}),
	}
	d.life, d.cancel = context.WithCancel(context.Background())
	return d
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

// The idle decision and admission are one critical section: an admitted
// connection always prevents the idle exit, and once the idle exit is
// decided nothing more is admitted.
func TestIdleExitAndAdmissionAreOrdered(t *testing.T) {
	d := bareDaemon(t)
	later := time.Now().Add(2 * time.Minute)
	if d.idleShutdown(time.Now()) {
		t.Fatal("idle exit before the idle timeout")
	}
	c, peer := net.Pipe()
	defer c.Close()
	defer peer.Close()
	if !d.admit(c) {
		t.Fatal("connection refused before shutdown")
	}
	if d.idleShutdown(later) {
		t.Fatal("idle exit with an admitted connection")
	}
	d.release(c)
	if d.idleShutdown(time.Now()) {
		t.Fatal("idle timer was not reset by the released connection")
	}
	if !d.idleShutdown(later) {
		t.Fatal("no idle exit after the idle timeout")
	}
	if d.admit(c) {
		t.Fatal("connection admitted after the idle exit")
	}
	select {
	case <-d.closed:
	default:
		t.Fatal("shutdown not finished")
	}
	if _, err := os.Stat(d.sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("socket not unlinked")
	}
	if d.idleShutdown(later) {
		t.Fatal("second shutdown transition")
	}
}

// Once a stop succeeded, a stream setup or a lifecycle request that was
// queued behind it is refused instead of acting on an exiting daemon.
func TestRequestsAfterStopAreRefused(t *testing.T) {
	d := bareDaemon(t)
	if err := d.stop(false); err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_, err := d.register(a, b, "nServer", 7001, "")
	wantCode(t, err, proto.CodeShuttingDown)
	wantCode(t, d.stop(false), proto.CodeShuttingDown)
	_, err = d.status(d.life)
	wantCode(t, err, proto.CodeShuttingDown)
	_, err = d.login(d.life, proto.Request{AuthKey: "tskey-test-0000"})
	wantCode(t, err, proto.CodeShuttingDown)
	_, err = d.logout(d.life, true)
	wantCode(t, err, proto.CodeShuttingDown)
	if d.life.Err() == nil {
		t.Fatal("lifetime context not cancelled")
	}
}

func TestStopWithStreamsNeedsForce(t *testing.T) {
	d := bareDaemon(t)
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, err := d.register(a, b, "nServer", 7001, "x"); err != nil {
		t.Fatal(err)
	}
	wantCode(t, d.stop(false), proto.CodeActiveStreams)
	if d.isClosing() {
		t.Fatal("refused stop began shutdown")
	}
	if err := d.stop(true); err != nil {
		t.Fatal(err)
	}
}

// running is an in-process daemon backed by a fake node.
type running struct {
	sock string
	node *fakenode.Node
	done chan error
	stop context.CancelFunc
}

func startDaemon(t *testing.T, fn *fakenode.Node, enrolled bool) *running {
	t.Helper()
	home := shortDir(t)
	if enrolled {
		state := filepath.Join(home, "state")
		if err := os.Mkdir(state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(state, "tailscaled.state"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{node: fn, done: make(chan error, 1), stop: cancel}
	_, r.sock = Paths(home)
	go func() {
		r.done <- Run(ctx, Config{
			Home:        home,
			IdleTimeout: time.Minute,
			Build:       "0.0.0-unit",
			Start:       func(node.Config, string) (node.Node, error) { return fn, nil },
		})
	}()
	t.Cleanup(func() {
		cancel()
		r.wait(t, 20*time.Second)
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if c, err := net.Dial("unix", r.sock); err == nil {
			c.Close()
			return r
		}
		if time.Now().After(deadline) {
			t.Fatal("daemon socket never appeared")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (r *running) wait(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case err := <-r.done:
		if err != nil {
			t.Error(err)
		}
		r.done <- nil
	case <-time.After(within):
		t.Fatalf("Run did not return within %v", within)
	}
}

type client struct {
	c  net.Conn
	br *bufio.Reader
}

// open connects and sends hello, plus raw bytes coalesced into the same
// write when extra is set.
func open(t *testing.T, sock string, extra ...[]byte) *client {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	frame, _ := json.Marshal(proto.Request{ID: "h", Op: proto.OpHello, Protocol: proto.Version})
	buf := append(frame, '\n')
	for _, e := range extra {
		buf = append(buf, e...)
	}
	if _, err := c.Write(buf); err != nil {
		t.Fatal(err)
	}
	cl := &client{c: c, br: bufio.NewReader(c)}
	if resp := cl.read(t); !resp.OK {
		t.Fatalf("hello: %+v", resp.Error)
	}
	return cl
}

func (cl *client) read(t *testing.T) proto.Response {
	t.Helper()
	cl.c.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := proto.ReadFrame(cl.br, proto.MaxFrameBytes)
	if err != nil {
		t.Fatalf("reading a response: %v", err)
	}
	var resp proto.Response
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func frame(req proto.Request) []byte {
	b, _ := json.Marshal(req)
	return append(b, '\n')
}

// The stop reply is written before Run returns, so the process cannot exit
// first: the reply is already readable when Run has returned.
func TestStopReplyIsWrittenBeforeRunReturns(t *testing.T) {
	for i := range 20 {
		r := startDaemon(t, &fakenode.Node{State: proto.StateRunning}, true)
		cl := open(t, r.sock, frame(proto.Request{ID: "s", Op: proto.OpStop}))
		r.wait(t, 20*time.Second)
		cl.c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		line, err := proto.ReadFrame(cl.br, proto.MaxFrameBytes)
		var resp proto.Response
		if err != nil || json.Unmarshal(line, &resp) != nil || !resp.OK || resp.ID != "s" {
			t.Fatalf("round %d: stop reply %q: %v", i, line, err)
		}
	}
}

// A client that sent only hello and keeps its connection open does not hold
// up the exit until its handshake timeout: shutdown wakes its handler.
func TestStopDoesNotWaitForIdleConnections(t *testing.T) {
	r := startDaemon(t, &fakenode.Node{State: proto.StateRunning}, true)
	idle := open(t, r.sock)
	start := time.Now()
	open(t, r.sock, frame(proto.Request{ID: "s", Op: proto.OpStop}))
	r.wait(t, handshakeTimeout/2)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("stop took %v", elapsed)
	}
	if resp := idle.read(t); resp.OK || resp.Error.Code != proto.CodeShuttingDown {
		t.Fatalf("idle connection got %+v", resp)
	}
}

// Shutdown cancels a login blocked on the control plane: the client gets
// SHUTTING_DOWN and Run returns promptly.
func TestShutdownCancelsABlockedLogin(t *testing.T) {
	r := startDaemon(t, &fakenode.Node{State: proto.StateNeedsLogin, BlockWait: true}, false)
	cl := open(t, r.sock, frame(proto.Request{ID: "l", Op: proto.OpLogin, AuthKey: "tskey-test-0000", TimeoutMs: 300000}))
	time.Sleep(200 * time.Millisecond) // let the login block
	start := time.Now()
	r.stop()
	if resp := cl.read(t); resp.OK || resp.Error.Code != proto.CodeShuttingDown {
		t.Fatalf("login reply: %+v", resp)
	}
	r.wait(t, 5*time.Second)
	if time.Since(start) > 5*time.Second {
		t.Fatal("shutdown waited for the login")
	}
}

// peerServer is a tailnet peer stand-in that records what it received.
func peerServer(t *testing.T) (net.Listener, chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.SetReadDeadline(time.Now().Add(10 * time.Second))
		b, _ := io.ReadAll(c)
		got <- b
	}()
	return ln, got
}

// Payload bytes coalesced with the dial frame reach the peer only after it
// is verified: a peer whose WhoIs is another node gets none of them.
func TestCoalescedPayloadIsForwardedOnlyToAVerifiedPeer(t *testing.T) {
	for _, c := range []struct {
		whoIs string
		ok    bool
	}{{"nServer", true}, {"nImpostor", false}} {
		ln, got := peerServer(t)
		fn := &fakenode.Node{State: proto.StateRunning, Peers: map[string]fakenode.Peer{
			"nServer": {
				IP:    "127.0.0.1",
				Dial:  func() (net.Conn, error) { return net.Dial("tcp", ln.Addr().String()) },
				WhoIs: c.whoIs,
			},
		}}
		r := startDaemon(t, fn, true)
		dialReq := frame(proto.Request{ID: "d", Op: proto.OpDial, Target: &proto.Target{StableNodeID: "nServer"},
			Port: ln.Addr().(*net.TCPAddr).Port})
		cl := open(t, r.sock, dialReq, []byte("early payload"))
		resp := cl.read(t)
		if c.ok {
			if !resp.OK {
				t.Fatalf("dial: %+v", resp.Error)
			}
			cl.c.(*net.UnixConn).CloseWrite()
		} else if resp.OK || resp.Error.Code != proto.CodePeerMismatch {
			t.Fatalf("dial to an impostor: %+v", resp)
		}
		select {
		case b := <-got:
			if want := map[bool]string{true: "early payload", false: ""}[c.ok]; string(b) != want {
				t.Fatalf("whoIs %s: peer received %q, want %q", c.whoIs, b, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("peer connection never ended")
		}
		r.stop()
	}
}
