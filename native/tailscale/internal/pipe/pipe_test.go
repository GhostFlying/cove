package pipe

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// pairs returns a connected Unix pair (local side) and TCP pair (remote
// side), the transports serve joins.
func pairs(t *testing.T) (localNear, localFar, remoteNear, remoteFar net.Conn) {
	t.Helper()
	// A short directory: Unix socket paths are limited to about 103 bytes and
	// t.TempDir is long on macOS.
	dir, err := os.MkdirTemp("/tmp", "cpj")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	ul, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	defer ul.Close()
	tl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tl.Close()
	accept := func(ln net.Listener) chan net.Conn {
		ch := make(chan net.Conn, 1)
		go func() {
			c, err := ln.Accept()
			if err != nil {
				t.Error(err)
			}
			ch <- c
		}()
		return ch
	}
	uch, tch := accept(ul), accept(tl)
	localFar, err = net.Dial("unix", ul.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	remoteFar, err = net.Dial("tcp", tl.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	localNear, remoteNear = <-uch, <-tch
	t.Cleanup(func() {
		for _, c := range []net.Conn{localNear, localFar, remoteNear, remoteFar} {
			c.Close()
		}
	})
	return
}

func joined(a, b net.Conn, grace time.Duration) chan struct{} {
	done := make(chan struct{})
	go func() {
		Join(a, a, b, grace)
		close(done)
	}()
	return done
}

func waitDone(t *testing.T, done chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("Join did not return within %v", within)
	}
}

// The local side hangs up while the remote peer keeps its send side open
// and silent: Join must still return, releasing the connection.
func TestLocalCloseEndsSilentRemoteWithinGrace(t *testing.T) {
	localNear, localFar, remoteNear, remoteFar := pairs(t)
	done := joined(localNear, remoteNear, 200*time.Millisecond)
	localFar.Close()
	// The peer sees EOF on its read side immediately.
	remoteFar.SetReadDeadline(time.Now().Add(5 * time.Second))
	if b, err := io.ReadAll(remoteFar); err != nil || len(b) != 0 {
		t.Fatalf("peer read: %q %v", b, err)
	}
	waitDone(t, done, 5*time.Second)
}

// Within the grace period the remote peer may still finish its request.
func TestLocalHalfCloseStillDeliversRemoteBytesWithinGrace(t *testing.T) {
	localNear, localFar, remoteNear, remoteFar := pairs(t)
	done := joined(localNear, remoteNear, 5*time.Second)
	localFar.(*net.UnixConn).CloseWrite()
	if _, err := remoteFar.Write([]byte("late")); err != nil {
		t.Fatal(err)
	}
	remoteFar.(*net.TCPConn).CloseWrite()
	localFar.SetReadDeadline(time.Now().Add(5 * time.Second))
	if b, err := io.ReadAll(localFar); err != nil || string(b) != "late" {
		t.Fatalf("local read: %q %v", b, err)
	}
	waitDone(t, done, 5*time.Second)
}

// A remote half-close is unbounded: the local side may answer at leisure.
func TestRemoteHalfCloseKeepsLocalSideOpen(t *testing.T) {
	localNear, localFar, remoteNear, remoteFar := pairs(t)
	done := joined(localNear, remoteNear, 50*time.Millisecond)
	remoteFar.Write([]byte("request"))
	remoteFar.(*net.TCPConn).CloseWrite()
	got := make([]byte, 7)
	if _, err := io.ReadFull(localFar, got); err != nil || string(got) != "request" {
		t.Fatalf("local read: %q %v", got, err)
	}
	time.Sleep(200 * time.Millisecond) // well past grace
	if _, err := localFar.Write([]byte("response")); err != nil {
		t.Fatal(err)
	}
	localFar.Close()
	remoteFar.SetReadDeadline(time.Now().Add(5 * time.Second))
	if b, err := io.ReadAll(remoteFar); err != nil || string(b) != "response" {
		t.Fatalf("peer read: %q %v", b, err)
	}
	waitDone(t, done, 5*time.Second)
}

// The grace is an inactivity bound, not a deadline: after the local side
// half-closes, a peer that keeps sending keeps the stream well past the
// grace, and only silence ends it.
func TestLocalHalfCloseKeepsAnActivePeerPastGrace(t *testing.T) {
	localNear, localFar, remoteNear, remoteFar := pairs(t)
	const grace = 200 * time.Millisecond
	done := joined(localNear, remoteNear, grace)
	localFar.(*net.UnixConn).CloseWrite()
	go func() {
		for range 10 { // 10 × 100 ms: five graces of streaming
			remoteFar.Write([]byte("chunk"))
			time.Sleep(grace / 2)
		}
		remoteFar.(*net.TCPConn).CloseWrite()
	}()
	localFar.SetReadDeadline(time.Now().Add(10 * time.Second))
	b, err := io.ReadAll(localFar)
	if err != nil || len(b) != 10*len("chunk") {
		t.Fatalf("local read %d bytes: %v", len(b), err)
	}
	waitDone(t, done, 5*time.Second)
}
