package serve

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/GhostFlying/cove/native/tailscale/internal/fakenode"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// tracker backs the fake node's Listen with real loopback listeners and
// counts how many are open.
type tracker struct{ n atomic.Int32 }

type trackedListener struct {
	net.Listener
	t    *tracker
	once atomic.Bool
}

func (l *trackedListener) Close() error {
	if l.once.CompareAndSwap(false, true) {
		l.t.n.Add(-1)
	}
	return l.Listener.Close()
}

func (t *tracker) listen(int) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	t.n.Add(1)
	return &trackedListener{Listener: ln, t: t}, nil
}

func (t *tracker) open() int32 { return t.n.Load() }

// enrolledHelper runs serve on an enrolled, Running node listening on
// port 7001, then lets its key expire (NeedsLogin), as before a reauth.
func enrolledHelper(t *testing.T, fn *fakenode.Node) (*helper, *tracker) {
	t.Helper()
	home := filepath.Join(shortDir(t), "tsnet")
	if err := os.MkdirAll(filepath.Join(home, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "state", "tailscaled.state"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := &tracker{}
	fn.ListenFn = tr.listen
	if fn.State == "" {
		fn.State = proto.StateRunning
	}
	fn.Self = proto.NodeInfo{StableNodeID: "nClient"}
	h := startHelper(t, fn, Config{Home: home})
	h.send(t, hello+line(proto.Request{ID: "p", Op: proto.OpSetPorts, Ports: []int{7001}}))
	if r := h.out.waitFor(t, "p"); !r.OK || tr.open() != 1 {
		t.Fatalf("setPorts: %+v, %d open", r.Error, tr.open())
	}
	return h, tr
}

func statusOf(t *testing.T, r proto.Response) proto.Status {
	t.Helper()
	if !r.OK {
		t.Fatalf("status failed: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Result)
	var st proto.Status
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// From the moment a reauth starts until its outcome is known and is the
// enrolled identity, serve accepts nothing; a status that confirms the
// identity reopens the listeners, and one that finds another identity
// keeps them closed.
func TestReauthKeepsListenersClosedUntilTheIdentityIsConfirmed(t *testing.T) {
	for _, c := range []struct {
		name      string
		set       func(*fakenode.Node)
		timeoutMs int
		// code is the login error ("" for success), hold the hold the next
		// status reports, open the listeners open after that status.
		code string
		hold string
		open int32
	}{
		{name: "same identity", set: func(*fakenode.Node) {}, open: 1},
		{name: "another identity", set: func(fn *fakenode.Node) { fn.ReauthAs = "nOther" },
			code: proto.CodeIdentityChanged, hold: proto.CodeIdentityChanged},
		{name: "timed out", set: func(fn *fakenode.Node) { fn.BlockReauth = true }, timeoutMs: 200,
			code: proto.CodeLoginUncertain, open: 1},
		{name: "timed out, then completed as another node", set: func(fn *fakenode.Node) { fn.BlockReauth, fn.LateAs = true, "nOther" },
			timeoutMs: 200, code: proto.CodeLoginUncertain, hold: proto.CodeIdentityChanged},
	} {
		t.Run(c.name, func(t *testing.T) {
			fn := &fakenode.Node{}
			h, tr := enrolledHelper(t, fn)
			fn.SetState(proto.StateNeedsLogin)
			openAtReauth := atomic.Int32{}
			openAtReauth.Store(-1)
			fn.OnReauth = func() { openAtReauth.Store(tr.open()) }
			c.set(fn)
			h.send(t, line(proto.Request{ID: "l", Op: proto.OpLogin, AuthKey: "tskey-test-0000", TimeoutMs: c.timeoutMs}))
			r := h.out.waitFor(t, "l")
			if (c.code == "") != r.OK || (c.code != "" && r.Error.Code != c.code) {
				t.Fatalf("login: %+v", r)
			}
			if openAtReauth.Load() != 0 {
				t.Fatalf("%d listeners open during the reauth", openAtReauth.Load())
			}
			if c.code != "" && tr.open() != 0 {
				t.Fatalf("%d listeners open after %s", tr.open(), c.code)
			}
			h.send(t, line(proto.Request{ID: "s", Op: proto.OpStatus}))
			st := statusOf(t, h.out.waitFor(t, "s"))
			if st.Hold != c.hold || tr.open() != c.open || int32(len(st.Ports)) != c.open {
				t.Fatalf("status %+v, %d open", st, tr.open())
			}
			// Asking for ports again does not bypass a hold.
			h.send(t, line(proto.Request{ID: "p2", Op: proto.OpSetPorts, Ports: []int{7001}}))
			h.out.waitFor(t, "p2")
			if tr.open() != c.open {
				t.Fatalf("setPorts opened %d listeners under hold %q", tr.open(), c.hold)
			}
		})
	}
}

// The node changes from Running to NeedsLogin while a login is decided.
// Whichever status observation sees the change, a reauth never runs with a
// listener open: the decision to reauth and to close is one step.
func TestStateChangeDuringTheLoginDecision(t *testing.T) {
	for _, flipAt := range []int32{1, 2} {
		fn := &fakenode.Node{}
		h, tr := enrolledHelper(t, fn)
		fn.SetState(proto.StateRunning)
		var calls atomic.Int32
		fn.OnStatus = func() {
			if calls.Add(1) == flipAt {
				fn.SetState(proto.StateNeedsLogin)
			}
		}
		openAtReauth := atomic.Int32{}
		openAtReauth.Store(-1)
		fn.OnReauth = func() { openAtReauth.Store(tr.open()) }
		h.send(t, line(proto.Request{ID: "l", Op: proto.OpLogin, AuthKey: "tskey-test-0000"}))
		r := h.out.waitFor(t, "l")
		ran := openAtReauth.Load() != -1
		if ran && openAtReauth.Load() != 0 {
			t.Fatalf("flip at observation %d: reauth ran with %d listeners open", flipAt, openAtReauth.Load())
		}
		if !ran && (r.OK || r.Error.Code != proto.CodeAlreadyLoggedIn) {
			t.Fatalf("flip at observation %d: %+v", flipAt, r)
		}
		if tr.open() != 1 {
			t.Fatalf("flip at observation %d: %d listeners open afterwards", flipAt, tr.open())
		}
	}
}
