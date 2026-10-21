// Package proto defines the local framing shared by both cove-tsnet modes.
//
// The specification lives in native/tailscale/PROTOCOL.md; keep the two in
// sync. Frames are single-line JSON objects terminated by '\n'. The hello
// exchange and the stop request are frozen across protocol versions so that a
// client of any version can identify, list and replace a daemon of any other
// version (D14).
package proto

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Version is the local socket protocol version. Two peers are compatible
// exactly when their versions are equal.
const Version = 1

// MaxFrameBytes bounds one control frame. It comfortably fits an auth key and
// a list of streams while keeping a misbehaving local client from growing the
// daemon's memory without bound.
const MaxFrameBytes = 64 << 10

// Operation names.
const (
	OpHello    = "hello"
	OpStatus   = "status"
	OpLogin    = "login"
	OpLogout   = "logout"
	OpStop     = "stop"
	OpDial     = "dial"
	OpSetPorts = "setPorts"
)

// Error codes. They are stable identifiers; messages are for humans.
const (
	CodeBadRequest       = "BAD_REQUEST"
	CodeProtocolMismatch = "PROTOCOL_MISMATCH"
	CodeNotLoggedIn      = "NOT_LOGGED_IN"
	CodeAlreadyLoggedIn  = "ALREADY_LOGGED_IN"
	CodeLoginFailed      = "LOGIN_FAILED"
	CodeLoginTimeout     = "LOGIN_TIMEOUT"
	CodeNodeUnavailable  = "NODE_UNAVAILABLE"
	CodePeerNotFound     = "PEER_NOT_FOUND"
	CodePeerMismatch     = "PEER_MISMATCH"
	CodeDialFailed       = "DIAL_FAILED"
	CodeActiveStreams    = "ACTIVE_STREAMS"
	CodeTooManyStreams   = "TOO_MANY_STREAMS"
	CodeShuttingDown     = "SHUTTING_DOWN"
	CodeListenFailed     = "LISTEN_FAILED"
	CodeInternal         = "INTERNAL"
)

// Request is a client-to-daemon frame. Fields that an operation does not use
// are omitted.
type Request struct {
	// ID correlates responses on the multiplexed serve control channel. The
	// dial socket carries one request per connection and may leave it empty.
	ID       string `json:"id,omitempty"`
	Op       string `json:"op"`
	Protocol int    `json:"protocol,omitempty"`
	Build    string `json:"build,omitempty"`
	// AuthKey is a secret. It must never be logged, echoed or persisted; see
	// Request.String.
	AuthKey   string  `json:"authKey,omitempty"`
	TimeoutMs int     `json:"timeoutMs,omitempty"`
	Force     bool    `json:"force,omitempty"`
	Target    *Target `json:"target,omitempty"`
	Port      int     `json:"port,omitempty"`
	Ports     []int   `json:"ports,omitempty"`
	Label     string  `json:"label,omitempty"`
}

// String never includes the auth key, so an accidental %v cannot leak it.
func (r Request) String() string {
	return fmt.Sprintf("request{id=%q op=%q}", r.ID, r.Op)
}

// GoString keeps %#v from printing the auth key as well.
func (r Request) GoString() string { return r.String() }

// Target names the peer a dial stream must reach. Only the stable node ID is
// trusted; a MagicDNS name can be taken over by another node.
type Target struct {
	StableNodeID string `json:"stableNodeID"`
}

// Response is a daemon-to-client frame answering one Request.
type Response struct {
	ID     string `json:"id,omitempty"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

// Error describes a failed request.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Streams lists the active streams for ACTIVE_STREAMS.
	Streams []StreamInfo `json:"streams,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errorf builds an *Error.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Hello is the frozen result of the hello operation.
type Hello struct {
	Protocol int          `json:"protocol"`
	Build    string       `json:"build"`
	Mode     string       `json:"mode"`
	PID      int          `json:"pid"`
	Streams  []StreamInfo `json:"streams"`
}

// StreamInfo describes one active dial stream.
type StreamInfo struct {
	ID           string `json:"id"`
	StableNodeID string `json:"stableNodeID"`
	Port         int    `json:"port"`
	Label        string `json:"label,omitempty"`
	StartedAt    string `json:"startedAt"`
}

// NodeInfo identifies a tailnet node. Names come from the control plane and
// are untrusted display data; StableNodeID is the identity.
type NodeInfo struct {
	StableNodeID string   `json:"stableNodeID"`
	Name         string   `json:"name,omitempty"`
	HostName     string   `json:"hostName,omitempty"`
	LoginName    string   `json:"loginName,omitempty"`
	TailscaleIPs []string `json:"tailscaleIPs,omitempty"`
}

// Node backend states reported in Status.State.
const (
	StateNoState     = "NoState"
	StateNeedsLogin  = "NeedsLogin"
	StateStarting    = "Starting"
	StateRunning     = "Running"
	StateStopped     = "Stopped"
	StateNeedsAuth   = "NeedsMachineAuth"
	StateLoggedOut   = "LoggedOut"
	StateUnavailable = "Unavailable"
)

// Status is the result of status, login and logout.
type Status struct {
	// State is a tailscale ipn.State name, or LoggedOut when no node state
	// exists and no node is running.
	State string `json:"state"`
	// AuthURL is set while an interactive login is pending. Whoever opens it
	// can attach this node to their tailnet, so it is only ever returned to
	// the requesting owner and never logged.
	AuthURL string    `json:"authURL,omitempty"`
	Self    *NodeInfo `json:"self,omitempty"`
	// Ports lists the serve-mode tailnet listeners.
	Ports []int `json:"ports,omitempty"`
	// Streams lists the dial-mode active streams.
	Streams []StreamInfo `json:"streams,omitempty"`
	// Warnings are human-readable notes, e.g. a logout the control plane
	// could not confirm.
	Warnings []string `json:"warnings,omitempty"`
}

// DialResult is the result of a successful dial; raw stream bytes follow it.
type DialResult struct {
	StreamID string   `json:"streamId"`
	Peer     NodeInfo `json:"peer"`
}

// ForwardHeader precedes the bytes of each tailnet connection serve hands to
// the forward socket. Peer is display and audit data only, never
// authorization; it is nil when WhoIs failed.
type ForwardHeader struct {
	Protocol   int       `json:"protocol"`
	Port       int       `json:"port"`
	RemoteAddr string    `json:"remoteAddr"`
	Peer       *NodeInfo `json:"peer"`
	WhoIsError string    `json:"whoIsError,omitempty"`
}

// ErrFrameTooLarge reports a frame longer than the limit.
var ErrFrameTooLarge = errors.New("frame exceeds size limit")

// ReadFrame reads one '\n'-terminated frame of at most limit bytes, excluding
// the terminator. Bytes after the frame stay buffered in r, which matters
// when a raw stream follows the frame.
func ReadFrame(r *bufio.Reader, limit int) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(buf)+len(chunk) > limit+1 {
			return nil, ErrFrameTooLarge
		}
		buf = append(buf, chunk...)
		switch {
		case err == nil:
			return bytes.TrimSuffix(buf[:len(buf)-1], []byte{'\r'}), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(buf) > 0:
			return nil, io.ErrUnexpectedEOF
		default:
			return nil, err
		}
	}
}

// ReadRequest reads and decodes one request frame.
func ReadRequest(r *bufio.Reader) (Request, error) {
	var req Request
	line, err := ReadFrame(r, MaxFrameBytes)
	if err != nil {
		return req, err
	}
	if err := json.Unmarshal(line, &req); err != nil {
		// The decode error may quote the frame, which can hold an auth key.
		return Request{}, Errorf(CodeBadRequest, "request is not a JSON object")
	}
	if req.Op == "" {
		return req, Errorf(CodeBadRequest, "request has no op")
	}
	return req, nil
}

// WriteFrame encodes v as one JSON line.
func WriteFrame(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// Fail builds a failed response for req.
func Fail(req Request, err error) Response {
	var pe *Error
	if !errors.As(err, &pe) {
		pe = Errorf(CodeInternal, "%v", err)
	}
	return Response{ID: req.ID, OK: false, Error: pe}
}

// Succeed builds a successful response for req.
func Succeed(req Request, result any) Response {
	return Response{ID: req.ID, OK: true, Result: result}
}
