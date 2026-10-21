// Package pipe joins two byte streams.
package pipe

import (
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
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
// is positive, b is held to an inactivity bound: each read from b must
// arrive within grace of the previous one (or of a's EOF), or both are
// closed. Otherwise a remote peer that never sends again would pin the
// connection after the local side has hung up (for serve, that is an
// unauthenticated tailnet peer holding the forwarding budget), while a peer
// still streaming its half keeps going for as long as it sends. When b
// finishes first, a is trusted and unbounded. Closing either connection
// from outside, or a read or write error, ends both directions.
func Join(a net.Conn, aReader io.Reader, b net.Conn, grace time.Duration) {
	var wg sync.WaitGroup
	wg.Add(2)
	teardown := func() {
		a.Close()
		b.Close()
	}
	// bounded is set once a has finished; from then on every read from b
	// pushes b's read deadline grace into the future.
	var bounded atomic.Bool
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
			bounded.Store(true)
			// Unblocks the b→a copy below with a timeout error, which tears
			// both connections down, unless b sends again in time.
			b.SetReadDeadline(time.Now().Add(grace))
		}
	}()
	go func() {
		defer wg.Done()
		err := copyFrom(a, b, func() {
			if bounded.Load() {
				b.SetReadDeadline(time.Now().Add(grace))
			}
		})
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

// copyFrom copies src to dst like io.Copy, calling onRead after each read
// that returned data. It returns nil at EOF.
func copyFrom(dst io.Writer, src io.Reader, onRead func()) error {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			onRead()
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
