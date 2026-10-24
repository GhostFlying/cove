package mobile

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fakenode"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"github.com/coder/websocket"
)

func fixture(t *testing.T, dial func() (net.Conn, error), who string) (*Client, *Entry, *fakenode.Node) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("fake persisted enrollment"), 0600); err != nil {
		t.Fatal(err)
	}
	n := &fakenode.Node{State: proto.StateRunning, Self: proto.NodeInfo{StableNodeID: "client"}, Peers: map[string]fakenode.Peer{
		"server": {IP: "100.64.0.10", Dial: dial, WhoIs: who},
	}}
	mgr := node.NewManager(node.Config{StateDir: dir, Hostname: "fixture"}, func(node.Config, string) (node.Node, error) { return n, nil })
	mgr.Boot()
	c := newClient(mgr)
	t.Cleanup(c.Close)
	entry, err := c.OpenEntry("server", 8123)
	if err != nil {
		t.Fatal(err)
	}
	return c, entry, n
}

func httpFixture(t *testing.T, handler http.HandlerFunc) (*Client, *Entry) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	c, entry, _ := fixture(t, func() (net.Conn, error) { return net.DialTimeout("tcp", u.Host, time.Second) }, "server")
	return c, entry
}

func next(t *testing.T, c *Client) event {
	t.Helper()
	raw, err := c.NextEvent(3000)
	if err != nil || raw == "" {
		t.Fatalf("next event: %q, %v", raw, err)
	}
	var ev event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatal(err)
	}
	return ev
}

func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("fixture did not reach barrier")
	}
}

func TestPeerMismatchSendsZeroHTTPBytes(t *testing.T) {
	read := make(chan []byte, 1)
	c, e, _ := fixture(t, func() (net.Conn, error) {
		client, server := net.Pipe()
		go func() { defer server.Close(); data, _ := io.ReadAll(server); read <- data }()
		return client, nil
	}, "other-server")
	if err := e.Post(1, "/pair", `{"Authorization":"must-not-leak"}`, []byte("invitation-secret"), 4096); err != nil {
		t.Fatal(err)
	}
	ev := next(t, c)
	if ev.Type != "http-failure" || ev.Disposition != notSent {
		t.Fatalf("mismatch result %+v", ev)
	}
	select {
	case data := <-read:
		if len(data) != 0 {
			t.Fatalf("sent %d bytes before peer verification", len(data))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("mismatched connection was not closed")
	}
}

func TestHTTPResponseAndStreamingLimit(t *testing.T) {
	for _, size := range []int{16, 17} {
		t.Run(string(rune('A'+size)), func(t *testing.T) {
			c, e := httpFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/rpc" || r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("lost request contract")
				}
				w.Header().Set("X-Fixture", "bounded")
				w.Write([]byte(strings.Repeat("x", size)))
			})
			if err := e.Post(1, "/rpc", `{"Authorization":"Bearer fixture"}`, []byte("{}"), 16); err != nil {
				t.Fatal(err)
			}
			ev := next(t, c)
			if ev.Disposition != handedOff {
				t.Fatalf("response disposition %+v", ev)
			}
			if size == 16 {
				if ev.Type != "http-response" || len(ev.Body) != 16 || ev.Headers["x-fixture"] != "bounded" {
					t.Fatalf("response %+v", ev)
				}
			} else if ev.Type != "http-failure" || ev.Reason != "response-too-large" {
				t.Fatalf("oversized response %+v", ev)
			}
		})
	}
}

func TestHTTPCancelBeforeWriteAndAfterRequest(t *testing.T) {
	t.Run("before-write", func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		var bytesRead atomic.Int64
		c, e, n := fixture(t, func() (net.Conn, error) {
			client, server := net.Pipe()
			go func() { defer server.Close(); data, _ := io.ReadAll(server); bytesRead.Add(int64(len(data))) }()
			return client, nil
		}, "server")
		n.OnLookup = func() { close(entered); <-release }
		if err := e.Post(1, "/rpc", `{}`, []byte("{}"), 16); err != nil {
			t.Fatal(err)
		}
		waitSignal(t, entered)
		if got := c.Cancel(1); got != notSent {
			t.Fatalf("before-write cancellation: %s", got)
		}
		close(release)
		if ev := next(t, c); ev.Type != "http-failure" || ev.Disposition != notSent {
			t.Fatalf("cancel result %+v", ev)
		}
		c.Close()
		if bytesRead.Load() != 0 {
			t.Fatal("not-sent cancellation later wrote bytes")
		}
	})
	t.Run("after-request", func(t *testing.T) {
		seen, finished := make(chan struct{}), make(chan struct{})
		c, e := httpFixture(t, func(w http.ResponseWriter, r *http.Request) {
			io.Copy(io.Discard, r.Body)
			close(seen)
			<-r.Context().Done()
			close(finished)
		})
		if err := e.Post(1, "/rpc", `{}`, []byte("{}"), 16); err != nil {
			t.Fatal(err)
		}
		waitSignal(t, seen)
		if got := c.Cancel(1); got != unknown {
			t.Fatalf("request may have executed: %s", got)
		}
		if ev := next(t, c); ev.Disposition != unknown {
			t.Fatalf("cancel result %+v", ev)
		}
		waitSignal(t, finished)
	})
}

func TestHTTPDoesNotFollowRedirect(t *testing.T) {
	var otherRequests atomic.Int64
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { otherRequests.Add(1) }))
	defer other.Close()
	c, e := httpFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	})
	if err := e.Post(1, "/rpc", `{}`, nil, 4096); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, c); ev.Status != http.StatusTemporaryRedirect || otherRequests.Load() != 0 {
		t.Fatalf("redirect escaped verified entry: %+v", ev)
	}
}

func TestSocketBinaryTextAndRepeatedSend(t *testing.T) {
	c, e := httpFixture(t, func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for i := 0; i < 2; i++ {
			kind, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if err := conn.Write(r.Context(), kind, data); err != nil {
				return
			}
		}
		conn.Read(r.Context())
	})
	if err := e.OpenSocket(1, "/terminal"); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, c); ev.Type != "socket-open" {
		t.Fatalf("open %+v", ev)
	}
	for _, binary := range []bool{true, false} {
		body := []byte{0, 1, 127, 255}
		kind := "socket-binary"
		if !binary {
			body = []byte("你好")
			kind = "socket-text"
		}
		if got := c.Send(1, binary, body); got != handedOff {
			t.Fatalf("send admission %s", got)
		}
		ev := next(t, c)
		if ev.Type != kind || string(ev.Body) != string(body) {
			t.Fatalf("message %+v", ev)
		}
	}
	c.Cancel(1)
	if ev := next(t, c); ev.Type != "socket-close" {
		t.Fatalf("close %+v", ev)
	}
	if got := c.Send(1, true, []byte("late")); got != notSent {
		t.Fatalf("closed send %s", got)
	}
}

func TestAdmissionAndQueueBounds(t *testing.T) {
	c, e, _ := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	op, err := e.admit(1, true)
	if err != nil {
		t.Fatal(err)
	}
	defer c.wg.Done()
	c.mark(op, handedOff)
	payload := make([]byte, maxSocketMessageBytes)
	accepted := 0
	for c.Send(1, true, payload) == handedOff {
		accepted++
	}
	if accepted != maxSocketQueuedBytes/len(payload) {
		t.Fatalf("unbounded send queue: %d", accepted)
	}
	if got := c.Send(1, true, make([]byte, maxSocketMessageBytes+1)); got != notSent {
		t.Fatal("oversized send admitted")
	}
	if got := c.Send(1, false, []byte{255}); got != notSent {
		t.Fatal("invalid UTF-8 text admitted")
	}
	c.Cancel(1)
	c.finish(op, event{ID: 1, Type: "socket-close"})
	c.Release(1)
	if _, err := e.admit(1, false); err == nil {
		t.Fatal("released ID reused across asynchronous callbacks")
	}
	if err := e.Post(2, "/outside", `{}`, nil, 16); err == nil {
		t.Fatal("non-protocol route admitted")
	}
}

func TestSinglePullAndCloseWakeup(t *testing.T) {
	c, _, _ := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	done := make(chan error, 1)
	go func() { _, err := c.NextEvent(30000); done <- err }()
	deadline := time.After(3 * time.Second)
	for {
		c.mu.Lock()
		pulling := c.pulling
		c.mu.Unlock()
		if pulling {
			break
		}
		select {
		case <-deadline:
			t.Fatal("pull did not start")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if _, err := c.NextEvent(1); err == nil {
		t.Fatal("second consumer admitted")
	}
	c.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed pull reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not wake pull")
	}
}

func TestEventProducerBackpressureAndClose(t *testing.T) {
	c, _, _ := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	for i := 0; i < maxEvents; i++ {
		c.emit(event{ID: int64(i + 1), Type: "fixture"})
	}
	done := make(chan struct{})
	go func() { c.emit(event{ID: 1000, Type: "fixture"}); close(done) }()
	select {
	case <-done:
		t.Fatal("count-full queue did not backpressure")
	case <-time.After(10 * time.Millisecond):
	}
	c.mu.Lock()
	if len(c.events) != maxEvents || c.eventBytes > maxEventBytes {
		t.Error("native event bounds violated")
	}
	c.mu.Unlock()
	next(t, c)
	waitSignal(t, done)
	c.Close()
}

func TestLogoutInvalidatesEntriesAndReportsLoggedOut(t *testing.T) {
	c, e, _ := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	if _, err := c.Logout(); err != nil {
		t.Fatal(err)
	}
	if err := e.Post(1, "/rpc", `{}`, nil, 16); err == nil {
		t.Fatal("entry survived node logout generation")
	}
	raw, err := c.StatusJSON()
	if err != nil {
		t.Fatal(err)
	}
	var status proto.Status
	if err := json.Unmarshal([]byte(raw), &status); err != nil || status.State != proto.StateLoggedOut {
		t.Fatalf("logout status %q, %v", raw, err)
	}
}

func TestStopCancelsAnInFlightLoginAndPull(t *testing.T) {
	c, _, n := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	n.SetState(proto.StateNeedsLogin)
	n.BlockReauth = true
	entered := make(chan struct{})
	n.OnReauth = func() { close(entered) }
	loginDone := make(chan error, 1)
	go func() { _, err := c.Login("test-fixture-key"); loginDone <- err }()
	waitSignal(t, entered)
	c.Stop()
	if _, err := c.OpenEntry("server", 8123); err == nil {
		t.Fatal("stop left admission open")
	}
	select {
	case err := <-loginDone:
		if err == nil {
			t.Fatal("interrupted login reported success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stop did not cancel login")
	}
	c.Close()
	if _, err := c.NextEvent(1); err == nil {
		t.Fatal("stopped client still admitted a pull")
	}
}

func TestEventByteBudgetBackpressuresBeforeCountBudget(t *testing.T) {
	c, _, _ := fixture(t, func() (net.Conn, error) { return nil, context.Canceled }, "server")
	ev := event{ID: 1, Type: "http-response", Body: make([]byte, maxHTTPBytes)}
	encoded, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	count := maxEventBytes / len(encoded)
	if count >= maxEvents {
		t.Fatal("fixture does not exercise byte bound independently")
	}
	for i := 0; i < count; i++ {
		c.emit(ev)
	}
	done := make(chan struct{})
	go func() { c.emit(ev); close(done) }()
	select {
	case <-done:
		t.Fatal("byte-full event queue grew without bound")
	case <-time.After(10 * time.Millisecond):
	}
	next(t, c)
	waitSignal(t, done)
	c.mu.Lock()
	if c.eventBytes > maxEventBytes {
		t.Error("serialized byte bound violated")
	}
	c.mu.Unlock()
}

func TestFreshClientOwnershipSurvivesLogoutUntilActualClose(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cove-native-node")
	c, err := New(dir, "fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if _, err := c.Logout(); err != nil {
		t.Fatal(err)
	}
	other, err := New(dir, "other", "")
	if err == nil {
		other.Close()
		t.Fatal("second native owner opened state after logout")
	}
	c.Close()
	other, err = New(dir, "successor", "")
	if err != nil {
		t.Fatalf("closed owner retained lock: %v", err)
	}
	other.Close()
}

func TestControlBindingPreservesEnrollmentAcrossNormalRestartAndSelection(t *testing.T) {
	root := t.TempDir()
	first := "http://127.0.0.1:8123"
	second := "http://127.0.0.1:8124"
	if err := bindControl(root, first); err != nil {
		t.Fatal(err)
	}
	// With no enrollment there is nothing to migrate, and an explicit selection
	// may be changed before Login. Once Login writes state it becomes fixed.
	if err := bindControl(root, second); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	stateFile := filepath.Join(state, "tailscaled.state")
	enrollment := []byte("isolated enrollment fixture")
	if err := os.WriteFile(stateFile, enrollment, 0600); err != nil {
		t.Fatal(err)
	}
	if err := bindControl(root, second); err != nil {
		t.Fatalf("same selection could not restart: %v", err)
	}
	for _, changed := range []string{first, ""} {
		if _, err := New(root, "fixture", changed); err == nil || !strings.Contains(err.Error(), "original control URL") {
			t.Fatalf("changed control restored enrollment: %v", err)
		}
		// Failed construction must release its lock without touching node state.
		if err := bindControl(root, second); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(stateFile)
		if err != nil || string(got) != string(enrollment) {
			t.Fatalf("rejected restore changed enrollment: %q, %v", got, err)
		}
	}
	if err := os.Remove(filepath.Join(root, "control.binding")); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root, "fixture", second); err == nil || !strings.Contains(err.Error(), "original control URL") {
		t.Fatalf("missing binding restored enrollment: %v", err)
	}
	if err := os.RemoveAll(state); err != nil {
		t.Fatal(err)
	}
	// Logout's completed local removal allows choosing a different test plane.
	c, err := New(root, "after-logout", first)
	if err != nil {
		t.Fatalf("logout retained a control selection or failed-open lock: %v", err)
	}
	c.Close()
}
