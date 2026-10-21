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
}

// A reauth that completes as another node (a key of another tailnet, say)
// is refused: the enrolled state is put back and the node restarted from
// it, still needing login.
func TestReauthAsAnotherNodeRestoresTheEnrollment(t *testing.T) {
	dir := enrolled(t)
	statePath := filepath.Join(dir, "tailscaled.state")
	if err := os.WriteFile(statePath, []byte(`{"enrolled":"nClient"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var nodes []*fakenode.Node
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) {
		fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"}}
		if len(nodes) == 0 {
			fn.ReauthAs = "nOther"
			// tailscaled rewrites the profile as the other node.
			fn.OnReauth = func() { os.WriteFile(statePath, []byte(`{"enrolled":"nOther"}`), 0o600) }
		}
		nodes = append(nodes, fn)
		return fn, nil
	})
	m.Boot()
	_, err := m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodeIdentityChanged ||
		!strings.Contains(pe.Message, "nOther") || !strings.Contains(pe.Message, "nClient") {
		t.Fatalf("got %v", err)
	}
	if b, _ := os.ReadFile(statePath); string(b) != `{"enrolled":"nClient"}` {
		t.Fatalf("state after a refused reauth: %s", b)
	}
	if fi, err := os.Stat(statePath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("restored state mode: %v %v", fi.Mode(), err)
	}
	if len(nodes) != 2 || !nodes[0].Closed || nodes[1].Closed {
		t.Fatalf("the node that changed identity was not replaced by the restored one: %d nodes", len(nodes))
	}
	st, err := m.Status(context.Background())
	if err != nil || st.State != proto.StateNeedsLogin || st.Self.StableNodeID != "nClient" {
		t.Fatalf("status after a refused reauth: %+v %v", st, err)
	}
}

func TestFailedReauthKeepsTheEnrollment(t *testing.T) {
	dir := enrolled(t)
	fn := &fakenode.Node{State: proto.StateNeedsLogin, Self: proto.NodeInfo{StableNodeID: "nClient"},
		ReauthErr: &node.LoginError{Message: "invalid key tskey-test-0000"}}
	m := node.NewManager(node.Config{StateDir: dir}, func(node.Config, string) (node.Node, error) { return fn, nil })
	m.Boot()
	_, err := m.Login(context.Background(), "tskey-test-0000", 5*time.Second)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodeLoginFailed || strings.Contains(pe.Message, "tskey-test-0000") {
		t.Fatalf("got %v", err)
	}
	if !node.HasState(dir) || fn.Closed {
		t.Fatal("a failed reauth dropped the enrollment")
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
