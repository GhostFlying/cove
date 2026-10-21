package e2e

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// These tests need no tailnet: a daemon without node state never starts a
// node, so they exercise only the lock, socket and protocol handling.

func waitOutput(t *testing.T, d *dialProc, substr string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(d.stderr.String(), substr) {
		if time.Now().After(deadline) {
			t.Fatalf("no %q in output:\n%s", substr, d.stderr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func assertNoSocket(t *testing.T, sock string) {
	t.Helper()
	if _, err := os.Lstat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket %s exists: %v", sock, err)
	}
}

// An idle exit that has unlinked its socket but not yet released the lock
// must make a new daemon exit 75 (the CLI then retries), and the next
// daemon after the old one is gone must take over.
func TestDialRaceIdleExitBetweenUnlinkAndUnlock(t *testing.T) {
	home := filepath.Join(shortDir(t), "tsnet-client")
	old := startDial(t, nil, home, "--idle-timeout", "300ms", "--debug-pause-at", "unlinked")
	waitOutput(t, old, "debug pause at unlinked")
	assertNoSocket(t, old.sock)
	if code := spawnDial(t, nil, home).wait(10 * time.Second); code != 75 {
		t.Fatalf("daemon during old exit: code %d, want 75", code)
	}
	old.kill9()
	d := startDial(t, nil, home)
	if st := dialStatus(t, d.sock); st.State != proto.StateLoggedOut {
		t.Fatalf("status: %+v", st)
	}
}

// A race winner killed while it holds the lock but before it listens must
// not block the next daemon.
func TestDialRaceWinnerKilledBeforeReady(t *testing.T) {
	home := filepath.Join(shortDir(t), "tsnet-client")
	winner := spawnDial(t, nil, home, "--debug-pause-at", "locked")
	waitOutput(t, winner, "debug pause at locked")
	assertNoSocket(t, winner.sock)
	if code := spawnDial(t, nil, home).wait(10 * time.Second); code != 75 {
		t.Fatalf("loser: code %d, want 75", code)
	}
	winner.kill9()
	d := startDial(t, nil, home)
	dialStatus(t, d.sock)
}

// Concurrent starts produce exactly one daemon.
func TestDialConcurrentStartsOneOwner(t *testing.T) {
	home := filepath.Join(shortDir(t), "tsnet-client")
	type exit struct {
		p    *dialProc
		code int
	}
	exits := make(chan exit)
	procs := map[*dialProc]bool{}
	for range 6 {
		p := spawnDial(t, nil, home)
		procs[p] = true
		go func() { exits <- exit{p, p.wait(30 * time.Second)} }()
	}
	for range 5 {
		e := <-exits
		if e.code != 75 {
			t.Fatalf("exit code %d, want 75\n%s", e.code, e.p.stderr)
		}
		delete(procs, e.p)
	}
	if resp := request(t, dialPaths(home), proto.Request{Op: proto.OpStop}); !resp.OK {
		t.Fatalf("stop: %+v", resp.Error)
	}
	if e := <-exits; e.code != 0 || !procs[e.p] {
		t.Fatalf("owner exit code %d", e.code)
	}
}

func TestDialProtocolHandling(t *testing.T) {
	home := filepath.Join(shortDir(t), "tsnet-client")
	d := startDial(t, nil, home)

	s := connect(t, d.sock, proto.Version)
	if s.hello.Protocol != proto.Version || s.hello.Mode != "dial" || s.hello.Build == "" ||
		s.hello.PID != d.cmd.Process.Pid || s.hello.Streams == nil {
		t.Fatalf("hello: %+v", s.hello)
	}
	// The build identity injected at link time is echoed exactly by hello
	// and by the version command.
	if want := os.Getenv("COVE_TSNET_BUILD"); want != "" {
		if s.hello.Build != want {
			t.Fatalf("hello build %q, want %q", s.hello.Build, want)
		}
		out, err := execBinary(t, "version").Output()
		if err != nil || string(out) != fmt.Sprintf("cove-tsnet build=%s protocol=%d\n", want, proto.Version) {
			t.Fatalf("version: %q %v", out, err)
		}
	} else if os.Getenv("CI") != "" {
		t.Fatal("COVE_TSNET_BUILD is not set; run through scripts/tsnet-build.mjs test")
	}

	// A client of another protocol version still gets the frozen hello, is
	// refused everything else, and can still stop the daemon.
	other := connect(t, d.sock, proto.Version+1)
	if other.hello.Protocol != proto.Version {
		t.Fatalf("hello to other version: %+v", other.hello)
	}
	wantCode(t, other.roundTrip(t, proto.Request{Op: proto.OpStatus}), proto.CodeProtocolMismatch)

	// The first request must be hello.
	s2 := connectRaw(t, d.sock)
	wantCode(t, s2.roundTrip(t, proto.Request{Op: proto.OpStatus}), proto.CodeBadRequest)

	// Oversized frames are rejected, not buffered.
	s3 := connectRaw(t, d.sock)
	// (Written raw: WriteFrame itself refuses to send an oversized frame.)
	big := `{"op":"hello","label":"` + strings.Repeat("x", proto.MaxFrameBytes+10) + `"}` + "\n"
	go s3.conn.Write([]byte(big))
	s3.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := proto.ReadFrame(s3.br, proto.MaxFrameBytes)
	if err != nil || !strings.Contains(string(line), proto.CodeBadRequest) {
		t.Fatalf("oversized hello: %q %v", line, err)
	}

	// Without a logged-in node every dial fails before touching the network.
	_, resp := openStream(t, d.sock, "nSomeNodeCNTRL", 443, "")
	wantCode(t, resp, proto.CodeNotLoggedIn)
	wantCode(t, request(t, d.sock, proto.Request{Op: "bogus"}), proto.CodeBadRequest)

	stop := connect(t, d.sock, proto.Version+1)
	if resp := stop.roundTrip(t, proto.Request{Op: proto.OpStop}); !resp.OK {
		t.Fatalf("stop from another version: %+v", resp.Error)
	}
	if code := d.wait(10 * time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	assertNoSocket(t, d.sock)
}

func TestDialRefusesLongSocketPath(t *testing.T) {
	home := filepath.Join(shortDir(t), strings.Repeat("d", 100))
	d := spawnDial(t, nil, home)
	if code := d.wait(10 * time.Second); code != 1 || !strings.Contains(d.stderr.String(), "socket path") {
		t.Fatalf("code %d, output:\n%s", code, d.stderr)
	}
}

func TestServeRefusesSharedForwardDirectory(t *testing.T) {
	root := shortDir(t)
	fwd := filepath.Join(root, "fwd")
	if err := os.Mkdir(fwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fwd, 0o755); err != nil {
		t.Fatal(err)
	}
	d := &dialProc{t: t, stderr: newOutput()}
	d.cmd = execBinary(t, "serve", "--home", filepath.Join(root, "tsnet"), "--forward-socket", filepath.Join(fwd, "s.sock"))
	d.cmd.Stderr = d.stderr
	if err := d.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if code := d.wait(10 * time.Second); code != 1 || !strings.Contains(d.stderr.String(), "no group or other access") {
		t.Fatalf("code %d, output:\n%s", code, d.stderr)
	}
}

func TestSecretsAreNotAcceptedFromArgvOrEnv(t *testing.T) {
	d := &dialProc{t: t, stderr: newOutput()}
	d.cmd = execBinary(t, "dial", "--home", filepath.Join(shortDir(t), "c"), "--auth-key", testAuthKey)
	d.cmd.Stderr = d.stderr
	if err := d.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if code := d.wait(10 * time.Second); code != 2 {
		t.Fatalf("--auth-key accepted: code %d", code)
	}
	if strings.Contains(d.stderr.String(), testAuthKey) {
		t.Fatal("usage error echoed the key")
	}

	// TS_AUTHKEY in the environment is ignored. The control plane here
	// rejects registrations without the key, so if the inherited key took
	// effect the interactive login below would reach Running.
	tn := newTailnet(t, true)
	home := filepath.Join(shortDir(t), "c")
	d = &dialProc{t: t, home: home, sock: dialPaths(home), stderr: newOutput()}
	d.cmd = execBinary(t, "dial", "--home", home, "--control-url", tn.controlURL)
	d.cmd.Env = append(childEnv(), "TS_AUTHKEY="+testAuthKey, "TS_AUTH_KEY="+testAuthKey)
	d.cmd.Stderr = d.stderr
	if err := d.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.cmd.Process.Kill(); d.cmd.Wait() })
	waitSocket(t, d)
	resp := request(t, d.sock, proto.Request{Op: proto.OpLogin, TimeoutMs: 3000})
	if resp.OK {
		var st proto.Status
		remarshal(t, resp.Result, &st)
		if st.State == proto.StateRunning {
			t.Fatal("inherited TS_AUTHKEY logged the node in")
		}
	}
	if st := dialStatus(t, d.sock); st.State == proto.StateRunning {
		t.Fatalf("inherited TS_AUTHKEY logged the node in: %+v", st)
	}
}
