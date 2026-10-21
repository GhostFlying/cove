package node_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fakenode"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// enrolled returns a state directory that looks like an enrolled node.
func enrolled(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func confirmed(t *testing.T, st proto.Status) bool {
	t.Helper()
	if st.RemoteLogoutConfirmed == nil {
		t.Fatal("logout result has no remoteLogoutConfirmed")
	}
	return *st.RemoteLogoutConfirmed
}

func TestLogoutOfAnUnstartableNodeIsUnconfirmed(t *testing.T) {
	dir := enrolled(t)
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) {
		return nil, errors.New("state is corrupt")
	})
	m.Boot()
	st, err := m.Logout(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed(t, st) || len(st.Warnings) != 1 || !strings.Contains(st.Warnings[0], "admin console") ||
		!strings.Contains(st.Warnings[0], "state is corrupt") {
		t.Fatalf("got %+v", st)
	}
	if node.HasState(dir) {
		t.Fatal("local state was kept")
	}
}

func TestLogoutReportsWhetherTheControlPlaneConfirmed(t *testing.T) {
	for _, logoutErr := range []error{nil, errors.New("control unreachable")} {
		dir := enrolled(t)
		fn := &fakenode.Node{State: proto.StateRunning, LogoutErr: logoutErr}
		m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) { return fn, nil })
		m.Boot()
		st, err := m.Logout(context.Background(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if want := logoutErr == nil; confirmed(t, st) != want || (len(st.Warnings) == 0) != want {
			t.Fatalf("logout error %v: got %+v", logoutErr, st)
		}
		if node.HasState(dir) || !fn.Closed {
			t.Fatal("node not stopped and deleted")
		}
	}
}

// An enrolled node that needs login again (an expired key) is reauthorized
// in place with the new key; its state, and so its identity, are kept.
func TestLoginWithKeyReauthorizesAnEnrolledNode(t *testing.T) {
	dir := enrolled(t)
	fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"}}
	starts := 0
	m := node.NewManager(node.Config{StateDir: dir}, func(_ node.Config, key string) (node.Node, error) {
		starts++
		if key != "" {
			t.Error("an enrolled node was restarted with the key")
		}
		return fn, nil
	})
	m.Boot()
	st, err := m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != proto.StateRunning || st.Self.StableNodeID != "nClient" || starts != 1 ||
		len(fn.Reauths) != 1 || fn.Reauths[0] != "tskey-test-0000" || !node.HasState(dir) {
		t.Fatalf("got %+v, starts %d, reauths %d", st, starts, len(fn.Reauths))
	}
	if st.Hold != "" || m.Usable() == nil {
		t.Fatalf("the hold outlived a reauth as the enrolled node: %+v", st)
	}
}

// starter returns fn on every start and counts the starts.
func starter(t *testing.T, fn *fakenode.Node, starts *int) node.Starter {
	return func(_ node.Config, key string) (node.Node, error) {
		*starts++
		if key != "" {
			t.Error("an enrolled node was restarted with the key")
		}
		fn.Closed = false
		return fn, nil
	}
}

func wantCode(t *testing.T, err error, code string, contains ...string) *proto.Error {
	t.Helper()
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
	for _, s := range contains {
		if !strings.Contains(pe.Message, s) {
			t.Fatalf("message %q lacks %q", pe.Message, s)
		}
	}
	if strings.Contains(pe.Message, "tskey-test-0000") {
		t.Fatalf("message %q echoes the key", pe.Message)
	}
	return pe
}

// heldDuringReauth arms fn so the test learns whether the manager placed
// its hold (and so closed serve's listeners) before the reauth started.
func heldDuringReauth(m *node.Manager, fn *fakenode.Node) *bool {
	held, sawHold := false, new(bool)
	m.OnHold(func() { held = true })
	fn.OnReauth = func() { *sawHold = held && m.Usable() == nil }
	return sawHold
}

// A reauth that completes as another node (a key of another tailnet, say)
// is reported as it is, without touching the state: the node is stopped
// and stays held, status names the identity it now has, and only a logout
// ends the hold.
func TestReauthAsAnotherNodeIsReported(t *testing.T) {
	dir := enrolled(t)
	fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"}, ReauthAs: "nOther"}
	starts := 0
	m := node.NewManager(node.Config{StateDir: dir}, starter(t, fn, &starts))
	m.Boot()
	sawHold := heldDuringReauth(m, fn)
	_, err := m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	wantCode(t, err, proto.CodeIdentityChanged, "nOther", "nClient", "pair again", "log out")
	if !*sawHold || !fn.Closed || m.Usable() != nil || !m.Held() {
		t.Fatalf("hold before reauth %v, closed %v, usable %v", *sawHold, fn.Closed, m.Usable())
	}
	st, err := m.Status(context.Background())
	if err != nil || st.Hold != proto.CodeIdentityChanged || st.Self == nil || st.Self.StableNodeID != "nOther" ||
		st.State != proto.StateUnavailable || len(st.Warnings) == 0 || !strings.Contains(st.Warnings[0], "pair again") {
		t.Fatalf("status: %+v %v", st, err)
	}
	if starts != 1 {
		t.Fatalf("a changed identity was restarted: %d starts", starts)
	}
	_, err = m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	wantCode(t, err, proto.CodeIdentityChanged)
	if len(fn.Reauths) != 1 {
		t.Fatal("a held node was logged in again")
	}
	if _, err := m.Logout(context.Background(), time.Second); err != nil {
		t.Fatal(err)
	}
	if m.Held() || node.HasState(dir) {
		t.Fatal("logout did not end the hold")
	}
}

// A reauth that did not finish is uncertain, whatever the error: the node
// is stopped and held until status restarts it from the state and reads
// the identity it was persisted as.
func TestUnfinishedReauthIsUncertainUntilChecked(t *testing.T) {
	for _, c := range []struct {
		name string
		set  func(*fakenode.Node)
		// timeout is the login timeout; want is the identity status then
		// finds, and wantHold the hold it reports.
		timeout  time.Duration
		cause    string
		want     string
		wantHold string
	}{
		{name: "rejected", set: func(fn *fakenode.Node) { fn.ReauthErr = &node.LoginError{Message: "invalid key tskey-test-0000"} },
			timeout: 5 * time.Second, cause: "invalid key [redacted]", want: "nClient"},
		{name: "timed out", set: func(fn *fakenode.Node) { fn.BlockReauth = true },
			timeout: 200 * time.Millisecond, cause: proto.CodeLoginTimeout, want: "nClient"},
		{name: "timed out, then completed as another node", set: func(fn *fakenode.Node) { fn.BlockReauth, fn.LateAs = true, "nOther" },
			timeout: 200 * time.Millisecond, cause: proto.CodeLoginTimeout, want: "nOther", wantHold: proto.CodeIdentityChanged},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := enrolled(t)
			fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"}}
			c.set(fn)
			starts := 0
			m := node.NewManager(node.Config{StateDir: dir}, starter(t, fn, &starts))
			m.Boot()
			sawHold := heldDuringReauth(m, fn)
			_, err := m.Login(context.Background(), "tskey-test-0000", c.timeout)
			wantCode(t, err, proto.CodeLoginUncertain, "nClient", c.cause)
			if !*sawHold || !fn.Closed || m.Usable() != nil || !node.HasState(dir) {
				t.Fatalf("hold before reauth %v, closed %v, usable %v", *sawHold, fn.Closed, m.Usable())
			}
			st, err := m.Status(context.Background())
			if err != nil || starts != 2 || st.Hold != c.wantHold || st.Self.StableNodeID != c.want {
				t.Fatalf("status: %+v %v, %d starts", st, err, starts)
			}
			if usable := m.Usable() != nil; usable != (c.wantHold == "") || fn.Closed == usable {
				t.Fatalf("usable %v, closed %v", usable, fn.Closed)
			}
		})
	}
}

// While the identity cannot be checked (the node does not start), the
// hold stays and status says why.
func TestUncertainHoldWhileTheNodeCannotStart(t *testing.T) {
	dir := enrolled(t)
	fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"}, BlockReauth: true}
	broken := false
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) {
		if broken {
			return nil, errors.New("state is locked")
		}
		return fn, nil
	})
	m.Boot()
	_, err := m.Login(context.Background(), "tskey-test-0000", 100*time.Millisecond)
	wantCode(t, err, proto.CodeLoginUncertain)
	broken = true
	st, err := m.Status(context.Background())
	if err != nil || st.Hold != proto.CodeLoginUncertain || st.State != proto.StateUnavailable ||
		!strings.Contains(st.Warnings[0], "state is locked") || m.Usable() != nil {
		t.Fatalf("status: %+v %v", st, err)
	}
	_, err = m.Login(context.Background(), "tskey-test-0000", time.Second)
	wantCode(t, err, proto.CodeLoginUncertain, "state is locked")
	if _, err := m.Running(context.Background(), time.Second); err == nil {
		t.Fatal("a held node was handed out for dialing")
	}
	broken = false
	if st, err := m.Status(context.Background()); err != nil || st.Hold != "" || m.Usable() == nil {
		t.Fatalf("status once the node starts: %+v %v", st, err)
	}
}

// An interactive login of an enrolled node can complete as another node
// whenever the owner opens the URL, so it is held until status sees the
// node Running as the enrolled identity.
func TestInteractiveReloginIsHeldUntilItRunsAsTheEnrolledNode(t *testing.T) {
	for _, as := range []string{"nClient", "nOther"} {
		dir := enrolled(t)
		fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"},
			AuthURL: "https://login.example/a"}
		starts := 0
		m := node.NewManager(node.Config{StateDir: dir}, starter(t, fn, &starts))
		m.Boot()
		st, err := m.Login(context.Background(), "", 5*time.Second)
		if err != nil || st.AuthURL == "" || st.Hold != proto.CodeLoginUncertain || m.Usable() != nil {
			t.Fatalf("interactive login: %+v %v", st, err)
		}
		if st, _ := m.Status(context.Background()); st.Hold != proto.CodeLoginUncertain {
			t.Fatalf("hold ended before the login completed: %+v", st)
		}
		fn.SetSelf(as)
		fn.SetState(proto.StateRunning)
		st, err = m.Status(context.Background())
		if as == "nClient" && (err != nil || st.Hold != "" || m.Usable() == nil) {
			t.Fatalf("completed as the enrolled node: %+v %v", st, err)
		}
		if as == "nOther" && (err != nil || st.Hold != proto.CodeIdentityChanged || !fn.Closed || m.Usable() != nil) {
			t.Fatalf("completed as another node: %+v %v", st, err)
		}
	}
}

func TestFailedFreshLoginReportsStateCleanupFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	parent := t.TempDir()
	dir := filepath.Join(parent, "state")
	t.Cleanup(func() { os.Chmod(parent, 0o700) })
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) {
		// The partial state exists and cannot be removed.
		os.WriteFile(filepath.Join(dir, "partial"), nil, 0o600)
		os.Chmod(parent, 0o500)
		// Long enough that the message alone fills the error text bound.
		return nil, errors.New("control rejected the key tskey-test-0000: " + strings.Repeat("x", 2*proto.MaxTextBytes))
	})
	_, err := m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodeLoginFailed ||
		!strings.Contains(pe.Message, "removing the partial node state failed") ||
		strings.Contains(pe.Message, "tskey-test-0000") {
		t.Fatalf("got %v", err)
	}
}

// A login cancelled by shutdown reports SHUTTING_DOWN, not a login failure.
func TestLoginCancelledByShutdown(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	fn := &fakenode.Node{State: proto.StateNeedsLogin, BlockWait: true}
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) { return fn, nil })
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	_, err := m.Login(ctx, "tskey-test-0000", time.Minute)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodeShuttingDown {
		t.Fatalf("got %v", err)
	}
}
