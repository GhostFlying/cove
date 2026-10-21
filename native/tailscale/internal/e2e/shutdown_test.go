package e2e

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

func TestChildPathHasNoTailscale(t *testing.T) {
	var paths []string
	for _, kv := range childEnv() {
		if strings.HasPrefix(kv, "PATH=") {
			paths = append(paths, kv)
		}
	}
	if len(paths) != 1 || paths[0] != "PATH="+childPath {
		t.Fatalf("child PATH entries %q, want only %q", paths, childPath)
	}
	for _, dir := range filepath.SplitList(childPath) {
		for _, name := range []string{"tailscale", "tailscaled"} {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				t.Errorf("%s is on the children's PATH", filepath.Join(dir, name))
			}
		}
	}
}

// SIGTERM while an interactive login waits on a control plane that never
// offers a login URL: the login is cancelled, the daemon exits promptly and
// releases the directory to the next daemon.
func TestDialSignalDuringBlockedLogin(t *testing.T) {
	tn := newTailnet(t, true)
	home := filepath.Join(shortDir(t), "tsnet-client")
	d := startDial(t, tn, home)
	s := connect(t, d.sock, proto.Version)
	got := make(chan proto.Response, 1)
	go func() {
		got <- s.roundTrip(t, proto.Request{Op: proto.OpLogin, TimeoutMs: 300000})
	}()
	time.Sleep(time.Second) // let the login block
	start := time.Now()
	d.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case resp := <-got:
		wantCode(t, resp, proto.CodeShuttingDown)
	case <-time.After(15 * time.Second):
		t.Fatal("no reply to the blocked login")
	}
	if code := d.wait(15 * time.Second); code != 0 {
		t.Fatalf("exit code %d\n%s", code, d.stderr)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("shutdown took %v", elapsed)
	}
	assertNoSocket(t, d.sock)
	next := startDial(t, tn, home)
	dialStatus(t, next.sock)
}

// stdin EOF while a login is blocked ends serve promptly with exit 0.
func TestServeEOFDuringBlockedLogin(t *testing.T) {
	tn := newTailnet(t, true)
	srv := startServe(t, tn, shortDir(t), "cove-srv")
	got := make(chan proto.Response, 1)
	go func() { got <- srv.call(proto.Request{Op: proto.OpLogin, TimeoutMs: 300000}) }()
	time.Sleep(time.Second)
	start := time.Now()
	if code := srv.stop(); code != 0 {
		t.Fatalf("exit code %d\n%s", code, srv.stderr)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("shutdown took %v", elapsed)
	}
	select {
	case resp := <-got:
		wantCode(t, resp, proto.CodeShuttingDown)
	case <-time.After(5 * time.Second):
		t.Fatal("no reply to the blocked login")
	}
}

// A control channel that ends abnormally is an error exit, so the Cove
// server can tell it from a requested shutdown.
func TestServeAbnormalControlChannelExitsNonzero(t *testing.T) {
	tn := newTailnet(t, false)
	for name, input := range map[string]string{
		"oversized": `{"op":"status","x":"` + strings.Repeat("a", proto.MaxFrameBytes) + `"}` + "\n",
		"truncated": `{"op":"sta`,
	} {
		srv := startServe(t, tn, shortDir(t), "cove-srv")
		// The helper may stop reading (and exit) before the whole frame is
		// written, so a write error here is expected.
		io.WriteString(srv.stdin, input)
		if code := srv.stop(); code != 1 || !strings.Contains(srv.stderr.String(), "control channel") {
			t.Fatalf("%s frame: exit code %d\n%s", name, code, srv.stderr)
		}
	}
}
