// Package pipe joins two byte streams.
package pipe

import (
	"io"
	"net"
	"sync"
	"time"
)

type closeWriter interface{ CloseWrite() error }

// Join copies a→b and b→a until both directions finish, then closes both
// connections. a is the trusted local side (the Cove server or CLI), b the
// remote side. aReader is read instead of a so bytes already buffered while
// parsing a leading frame are not lost.
//
// When one direction reaches EOF, the write side of the other connection is
// half-closed, so request-then-EOF protocols keep working. A read cannot
// tell a half-close from a full close, so when a finishes first and grace
// is positive, b must finish its direction within grace or both are closed:
// otherwise a remote peer that never sends again would pin the connection
// after the local side has hung up (for serve, that is an unauthenticated
// tailnet peer holding the forwarding budget). When b finishes first, a is
// trusted and unbounded. Closing either connection from outside, or a write
// error, ends both directions.
func Join(a net.Conn, aReader io.Reader, b net.Conn, grace time.Duration) {
	var wg sync.WaitGroup
	wg.Add(2)
	teardown := func() {
		a.Close()
		b.Close()
	}
	go func() {
		defer wg.Done()
		_, err := io.Copy(b, aReader)
		cw, ok := b.(closeWriter)
		if err != nil || !ok {
			teardown()
			return
		}
		cw.CloseWrite()
		if grace > 0 {
			// Unblocks the b→a copy below with a timeout error, which tears
			// both connections down.
			b.SetReadDeadline(time.Now().Add(grace))
		}
	}()
	go func() {
		defer wg.Done()
		_, err := io.Copy(a, b)
		cw, ok := a.(closeWriter)
		if err != nil || !ok {
			teardown()
			return
		}
		cw.CloseWrite()
	}()
	wg.Wait()
	teardown()
}
