package mobile

import (
	"bytes"
	"context"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

type socketMessage struct {
	kind websocket.MessageType
	data []byte
}

// OpenSocket admits a connection without credentials in the URL or handshake.
// The existing Client owns its protocol bootstrap/authentication frames.
func (e *Entry) OpenSocket(id int64, path string) error {
	if !validPath(path, true) {
		return invalid("WebSocket path")
	}
	op, err := e.admit(id, true)
	if err != nil {
		return err
	}
	go e.runSocket(op, path)
	return nil
}

// Send is bounded in-memory admission. handed-off means that the native writer
// owns these bytes, never that the server accepted or executed them. A socket
// that closes after admission leaves the remote effect unknown to its caller.
func (c *Client) Send(id int64, binary bool, data []byte) string {
	if len(data) > maxSocketMessageBytes || (!binary && !utf8.Valid(data)) {
		return notSent
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	op := c.ops[id]
	if op == nil || !op.socket || op.done || op.cancelled || op.ctx.Err() != nil || op.disposition != handedOff ||
		op.queuedBytes+len(data) > maxSocketQueuedBytes || len(op.outbound) >= maxSocketQueuedMessages {
		return notSent
	}
	kind := websocket.MessageText
	if binary {
		kind = websocket.MessageBinary
	}
	message := socketMessage{kind: kind, data: bytes.Clone(data)}
	// The channel has one writer under mu and its capacity was checked above.
	op.outbound <- message
	op.queuedBytes += len(data)
	return handedOff
}

func (e *Entry) runSocket(op *operation, path string) {
	c := e.client
	defer c.wg.Done()
	defer op.cancel()
	defer c.finish(op, event{ID: op.id, Type: "socket-close"})
	transport := e.transport(op)
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(op.ctx, dialTimeout)
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	conn, response, err := websocket.Dial(ctx, e.origin()+path, &websocket.DialOptions{HTTPClient: client})
	cancel()
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxSocketMessageBytes)
	c.mark(op, handedOff)
	c.emit(event{ID: op.id, Type: "socket-open"})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer op.cancel()
		for {
			select {
			case <-op.ctx.Done():
				return
			case message := <-op.outbound:
				ctx, cancel := context.WithTimeout(op.ctx, 15*time.Second)
				err := conn.Write(ctx, message.kind, message.data)
				cancel()
				c.mu.Lock()
				op.queuedBytes -= len(message.data)
				c.mu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()
	defer func() { op.cancel(); <-writerDone }()
	for {
		kind, data, err := conn.Read(op.ctx)
		if err != nil {
			return
		}
		name := "socket-text"
		if kind == websocket.MessageBinary {
			name = "socket-binary"
		}
		c.emit(event{ID: op.id, Type: name, Body: data})
	}
}
