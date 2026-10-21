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
	"strings"
	"time"
	"unicode/utf8"
)

// Version is the local socket protocol version. Two peers are compatible
// exactly when their versions are equal.
const Version = 1

// MaxFrameBytes bounds one frame in either direction, excluding the '\n'.
// Inbound it keeps a misbehaving local client from growing the daemon's
// memory; outbound the field bounds below guarantee that every response
// fits (proto_test.go serializes the worst cases), and WriteFrame enforces
// it regardless.
const MaxFrameBytes = 64 << 10

// Field bounds. encoding/json can expand one input byte to six output bytes
// (backslash-u003c for '<', backslash-ufffd for invalid UTF-8), so the
// worst-case sizes use that factor.
const (
	// MaxIDBytes bounds a request ID, which every response echoes.
	MaxIDBytes = 64
	// MaxStreams bounds concurrent dial streams. Each CLI command uses one,
	// so this is far above real use.
	MaxStreams = 64
	// MaxLabelBytes bounds a stream label supplied by the CLI.
	MaxLabelBytes = 64
	// MaxNodeIDBytes bounds a stable node ID; Tailscale's are short and
	// alphanumeric.
	MaxNodeIDBytes = 64
	// MaxBuildBytes bounds a build identifier.
	MaxBuildBytes = 128
	// MaxTextBytes bounds each control-plane-supplied string (node names,
	// login names, the login URL) and each error message or warning, which
	// may quote third-party text.
	MaxTextBytes = 512
	// MaxIPs bounds the addresses reported for one node.
	MaxIPs = 8
	// MaxWarnings bounds Status.Warnings.
	MaxWarnings = 4
	// MaxPorts bounds the serve listener set.
	MaxPorts = 16
)

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

// Errorf builds an *Error. The message is truncated to MaxTextBytes because
// it may quote third-party text such as a control-plane error.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: Truncate(fmt.Sprintf(format, args...))}
}

// Truncate bounds s to MaxTextBytes without splitting a UTF-8 sequence.
func Truncate(s string) string { return truncateTo(s, MaxTextBytes) }

func truncateTo(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// ValidNodeID reports whether id is a plausible stable node ID: 1 to
// MaxNodeIDBytes ASCII letters and digits.
func ValidNodeID(id string) bool {
	return id != "" && len(id) <= MaxNodeIDBytes && onlyChars(id, "")
}

// ValidBuild reports whether b is a build identifier: 1 to MaxBuildBytes
// characters from [A-Za-z0-9.+_-]. The restriction keeps it one safe token
// in -ldflags, argv, logs and JSON.
func ValidBuild(b string) bool {
	return b != "" && len(b) <= MaxBuildBytes && onlyChars(b, ".+_-")
}

func onlyChars(s, extra string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' ||
			strings.IndexByte(extra, c) >= 0) {
			return false
		}
	}
	return true
}

// Timeout converts a request's timeoutMs to a duration: def when unset or
// non-positive, at most limit. It compares before multiplying so a huge
// value cannot overflow into a negative or tiny duration.
func Timeout(ms int, def, limit time.Duration) time.Duration {
	if ms <= 0 {
		return def
	}
	if int64(ms) >= int64(limit/time.Millisecond) {
		return limit
	}
	return time.Duration(ms) * time.Millisecond
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

// Bounded returns n with its untrusted strings cut to the documented bounds
// and at most MaxIPs addresses.
func (n NodeInfo) Bounded() NodeInfo {
	n.StableNodeID = truncateTo(n.StableNodeID, MaxNodeIDBytes)
	n.Name = Truncate(n.Name)
	n.HostName = Truncate(n.HostName)
	n.LoginName = Truncate(n.LoginName)
	if len(n.TailscaleIPs) > MaxIPs {
		n.TailscaleIPs = n.TailscaleIPs[:MaxIPs]
	}
	for i, ip := range n.TailscaleIPs {
		n.TailscaleIPs[i] = truncateTo(ip, 64)
	}
	return n
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
	// RemoteLogoutConfirmed is set only in logout results. false means the
	// local state was deleted but the control plane did not confirm the
	// logout, so the node may still be listed in the tailnet.
	RemoteLogoutConfirmed *bool `json:"remoteLogoutConfirmed,omitempty"`
}

// Bounded returns st with every control-plane-supplied or free-text field
// cut to the documented bounds, so a status always fits in one frame.
func (st Status) Bounded() Status {
	st.State = truncateTo(st.State, 64)
	st.AuthURL = Truncate(st.AuthURL)
	if st.Self != nil {
		self := st.Self.Bounded()
		st.Self = &self
	}
	if len(st.Warnings) > MaxWarnings {
		st.Warnings = st.Warnings[:MaxWarnings]
	}
	for i, w := range st.Warnings {
		st.Warnings[i] = Truncate(w)
	}
	return st
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

// ReadRequest reads and decodes one request frame. Framing errors
// (ErrFrameTooLarge, io.EOF, io.ErrUnexpectedEOF, I/O errors) are returned
// as is; a complete frame that is not a valid request yields a
// BAD_REQUEST *Error and leaves the stream at the next frame.
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
	if len(req.ID) > MaxIDBytes {
		req.ID = truncateTo(req.ID, MaxIDBytes)
		return req, Errorf(CodeBadRequest, "id exceeds %d bytes", MaxIDBytes)
	}
	if req.Op == "" {
		return req, Errorf(CodeBadRequest, "request has no op")
	}
	return req, nil
}

// WriteFrame encodes v as one JSON line. It writes nothing and returns
// ErrFrameTooLarge if the encoding exceeds MaxFrameBytes, so a peer never
// receives a frame it would have to reject.
func WriteFrame(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > MaxFrameBytes {
		return ErrFrameTooLarge
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// WriteResponse writes resp, or a small INTERNAL error in its place if it
// would exceed the frame limit. The field bounds make the fallback
// unreachable; it keeps the outbound limit an enforced invariant.
func WriteResponse(w io.Writer, resp Response) error {
	err := WriteFrame(w, resp)
	if errors.Is(err, ErrFrameTooLarge) {
		return WriteFrame(w, Response{ID: resp.ID, OK: false,
			Error: Errorf(CodeInternal, "response exceeds %d bytes", MaxFrameBytes)})
	}
	return err
}

// Fail builds a failed response for req. A framing error from ReadRequest
// becomes BAD_REQUEST.
func Fail(req Request, err error) Response {
	var pe *Error
	switch {
	case errors.As(err, &pe):
	case errors.Is(err, ErrFrameTooLarge):
		pe = Errorf(CodeBadRequest, "frame exceeds %d bytes", MaxFrameBytes)
	default:
		pe = Errorf(CodeInternal, "%v", err)
	}
	if len(pe.Streams) > MaxStreams {
		pe.Streams = pe.Streams[:MaxStreams]
	}
	return Response{ID: req.ID, OK: false, Error: pe}
}

// Succeed builds a successful response for req.
func Succeed(req Request, result any) Response {
	return Response{ID: req.ID, OK: true, Result: result}
}
