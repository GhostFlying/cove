package e2e

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
)

func loginServe(t *testing.T, srv *serveProc, ports ...int) string {
	t.Helper()
	st := decodeStatus(t, srv.call(proto.Request{Op: proto.OpLogin, AuthKey: testAuthKey}))
	if st.State != proto.StateRunning || st.Self == nil || st.Self.StableNodeID == "" {
		t.Fatalf("serve login: %+v", st)
	}
	if len(ports) > 0 {
		st = decodeStatus(t, srv.call(proto.Request{Op: proto.OpSetPorts, Ports: ports}))
		if fmt.Sprint(st.Ports) != fmt.Sprint(ports) {
			t.Fatalf("serve ports %v, want %v", st.Ports, ports)
		}
	}
	return st.Self.StableNodeID
}

func loginDial(t *testing.T, sock string) proto.NodeInfo {
	t.Helper()
	st := decodeStatus(t, request(t, sock, proto.Request{Op: proto.OpLogin, AuthKey: testAuthKey}))
	if st.State != proto.StateRunning || st.Self == nil {
		t.Fatalf("dial login: %+v", st)
	}
	return *st.Self
}

// assertNoSecret checks that the auth key reached no file under roots and
// no child output.
func assertNoSecret(t *testing.T, roots ...string) {
	t.Helper()
	for _, root := range roots {
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || !d.Type().IsRegular() {
				return nil
			}
			b, err := os.ReadFile(path)
			if err == nil && strings.Contains(string(b), testAuthKey) {
				t.Errorf("auth key found in %s", path)
			}
			return nil
		})
	}
	allOutput.mu.Lock()
	defer allOutput.mu.Unlock()
	for _, b := range allOutput.bufs {
		if strings.Contains(b.String(), testAuthKey) {
			t.Errorf("auth key found in child output")
		}
	}
}

// assertPrivate checks the 0700 directories the threat model relies on.
func assertPrivate(t *testing.T, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		fi, err := os.Stat(d)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o700 {
			t.Errorf("%s has mode %04o, want 0700", d, fi.Mode().Perm())
		}
	}
}

// assertPrivateFiles checks that every regular file under the roots has no
// group or other permission bits.
func assertPrivateFiles(t *testing.T, roots ...string) {
	t.Helper()
	for _, root := range roots {
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				t.Errorf("walking %s: %v", path, err)
				return nil
			}
			if !d.Type().IsRegular() {
				return nil
			}
			fi, err := d.Info()
			if err == nil && fi.Mode().Perm()&0o077 != 0 {
				t.Errorf("%s has mode %04o, want no group or other access", path, fi.Mode().Perm())
			}
			return nil
		})
	}
}

// startProbe joins an in-process node that plays "another node on the same
// tailnet".
func startProbe(t *testing.T, tn *tailnet) *tsnet.Server {
	t.Helper()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	s := &tsnet.Server{
		Dir:        filepath.Join(shortDir(t), "probe"),
		ControlURL: tn.controlURL,
		Hostname:   "probe",
		AuthKey:    testAuthKey,
		Ephemeral:  true,
		Store:      new(mem.Store),
		UserLogf:   func(string, ...any) {},
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.Up(ctxTimeout(t, 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	return s
}

// probePorts are ports a stock tailscaled or tsnet node might serve on:
// SSH, HTTP(S), the web client, the PeerAPI range Tailscale picks from, and
// the Cove test port.
var probePorts = []int{22, 80, 443, 5252, 7001, 8080, 41641}

// waitDialRunning polls status until a restored node is Running; the
// daemon answers before its node has finished starting.
func waitDialRunning(t *testing.T, sock string) proto.Status {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		st := dialStatus(t, sock)
		if st.State == proto.StateRunning && st.Self != nil {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("node did not reach Running: %+v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitStreams waits until the daemon reports n active streams; a stream
// ends once both of its directions have closed.
func waitStreams(t *testing.T, sock string, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := dialStatus(t, sock)
		if len(st.Streams) == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("streams %+v, want %d", st.Streams, n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestServeAndDialOverTestControl(t *testing.T) {
	tn := newTailnet(t, false)

	srvRoot := shortDir(t)
	srv := startServe(t, tn, srvRoot, "cove-srv")
	srvID := loginServe(t, srv, 7001)

	cliRoot := shortDir(t)
	cliHome := filepath.Join(cliRoot, "tsnet-client")
	d := startDial(t, tn, cliHome)
	if st := dialStatus(t, d.sock); st.State != proto.StateLoggedOut {
		t.Fatalf("fresh dial status: %+v", st)
	}

	cli := loginDial(t, d.sock)
	wantCode(t, request(t, d.sock, proto.Request{Op: proto.OpLogin, AuthKey: testAuthKey}), proto.CodeAlreadyLoggedIn)
	assertPrivate(t, cliHome, filepath.Join(cliHome, "run"), filepath.Join(cliHome, "state"),
		srv.home, filepath.Join(srv.home, "state"))
	assertPrivateFiles(t, filepath.Join(cliHome, "run"), filepath.Join(cliHome, "state"), filepath.Join(srv.home, "state"))
	if fi, err := os.Stat(d.sock); err != nil || fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("dial socket mode: %v %v", fi.Mode(), err)
	}

	// One stream, verified by stable ID, with the peer identity attached.
	s1, resp := openStream(t, d.sock, srvID, 7001, "attach")
	if !resp.OK {
		t.Fatalf("dial: %+v\nstderr:\n%s", resp.Error, d.stderr)
	}
	var dr proto.DialResult
	remarshal(t, resp.Result, &dr)
	if dr.Peer.StableNodeID != srvID {
		t.Fatalf("dial result peer %+v", dr.Peer)
	}
	f1 := srv.accept(15 * time.Second)
	if f1.hdr.Port != 7001 || f1.hdr.Peer == nil || f1.hdr.Peer.StableNodeID != cli.StableNodeID {
		t.Fatalf("forward header: %+v", f1.hdr)
	}
	echo(t, s1.conn, f1.br, "hello server")
	echo(t, f1.conn, s1.br, "hello client")

	// A second command shares the node while the first stream stays open.
	s2, resp := openStream(t, d.sock, srvID, 7001, "second")
	if !resp.OK {
		t.Fatalf("second dial: %+v", resp.Error)
	}
	f2 := srv.accept(15 * time.Second)
	echo(t, s2.conn, f2.br, "two")
	echo(t, s1.conn, f1.br, "one still works")
	if st := dialStatus(t, d.sock); len(st.Streams) != 2 || st.Streams[0].Label != "attach" {
		t.Fatalf("streams: %+v", st.Streams)
	}

	// Half-close travels end to end: the server sees EOF, can still reply.
	s2.conn.(*net.UnixConn).CloseWrite()
	if b, err := io.ReadAll(f2.br); err != nil || len(b) != 0 {
		t.Fatalf("server read after client half-close: %q %v", b, err)
	}
	echo(t, f2.conn, s2.br, "bye")
	f2.conn.Close()
	if _, err := io.ReadAll(s2.br); err != nil {
		t.Fatalf("client read to EOF: %v", err)
	}

	// Bytes the CLI sends in the same write as the dial frame are held until
	// the peer is verified, then delivered first.
	s4 := connect(t, d.sock, proto.Version)
	dialFrame, _ := json.Marshal(proto.Request{ID: "c", Op: proto.OpDial,
		Target: &proto.Target{StableNodeID: srvID}, Port: 7001})
	if _, err := s4.conn.Write(append(append(dialFrame, '\n'), "early bytes"...)); err != nil {
		t.Fatal(err)
	}
	s4.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	if line, err := proto.ReadFrame(s4.br, proto.MaxFrameBytes); err != nil ||
		!strings.Contains(string(line), `"ok":true`) {
		t.Fatalf("coalesced dial: %q %v", line, err)
	}
	f4 := srv.accept(15 * time.Second)
	early := make([]byte, len("early bytes"))
	f4.conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.ReadFull(f4.br, early); err != nil || string(early) != "early bytes" {
		t.Fatalf("server received %q %v", early, err)
	}
	s4.conn.Close()
	f4.conn.Close()

	// Failures are explicit and never fall back to names.
	_, resp = openStream(t, d.sock, srvID, 7002, "")
	wantCode(t, resp, proto.CodeDialFailed)
	_, resp = openStream(t, d.sock, "nNoSuchNodeCNTRL", 7001, "")
	wantCode(t, resp, proto.CodePeerNotFound)
	_, resp = openStream(t, d.sock, srvID, 0, "")
	wantCode(t, resp, proto.CodeBadRequest)

	// A node that takes the server's hostname (and so its MagicDNS name)
	// does not receive streams addressed to the server's stable ID.
	impRoot := shortDir(t)
	imp := startServe(t, tn, impRoot, "cove-srv")
	impID := loginServe(t, imp, 7001)
	if impID == srvID {
		t.Fatal("impostor got the server's stable ID")
	}
	s3, resp := openStream(t, d.sock, srvID, 7001, "")
	if !resp.OK {
		t.Fatalf("dial after impostor joined: %+v", resp.Error)
	}
	f3 := srv.accept(15 * time.Second)
	echo(t, s3.conn, f3.br, "real server")
	select {
	case f := <-imp.conns:
		t.Fatalf("impostor received a connection: %+v", f.hdr)
	case <-time.After(200 * time.Millisecond):
	}
	s3.conn.Close()
	f3.conn.Close()

	// Another tailnet node reaches nothing on the client node, and only the
	// configured port on the server node. Neither advertises a PeerAPI.
	probe := startProbe(t, tn)
	plc, err := probe.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	pst, err := plc.Status(ctxTimeout(t, 10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var cliIP, srvIP netip.Addr
	for _, p := range pst.Peer {
		if len(p.PeerAPIURL) > 0 {
			t.Errorf("peer %s advertises a PeerAPI: %v", p.ID, p.PeerAPIURL)
		}
		switch string(p.ID) {
		case cli.StableNodeID:
			cliIP = p.TailscaleIPs[0]
		case srvID:
			srvIP = p.TailscaleIPs[0]
		}
	}
	if !cliIP.IsValid() || !srvIP.IsValid() {
		t.Fatalf("probe does not see both nodes: %+v", pst.Peer)
	}
	for _, port := range probePorts {
		c, err := probe.Dial(ctxTimeout(t, 5*time.Second), "tcp", netip.AddrPortFrom(cliIP, uint16(port)).String())
		if err == nil {
			c.Close()
			t.Errorf("probe connected to the client node on port %d", port)
		}
		if port == 7001 {
			continue
		}
		c, err = probe.Dial(ctxTimeout(t, 5*time.Second), "tcp", netip.AddrPortFrom(srvIP, uint16(port)).String())
		if err == nil {
			c.Close()
			t.Errorf("probe connected to the server node on port %d", port)
		}
	}
	pc, err := probe.Dial(ctxTimeout(t, 5*time.Second), "tcp", netip.AddrPortFrom(srvIP, 7001).String())
	if err != nil {
		t.Fatalf("probe to the server's configured port: %v", err)
	}
	fp := srv.accept(15 * time.Second)
	if fp.hdr.Peer == nil || fp.hdr.Peer.HostName != "probe" {
		t.Fatalf("probe forward header: %+v", fp.hdr)
	}
	pc.Close()

	// Closing a port leaves its accepted connections alone.
	decodeStatus(t, srv.call(proto.Request{Op: proto.OpSetPorts, Ports: []int{}}))
	echo(t, s1.conn, f1.br, "survives port close")
	_, resp = openStream(t, d.sock, srvID, 7001, "")
	wantCode(t, resp, proto.CodeDialFailed)
	decodeStatus(t, srv.call(proto.Request{Op: proto.OpSetPorts, Ports: []int{7001}}))

	// Disruptive requests list the active stream and change nothing.
	e := wantCode(t, request(t, d.sock, proto.Request{Op: proto.OpLogout}), proto.CodeActiveStreams)
	if len(e.Streams) != 1 || e.Streams[0].Label != "attach" {
		t.Fatalf("logout listed %+v", e.Streams)
	}
	wantCode(t, request(t, d.sock, proto.Request{Op: proto.OpStop}), proto.CodeActiveStreams)
	echo(t, s1.conn, f1.br, "still attached")

	// Forced logout closes the stream first, then deletes the node state.
	st := decodeStatus(t, request(t, d.sock, proto.Request{Op: proto.OpLogout, Force: true}))
	if st.State != proto.StateLoggedOut || st.RemoteLogoutConfirmed == nil || !*st.RemoteLogoutConfirmed ||
		len(st.Warnings) != 0 {
		t.Fatalf("after logout: %+v", st)
	}
	if _, err := io.ReadAll(s1.br); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Logf("stream read after logout: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cliHome, "state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("logout kept node state: %v", err)
	}
	_, resp = openStream(t, d.sock, srvID, 7001, "")
	wantCode(t, resp, proto.CodeNotLoggedIn)

	assertNoSecret(t, srvRoot, cliRoot, impRoot)
}

func TestRejectedLoginLeavesNoState(t *testing.T) {
	tn := newTailnet(t, true)
	root := shortDir(t)
	home := filepath.Join(root, "tsnet-client")
	d := startDial(t, tn, home)
	resp := request(t, d.sock, proto.Request{Op: proto.OpLogin, AuthKey: "tskey-auth-wrong", TimeoutMs: 15000})
	wantCode(t, resp, proto.CodeLoginFailed)
	if _, err := os.Stat(filepath.Join(home, "state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed login left node state: %v", err)
	}
	if st := dialStatus(t, d.sock); st.State != proto.StateLoggedOut {
		t.Fatalf("status after failed login: %+v", st)
	}
	loginDial(t, d.sock)

	srv := startServe(t, tn, shortDir(t), "cove-srv")
	wantCode(t, srv.call(proto.Request{Op: proto.OpLogin, AuthKey: "tskey-auth-wrong", TimeoutMs: 15000}), proto.CodeLoginFailed)
	if st := srv.status(); st.State != proto.StateLoggedOut {
		t.Fatalf("serve status after failed login: %+v", st)
	}
	loginServe(t, srv)
	assertNoSecret(t, root)
}

func TestDialDaemonLifecycle(t *testing.T) {
	tn := newTailnet(t, false)
	srvRoot := shortDir(t)
	srv := startServe(t, tn, srvRoot, "cove-srv")
	srvID := loginServe(t, srv, 7001)

	cliRoot := shortDir(t)
	home := filepath.Join(cliRoot, "tsnet-client")
	d1 := startDial(t, tn, home)
	cli := loginDial(t, d1.sock)

	// Only one daemon owns the directory; a second exits with code 75.
	if code := spawnDial(t, tn, home).wait(10 * time.Second); code != 75 {
		t.Fatalf("second daemon exit code %d, want 75", code)
	}

	s, resp := openStream(t, d1.sock, srvID, 7001, "attach")
	if !resp.OK {
		t.Fatalf("dial: %+v", resp.Error)
	}
	f := srv.accept(15 * time.Second)
	echo(t, s.conn, f.br, "before crash")

	// SIGKILL leaves the socket file behind; the next daemon takes over
	// with the same node identity and no login.
	d1.kill9()
	if _, err := os.Lstat(d1.sock); err != nil {
		t.Fatalf("expected a stale socket after SIGKILL: %v", err)
	}
	if _, err := s.br.ReadByte(); err == nil {
		t.Fatal("stream survived the daemon's death")
	}
	start := time.Now()
	d2 := startDial(t, tn, home)
	s, resp = openStream(t, d2.sock, srvID, 7001, "reattach")
	if !resp.OK {
		t.Fatalf("dial after takeover: %+v\nstderr:\n%s", resp.Error, d2.stderr)
	}
	t.Logf("takeover to first stream: %v", time.Since(start))
	f = srv.accept(15 * time.Second)
	if f.hdr.Peer == nil || f.hdr.Peer.StableNodeID != cli.StableNodeID {
		t.Fatalf("identity changed after takeover: %+v", f.hdr.Peer)
	}
	echo(t, s.conn, f.br, "after takeover")
	s.conn.Close()
	f.conn.Close()
	waitStreams(t, d2.sock, 0)

	// stop with no streams exits, removes the socket and frees the lock.
	if resp := request(t, d2.sock, proto.Request{Op: proto.OpStop}); !resp.OK {
		t.Fatalf("stop failed: %+v", resp.Error)
	}
	if code := d2.wait(15 * time.Second); code != 0 {
		t.Fatalf("stopped daemon exit code %d", code)
	}
	if _, err := os.Lstat(d2.sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket remains after stop: %v", err)
	}

	// Idle exit, again with the restored node.
	d3 := startDial(t, tn, home, "--idle-timeout", "2s")
	if st := waitDialRunning(t, d3.sock); st.Self.StableNodeID != cli.StableNodeID {
		t.Fatalf("identity after restart: %+v", st.Self)
	}
	if code := d3.wait(20 * time.Second); code != 0 {
		t.Fatalf("idle daemon exit code %d", code)
	}
	if _, err := os.Lstat(d3.sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket remains after idle exit: %v", err)
	}

	assertNoSecret(t, srvRoot, cliRoot)
}

func TestServeRestartKeepsIdentity(t *testing.T) {
	tn := newTailnet(t, false)
	root := shortDir(t)
	srv := startServe(t, tn, root, "cove-srv")
	id := loginServe(t, srv, 7001)
	if code := srv.stop(); code != 0 {
		t.Fatalf("serve exit code %d", code)
	}

	srv = startServe(t, tn, root, "cove-srv")
	deadline := time.Now().Add(30 * time.Second)
	for {
		st := srv.status()
		if st.State == proto.StateRunning {
			if st.Self == nil || st.Self.StableNodeID != id {
				t.Fatalf("identity changed: %+v", st.Self)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restored node did not reach Running: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Logout deletes the state; the next start needs a new login.
	st := decodeStatus(t, srv.call(proto.Request{Op: proto.OpLogout}))
	if st.State != proto.StateLoggedOut || len(st.Ports) != 0 || st.RemoteLogoutConfirmed == nil ||
		!*st.RemoteLogoutConfirmed {
		t.Fatalf("after logout: %+v", st)
	}
	srv.stop()
	srv = startServe(t, tn, root, "cove-srv")
	if st := srv.status(); st.State != proto.StateLoggedOut {
		t.Fatalf("status after logout and restart: %+v", st)
	}
	assertNoSecret(t, root)
}
