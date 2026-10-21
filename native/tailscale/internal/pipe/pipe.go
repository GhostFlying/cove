// Package pipe joins two byte streams.
package pipe

import (
	"io"
	"net"
	"sync"
)

type closeWriter interface{ CloseWrite() error }

// Join copies a→b and b→a until both directions finish, then closes both
// connections. aReader is read instead of a so bytes already buffered while
// parsing a leading frame are not lost. When one direction reaches EOF the
// write side of the other connection is half-closed, so protocols that rely
// on half-close (request then EOF) keep working. Closing either connection
// from outside ends both directions.
func Join(a net.Conn, aReader io.Reader, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	half := func(dst net.Conn, src io.Reader) {
		defer wg.Done()
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok && err == nil {
			cw.CloseWrite()
			return
		}
		// Without half-close support, or after an error, tear both down so
		// the other direction does not wait forever.
		a.Close()
		b.Close()
	}
	go half(b, aReader)
	go half(a, b)
	wg.Wait()
	a.Close()
	b.Close()
}
