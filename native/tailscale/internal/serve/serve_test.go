package serve

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fakenode"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "cst")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

// responses decodes every frame written so far.
func (b *syncBuffer) responses(t *testing.T) []proto.Response {
	t.Helper()
	b.mu.Lock()
	data := b.b.String()
	b.mu.Unlock()
	var out []proto.Response
	for _, line := range strings.Split(strings.TrimSpace(data), "\n") {
		if line == "" {
			continue
		}
		var r proto.Response
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("output frame %q: %v", line, err)
		}
		out = append(out, r)
	}
	return out
}

func (b *syncBuffer) waitFor(t *testing.T, id string) proto.Response {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, r := range b.responses(t) {
			if r.ID == id {
				return r
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no response %q", id)
	return proto.Response{}
}

func line(req proto.Request) string {
	b, _ := json.Marshal(req)
	return string(b) + "\n"
}

var hello = line(proto.Request{ID: "h", Op: proto.OpHello, Protocol: proto.Version})

type helper struct {
	in   *io.PipeWriter
	out  *syncBuffer
	done chan error
	fwd  net.Listener
	tail net.Listener // the fake node's listener for the one port
}

// startHelper runs serve mode on a fake node whose tailnet listener is a
// loopback TCP listener, forwarding to a Unix listener the test owns.
func startHelper(t *testing.T, fn *fakenode.Node, cfg Config) *helper {
	t.Helper()
	root := shortDir(t)
	if err := os.Mkdir(filepath.Join(root, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	h := &helper{out: &syncBuffer{}, done: make(chan error, 1)}
	sock := filepath.Join(root, "run", "fwd.sock")
	var err error
	if h.fwd, err = net.Listen("unix", sock); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.fwd.Close() })
	if h.tail, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.tail.Close() })
	if fn.ListenFn == nil {
		fn.ListenFn = func(int) (net.Listener, error) { return h.tail, nil }
	}
	var in io.Reader
	in, h.in = io.Pipe()
	if cfg.Home == "" {
		cfg.Home = filepath.Join(root, "tsnet")
	}
	cfg.ForwardSocket = sock
	cfg.Build = "0.0.0-unit"
	cfg.Start = func(node.Config, string) (node.Node, error) { return fn, nil }
	cfg.In = in
	cfg.Out = h.out
	go func() { h.done <- Run(context.Background(), cfg) }()
	t.Cleanup(func() {
		h.in.Close()
		h.wait(t, 20*time.Second)
	})
	return h
}

func (h *helper) send(t *testing.T, s string) {
	t.Helper()
	go h.in.Write([]byte(s))
}

func (h *helper) wait(t *testing.T, within time.Duration) error {
	t.Helper()
	select {
	case err := <-h.done:
		h.done <- err
		return err
	case <-time.After(within):
		t.Fatalf("Run did not return within %v", within)
		return nil
	}
}

// A connection the Cove server rejects (closes at once) must release its
// unit of the budget even if the tailnet peer never sends or closes: the
// budget is 2, and many more such connections are forwarded in turn.
func TestRejectedSilentConnectionsDoNotExhaustTheBudget(t *testing.T) {
	fn := &fakenode.Node{State: proto.StateRunning,
		WhoIsAddr: func(string) (proto.NodeInfo, error) { return proto.NodeInfo{StableNodeID: "nPeer"}, nil }}
	h := startHelper(t, fn, Config{MaxConns: 2, ForwardGrace: 100 * time.Millisecond})
	h.send(t, hello+line(proto.Request{ID: "l", Op: proto.OpLogin, AuthKey: "tskey-test-0000"})+
		line(proto.Request{ID: "p", Op: proto.OpSetPorts, Ports: []int{7001}}))
	if r := h.out.waitFor(t, "p"); !r.OK {
		t.Fatalf("setPorts: %+v", r.Error)
	}

	accepted := make(chan string)
	go func() {
		for {
			c, err := h.fwd.Accept()
			if err != nil {
				return
			}
			hdr, _ := bufio.NewReader(c).ReadString('\n')
			c.Close() // reject: no device token, say
			accepted <- hdr
		}
	}()
	for i := range 6 {
		peer, err := net.Dial("tcp", h.tail.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer peer.Close() // never closed or written before the end of the test
		select {
		case hdr := <-accepted:
			if !strings.Contains(hdr, "nPeer") {
				t.Fatalf("header %q", hdr)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("connection %d was not forwarded: the budget leaked", i)
		}
		// The peer sees its read side end once the server closed.
		peer.SetReadDeadline(time.Now().Add(5 * time.Second))
		if b, err := io.ReadAll(peer); err != nil || len(b) != 0 {
			t.Fatalf("peer read %q %v", b, err)
		}
		time.Sleep(300 * time.Millisecond) // past ForwardGrace
	}
}

func TestOversizedControlFrameEndsTheChannel(t *testing.T) {
	h := startHelper(t, &fakenode.Node{}, Config{})
	h.send(t, hello+`{"id":"big","op":"status","x":"`+strings.Repeat("a", proto.MaxFrameBytes)+`"}`+"\n"+
		line(proto.Request{ID: "after", Op: proto.OpStatus}))
	err := h.wait(t, 10*time.Second)
	if !errors.Is(err, ErrControlChannel) {
		t.Fatalf("Run returned %v", err)
	}
	var sawBad bool
	for _, r := range h.out.responses(t) {
		if r.ID == "after" {
			t.Fatal("a request after the oversized frame was processed")
		}
		if !r.OK && r.Error.Code == proto.CodeBadRequest {
			sawBad = true
		}
	}
	if !sawBad {
		t.Fatal("no BAD_REQUEST for the oversized frame")
	}
}

func TestTruncatedControlFrameIsAnError(t *testing.T) {
	h := startHelper(t, &fakenode.Node{}, Config{})
	go func() {
		h.in.Write([]byte(hello + `{"id":"cut","op":"sta`))
		h.in.Close()
	}()
	if err := h.wait(t, 10*time.Second); !errors.Is(err, ErrControlChannel) {
		t.Fatalf("Run returned %v", err)
	}
}

func TestCleanEOFIsNotAnError(t *testing.T) {
	h := startHelper(t, &fakenode.Node{}, Config{})
	go func() {
		h.in.Write([]byte(hello))
		h.in.Close()
	}()
	if err := h.wait(t, 10*time.Second); err != nil {
		t.Fatalf("Run returned %v", err)
	}
}

// stdin EOF while a login waits on the control plane cancels the login:
// the helper answers SHUTTING_DOWN and exits promptly.
func TestEOFCancelsABlockedLogin(t *testing.T) {
	h := startHelper(t, &fakenode.Node{State: proto.StateNeedsLogin, BlockWait: true}, Config{})
	h.send(t, hello+line(proto.Request{ID: "l", Op: proto.OpLogin, AuthKey: "tskey-test-0000", TimeoutMs: 300000}))
	h.out.waitFor(t, "h")
	time.Sleep(200 * time.Millisecond) // let the login block
	start := time.Now()
	h.in.Close()
	if err := h.wait(t, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("exit waited for the login")
	}
	if r := h.out.waitFor(t, "l"); r.OK || r.Error.Code != proto.CodeShuttingDown {
		t.Fatalf("login reply %+v", r)
	}
}
