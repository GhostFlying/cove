package mobile

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// writeObserver records the uncertainty boundary before Write: even a write
// returning an error may have delivered a prefix. Dial/WhoIs failures, in
// contrast, provably sent none of this HTTP request.
type writeObserver struct {
	net.Conn
	beforeWrite func() error
}

func (c *writeObserver) Write(data []byte) (int, error) {
	if err := c.beforeWrite(); err != nil {
		return 0, err
	}
	return c.Conn.Write(data)
}

func (e *Entry) transport(op *operation) *http.Transport {
	return &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 16 << 10,
		ResponseHeaderTimeout:  15 * time.Second,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			ctx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			conn, err := e.dial(ctx)
			if err != nil {
				return nil, err
			}
			return &writeObserver{Conn: conn, beforeWrite: func() error { return e.client.willWrite(op) }}, nil
		},
	}
}

func (e *Entry) origin() string { return "http://127.0.0.1:" + strconv.Itoa(e.port) }

func requestHeaders(raw string) (http.Header, error) {
	if len(raw) > 16<<10 {
		return nil, invalid("headers")
	}
	var input map[string]string
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return nil, invalid("headers")
	}
	headers := make(http.Header)
	for key, value := range input {
		switch strings.ToLower(key) {
		case "host", "connection", "upgrade", "content-length", "transfer-encoding", "trailer":
			return nil, invalid("headers")
		}
		headers.Set(key, value)
	}
	return headers, nil
}

// Post immediately admits a bounded request, then performs network I/O on Go
// executors. The host receives exactly one terminal response/failure event;
// cancellation settles the host locally and the event is still safe to drain.
func (e *Entry) Post(id int64, path, headersJSON string, body []byte, maxResponseBytes int) error {
	if !validPath(path, false) || len(body) > maxRequestBytes || maxResponseBytes < 1 || maxResponseBytes > maxHTTPBytes {
		return invalid("HTTP request")
	}
	headers, err := requestHeaders(headersJSON)
	if err != nil {
		return err
	}
	// gomobile does not promise the caller's byte slice remains immutable after
	// return; retain only an owned, bounded copy for asynchronous execution.
	ownedBody := bytes.Clone(body)
	op, err := e.admit(id, false)
	if err != nil {
		return err
	}
	go e.runPost(op, path, headers, ownedBody, maxResponseBytes)
	return nil
}

func (e *Entry) runPost(op *operation, path string, headers http.Header, body []byte, limit int) {
	c := e.client
	defer c.wg.Done()
	defer op.cancel()
	fail := func(reason string) { c.finish(op, event{ID: op.id, Type: "http-failure", Reason: reason}) }
	ctx, cancel := context.WithTimeout(op.ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.origin()+path, bytes.NewReader(body))
	if err != nil {
		fail("transport")
		return
	}
	req.Header = headers
	transport := e.transport(op)
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		fail("transport")
		return
	}
	defer res.Body.Close()
	c.mark(op, handedOff)
	// LimitReader's single extra byte distinguishes a complete legal body from
	// an oversized stream without ever buffering the rest of that stream.
	response, err := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
	if len(response) > limit {
		fail("response-too-large")
		return
	}
	if err != nil {
		fail("transport")
		return
	}
	outHeaders := make(map[string]string, len(res.Header))
	for key, values := range res.Header {
		outHeaders[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	c.finish(op, event{ID: op.id, Type: "http-response", Status: res.StatusCode, Headers: outHeaders, Body: response})
}
