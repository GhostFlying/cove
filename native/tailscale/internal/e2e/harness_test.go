// Package e2e runs the compiled cove-tsnet binary against Tailscale's test
// control plane (tstest/integration/testcontrol) with a local DERP and STUN
// server, so serve and dial nodes form a real tailnet on loopback without
// touching any real tailnet or the system tailscaled.
//
// The binary under test is COVE_TSNET_BIN; scripts/tsnet-build.mjs test
// builds it with the shipped feature tags and sets the variable.
package e2e

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/nettype"
)

// testAuthKey is accepted only by the in-process test control server.
const testAuthKey = "tskey-auth-cove-e2e-not-a-real-key-0123456789"

func binary(t *testing.T) string {
	t.Helper()
	bin := os.Getenv("COVE_TSNET_BIN")
	if bin == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("COVE_TSNET_BIN is not set; run through scripts/tsnet-build.mjs test")
		}
		t.Skip("COVE_TSNET_BIN is not set; run through scripts/tsnet-build.mjs test")
	}
	return bin
}

type tailnet struct {
	controlURL string
	control    *testcontrol.Server
}

// newTailnet starts a test control plane. With requireKey it rejects every
// registration without testAuthKey; testcontrol applies that to
// re-registrations of known nodes too (real control does not), so a tailnet
// that restarts nodes from saved state accepts any key instead.
func newTailnet(t *testing.T, requireKey bool) *tailnet {
	t.Helper()
	derpMap := runDERPAndSTUN(t)
	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "tail-scale.ts.net",
		Logf:           logger.Discard,
	}
	if requireKey {
		control.RequireAuthKey = testAuthKey
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return &tailnet{controlURL: control.HTTPTestServer.URL, control: control}
}

// runDERPAndSTUN starts a loopback DERP relay and STUN server. It mirrors
// tstest/integration.RunDERPAndSTUN, which cannot be imported here because
// that package depends on Tailscale features cove-tsnet compiles out.
func runDERPAndSTUN(t *testing.T) *tailcfg.DERPMap {
	t.Helper()
	d := derpserver.New(key.NewNode(), logger.Discard)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpsrv := httptest.NewUnstartedServer(derpserver.Handler(d))
	httpsrv.Listener.Close()
	httpsrv.Listener = ln
	httpsrv.Config.ErrorLog = logger.StdLogger(logger.Discard)
	httpsrv.Config.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	httpsrv.StartTLS()
	stunAddr, stunCleanup := stuntest.ServeWithPacketListener(t, nettype.Std{})
	t.Cleanup(func() {
		httpsrv.CloseClientConnections()
		httpsrv.Close()
		d.Close()
		stunCleanup()
	})
	return &tailcfg.DERPMap{
		Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
			1: {
				RegionID:   1,
				RegionCode: "test",
				Nodes: []*tailcfg.DERPNode{{
					Name:             "t1",
					RegionID:         1,
					HostName:         "127.0.0.1",
					IPv4:             "127.0.0.1",
					IPv6:             "none",
					STUNPort:         stunAddr.Port,
					DERPPort:         ln.Addr().(*net.TCPAddr).Port,
					InsecureForTests: true,
					STUNTestIP:       "127.0.0.1",
				}},
			},
		},
	}
}

// shortDir returns a fresh directory with a short path: Unix socket paths
// are limited to about 103 bytes and t.TempDir is long on macOS.
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "ctn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// childEnv is the environment of every child. It points the nodes at the
// test control plane only, keeps them off the real one, and carries no
// credential.
func childEnv() []string {
	return append(os.Environ(),
		"TS_ASSUME_NETWORK_UP_FOR_TEST=1",
		"TS_PANIC_IF_HIT_MAIN_CONTROL=1",
		"TS_DISABLE_PORTMAPPER=1",
	)
}

// syncBuffer collects a child's stderr.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// allOutput records every child's stderr so the secret check can scan it.
var allOutput struct {
	mu   sync.Mutex
	bufs []*syncBuffer
}

func newOutput() *syncBuffer {
	b := &syncBuffer{}
	allOutput.mu.Lock()
	allOutput.bufs = append(allOutput.bufs, b)
	allOutput.mu.Unlock()
	return b
}

func waitExit(cmd *exec.Cmd, timeout time.Duration) (int, error) {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		if err != nil {
			return -1, err
		}
		return 0, nil
	case <-time.After(timeout):
		cmd.Process.Kill()
		<-done
		return -1, fmt.Errorf("process did not exit within %v", timeout)
	}
}

// ---- serve ----

type forwarded struct {
	hdr  proto.ForwardHeader
	conn net.Conn
	br   *bufio.Reader
}

type serveProc struct {
	t       *testing.T
	home    string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stderr  *syncBuffer
	fwdLn   net.Listener
	conns   chan forwarded
	mu      sync.Mutex
	pending map[string]chan proto.Response
	nextID  int
	exited  chan struct{}
}

// startServe starts a serve child. root holds both the tsnet home and the
// forward socket directory, so a restart with the same root keeps identity.
func startServe(t *testing.T, tn *tailnet, root, hostname string) *serveProc {
	t.Helper()
	fwdDir := filepath.Join(root, "fwd")
	if err := os.MkdirAll(fwdDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(fwdDir, "s.sock")
	os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	s := &serveProc{
		t:       t,
		home:    filepath.Join(root, "tsnet"),
		stderr:  newOutput(),
		fwdLn:   ln,
		conns:   make(chan forwarded, 16),
		pending: map[string]chan proto.Response{},
		exited:  make(chan struct{}),
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				br := bufio.NewReader(c)
				line, err := proto.ReadFrame(br, proto.MaxFrameBytes)
				if err != nil {
					t.Errorf("forward header: %v", err)
					c.Close()
					return
				}
				var hdr proto.ForwardHeader
				if err := json.Unmarshal(line, &hdr); err != nil {
					t.Errorf("forward header %q: %v", line, err)
					c.Close()
					return
				}
				s.conns <- forwarded{hdr: hdr, conn: c, br: br}
			}()
		}
	}()
	s.cmd = exec.Command(binary(t), "serve",
		"--home", s.home, "--forward-socket", sock,
		"--hostname", hostname, "--control-url", tn.controlURL)
	s.cmd.Env = childEnv()
	s.cmd.Stderr = s.stderr
	s.stdin, err = s.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := s.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(s.exited)
		br := bufio.NewReader(stdout)
		for {
			line, err := proto.ReadFrame(br, 1<<20)
			if err != nil {
				return
			}
			var resp proto.Response
			if err := json.Unmarshal(line, &resp); err != nil {
				t.Errorf("serve stdout %q: %v", line, err)
				continue
			}
			s.mu.Lock()
			ch := s.pending[resp.ID]
			delete(s.pending, resp.ID)
			s.mu.Unlock()
			if ch != nil {
				ch <- resp
			}
		}
	}()
	t.Cleanup(func() {
		s.stop()
		ln.Close()
	})
	hello := s.call(proto.Request{Op: proto.OpHello, Protocol: proto.Version, Build: "e2e"})
	if !hello.OK {
		t.Fatalf("serve hello: %+v", hello.Error)
	}
	return s
}

func (s *serveProc) call(req proto.Request) proto.Response {
	s.t.Helper()
	s.mu.Lock()
	s.nextID++
	req.ID = strconv.Itoa(s.nextID)
	ch := make(chan proto.Response, 1)
	s.pending[req.ID] = ch
	s.mu.Unlock()
	if err := proto.WriteFrame(s.stdin, req); err != nil {
		s.t.Fatalf("serve %s: %v\nstderr:\n%s", req.Op, err, s.stderr)
	}
	select {
	case resp := <-ch:
		return resp
	case <-time.After(90 * time.Second):
		s.t.Fatalf("serve %s: no response\nstderr:\n%s", req.Op, s.stderr)
	}
	return proto.Response{}
}

// stop closes stdin, the documented way to end serve, and waits.
func (s *serveProc) stop() int {
	if s.cmd.ProcessState != nil {
		return s.cmd.ProcessState.ExitCode()
	}
	s.stdin.Close()
	code, err := waitExit(s.cmd, 20*time.Second)
	if err != nil {
		s.t.Errorf("serve exit: %v\nstderr:\n%s", err, s.stderr)
	}
	return code
}

func (s *serveProc) status() proto.Status {
	s.t.Helper()
	return decodeStatus(s.t, s.call(proto.Request{Op: proto.OpStatus}))
}

func (s *serveProc) accept(timeout time.Duration) forwarded {
	s.t.Helper()
	select {
	case f := <-s.conns:
		s.t.Cleanup(func() { f.conn.Close() })
		return f
	case <-time.After(timeout):
		s.t.Fatalf("no forwarded connection within %v\nstderr:\n%s", timeout, s.stderr)
	}
	return forwarded{}
}

func decodeStatus(t *testing.T, resp proto.Response) proto.Status {
	t.Helper()
	if !resp.OK {
		t.Fatalf("request failed: %+v", resp.Error)
	}
	var st proto.Status
	remarshal(t, resp.Result, &st)
	return st
}

func remarshal(t *testing.T, in, out any) {
	t.Helper()
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		t.Fatal(err)
	}
}

// ---- dial ----

type dialProc struct {
	t      *testing.T
	home   string
	sock   string
	cmd    *exec.Cmd
	stderr *syncBuffer
}

func dialPaths(home string) string { return filepath.Join(home, "run", "dial.sock") }

// spawnDial starts a dial daemon without waiting for it.
func spawnDial(t *testing.T, tn *tailnet, home string, extra ...string) *dialProc {
	t.Helper()
	args := []string{"dial", "--home", home, "--hostname", "cove-cli"}
	if tn != nil {
		args = append(args, "--control-url", tn.controlURL)
	}
	args = append(args, extra...)
	d := &dialProc{t: t, home: home, sock: dialPaths(home), stderr: newOutput()}
	d.cmd = execBinary(t, args...)
	d.cmd.Stderr = d.stderr
	if err := d.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if d.cmd.ProcessState == nil {
			d.cmd.Process.Kill()
			d.cmd.Wait()
		}
	})
	return d
}

// startDial starts a daemon and waits until its socket answers hello.
func startDial(t *testing.T, tn *tailnet, home string, extra ...string) *dialProc {
	t.Helper()
	d := spawnDial(t, tn, home, extra...)
	waitSocket(t, d)
	return d
}

func execBinary(t *testing.T, args ...string) *exec.Cmd {
	cmd := exec.Command(binary(t), args...)
	cmd.Env = childEnv()
	return cmd
}

func waitSocket(t *testing.T, d *dialProc) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		c, err := net.Dial("unix", d.sock)
		if err == nil {
			c.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("dial socket not ready: %v\nstderr:\n%s", err, d.stderr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (d *dialProc) kill9() {
	d.cmd.Process.Signal(syscall.SIGKILL)
	d.cmd.Wait()
}

func (d *dialProc) wait(timeout time.Duration) int {
	d.t.Helper()
	code, err := waitExit(d.cmd, timeout)
	if err != nil {
		d.t.Fatalf("dial exit: %v\nstderr:\n%s", err, d.stderr)
	}
	return code
}

// session is one CLI connection to the dial socket.
type session struct {
	conn  net.Conn
	br    *bufio.Reader
	hello proto.Hello
}

// connectRaw opens a connection without sending hello.
func connectRaw(t *testing.T, sock string) *session {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("connect %s: %v", sock, err)
	}
	t.Cleanup(func() { c.Close() })
	return &session{conn: c, br: bufio.NewReader(c)}
}

func connect(t *testing.T, sock string, protocol int) *session {
	t.Helper()
	s := connectRaw(t, sock)
	resp := s.roundTrip(t, proto.Request{Op: proto.OpHello, Protocol: protocol, Build: "e2e"})
	if !resp.OK {
		t.Fatalf("hello: %+v", resp.Error)
	}
	remarshal(t, resp.Result, &s.hello)
	return s
}

func (s *session) roundTrip(t *testing.T, req proto.Request) proto.Response {
	t.Helper()
	s.conn.SetDeadline(time.Now().Add(90 * time.Second))
	defer s.conn.SetDeadline(time.Time{})
	if err := proto.WriteFrame(s.conn, req); err != nil {
		t.Fatalf("%s: %v", req.Op, err)
	}
	line, err := proto.ReadFrame(s.br, 1<<20)
	if err != nil {
		t.Fatalf("%s response: %v", req.Op, err)
	}
	var resp proto.Response
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatalf("%s response %q: %v", req.Op, line, err)
	}
	return resp
}

// request sends one request on a fresh connection.
func request(t *testing.T, sock string, req proto.Request) proto.Response {
	t.Helper()
	return connect(t, sock, proto.Version).roundTrip(t, req)
}

func dialStatus(t *testing.T, sock string) proto.Status {
	t.Helper()
	return decodeStatus(t, request(t, sock, proto.Request{Op: proto.OpStatus}))
}

// openStream asks the daemon for a stream; on success the session's conn
// carries raw bytes.
func openStream(t *testing.T, sock, target string, port int, label string) (*session, proto.Response) {
	t.Helper()
	s := connect(t, sock, proto.Version)
	resp := s.roundTrip(t, proto.Request{
		Op: proto.OpDial, Target: &proto.Target{StableNodeID: target}, Port: port, Label: label,
	})
	return s, resp
}

func wantCode(t *testing.T, resp proto.Response, code string) *proto.Error {
	t.Helper()
	if resp.OK || resp.Error == nil || resp.Error.Code != code {
		t.Fatalf("want error %s, got ok=%v error=%+v", code, resp.OK, resp.Error)
	}
	return resp.Error
}

// echo writes msg on a and expects it on b.
func echo(t *testing.T, a io.Writer, b io.Reader, msg string) {
	t.Helper()
	if _, err := io.WriteString(a, msg); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(msg))
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(b, got)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting for %q", msg)
	}
	if string(got) != msg {
		t.Fatalf("got %q, want %q", got, msg)
	}
}

func ctxTimeout(t *testing.T, d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}
