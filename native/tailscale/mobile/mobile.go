// Package mobile embeds Cove's tsnet client in an application. The exported
// surface uses gomobile-compatible values; it is private to the native adapter,
// not a new Cove network protocol or a replacement terminal model.
package mobile

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fsutil"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

const (
	maxOperations   = 32
	maxEvents       = 64
	maxEventBytes   = 4 << 20
	maxHTTPBytes    = 256 << 10
	maxRequestBytes = 64 << 10
	// Match the client's transport read budget. This accommodates a complete
	// terminal frame and the business socket's larger messages; each domain
	// still validates its own schema/frame bounds above this raw transport.
	maxSocketMessageBytes   = 256 << 10
	maxSocketQueuedBytes    = 1 << 20
	maxSocketQueuedMessages = 128
	dialTimeout             = 15 * time.Second
)

const (
	notSent   = "not-sent"
	handedOff = "handed-off"
	unknown   = "unknown"
)

// Client owns exactly one app-private node and its native transport handles.
// Manager mutations are serialized independently of operation admission, so
// cancellation never waits for a control-plane request or a blocked event pull.
type Client struct {
	mu         sync.Mutex
	control    sync.Mutex
	mgr        *node.Manager
	life       context.Context
	stop       context.CancelFunc
	closed     bool
	mutating   bool
	generation int64
	closeDone  chan struct{}
	ops        map[int64]*operation
	lastID     int64
	events     []string
	eventBytes int
	changed    chan struct{}
	pulling    bool
	wg         sync.WaitGroup
	ownedLock  *os.File
}

type operation struct {
	id          int64
	entry       *Entry
	ctx         context.Context
	cancel      context.CancelFunc
	disposition string
	done        bool
	cancelled   bool
	socket      bool
	outbound    chan socketMessage
	queuedBytes int
}

type event struct {
	ID          int64             `json:"id"`
	Type        string            `json:"type"`
	Disposition string            `json:"disposition,omitempty"`
	Status      int               `json:"status,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Body        []byte            `json:"body,omitempty"`
	Reason      string            `json:"reason,omitempty"`
}

// New restores an enrolled node, but a fresh app does not contact a control
// plane until Login is requested. stateDirectory must be the application's own
// native, backup-excluded directory; never pass a shared system Tailscale path.
// Call this and all control methods on a native background executor.
func New(stateDirectory, hostname, controlURL string) (*Client, error) {
	if stateDirectory == "" || hostname == "" || len(hostname) > 253 {
		return nil, errors.New("state directory and bounded hostname required")
	}
	// The lock is outside the state subtree that Logout removes. JS/native
	// reloads must wait for the previous owner rather than concurrently opening
	// one enrollment; a process crash releases the kernel lock automatically.
	if err := fsutil.EnsurePrivateDir(stateDirectory); err != nil {
		return nil, err
	}
	lock, err := fsutil.Lock(filepath.Join(stateDirectory, "node.lock"))
	if err != nil {
		return nil, err
	}
	controlURL = strings.TrimSpace(controlURL)
	if err := bindControl(stateDirectory, controlURL); err != nil {
		lock.Close()
		return nil, err
	}
	if runtime.GOOS == "android" || runtime.GOOS == "ios" {
		if err := configureMobileLogs(stateDirectory); err != nil {
			lock.Close()
			return nil, err
		}
	}
	mgr := node.NewManager(node.Config{StateDir: filepath.Join(stateDirectory, "state"), Hostname: hostname, ControlURL: controlURL}, node.StartTSNet)
	c := newClient(mgr)
	c.ownedLock = lock
	mgr.Boot()
	return c, nil
}

// configureMobileLogs supplies Tailscale's logpolicy fallback explicitly. A
// mobile sandbox has no usable system state directory, HOME/cache or /tmp; even
// with backend logging disabled, tsnet constructs a socket-statistics logger and
// LogsDir otherwise panics. This private library lives in the app process and its
// native wrappers drain one fixed-root node before opening its successor. The
// dependency exposes this directory only through its process environment; never
// change the host's HOME or use a system Tailscale directory for this purpose.
func configureMobileLogs(root string) error {
	logs := filepath.Join(root, "logs")
	if err := fsutil.EnsurePrivateDir(logs); err != nil {
		return err
	}
	return os.Setenv("TS_LOGS_DIR", logs)
}

// bindControl runs under this root's lifetime lock and before Boot can restore
// an enrollment. tsnet applies its configured ControlURL even when restoring
// state; a nonpersistent fixture selection must therefore never silently send
// that enrollment to the default (or another) control plane after app restart.
// The marker records only a digest, not a URL that might contain private data.
func bindControl(root, controlURL string) error {
	if len(controlURL) > 2048 {
		return errors.New("bounded native control URL required")
	}
	if controlURL != "" {
		u, err := url.Parse(controlURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("native control URL must be an HTTP(S) endpoint without credentials")
		}
	}
	digest := sha256.Sum256([]byte(controlURL))
	expected := fmt.Sprintf("v1:%x\n", digest)
	marker := filepath.Join(root, "control.binding")
	_, stateErr := os.Stat(filepath.Join(root, "state", "tailscaled.state"))
	if stateErr == nil {
		stored, err := os.ReadFile(marker)
		if err != nil || string(stored) != expected {
			return errors.New("enrolled native node requires its original control URL; no restore was started")
		}
		return nil
	}
	if !errors.Is(stateErr, os.ErrNotExist) {
		return stateErr
	}
	// Publish and durably flush the binding before Manager can create any node
	// state. A crash before this completes cannot leave a new enrollment; a
	// crash afterwards retains the marker across process restart. Logout removes
	// only state/, so with no enrollment a later explicit choice may replace it.
	f, err := os.CreateTemp(root, ".control-binding-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(expected); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(f.Name(), marker); err != nil {
		return err
	}
	directory, err := os.Open(root)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func newClient(mgr *node.Manager) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{mgr: mgr, life: ctx, stop: cancel, ops: make(map[int64]*operation), changed: make(chan struct{}), generation: 1, closeDone: make(chan struct{})}
}

// StatusJSON returns bounded node status. Login URLs are intentional secrets:
// the host may display/open them but must never include this result in logs.
func (c *Client) StatusJSON() (string, error) {
	c.control.Lock()
	defer c.control.Unlock()
	if err := c.life.Err(); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(c.life, 5*time.Second)
	defer cancel()
	st, err := c.mgr.Status(ctx)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(st)
	return string(data), err
}

// Login uses the existing identity-hold semantics. It never retries a failed
// login or assumes a timeout proves that the enrollment did not change.
func (c *Client) Login(authKey string) (string, error) {
	c.control.Lock()
	defer c.control.Unlock()
	if err := c.life.Err(); err != nil {
		return "", err
	}
	c.beginMutation()
	defer c.endMutation()
	st, err := c.mgr.Login(c.life, authKey, time.Minute)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(st)
	return string(data), err
}

// Logout cancels active traffic and removes this app's node enrollment. It is
// distinct from Close, which keeps enrollment, and forgetting a Cove token.
func (c *Client) Logout() (string, error) {
	c.control.Lock()
	defer c.control.Unlock()
	if err := c.life.Err(); err != nil {
		return "", err
	}
	c.beginMutation()
	defer c.endMutation()
	st, err := c.mgr.Logout(c.life, 10*time.Second)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(st)
	return string(data), err
}

// Entry pins one server node and port. Creating it performs no network I/O.
// Each actual HTTP/WS connection independently checks WhoIs before any bytes
// are sent, including pooled/reconnected requests (pooling is disabled).
type Entry struct {
	client     *Client
	peerID     string
	port       int
	generation int64
	closed     bool // guarded by client.mu
}

func (c *Client) OpenEntry(stableNodeID string, port int) (*Entry, error) {
	if stableNodeID == "" || len(stableNodeID) > proto.MaxNodeIDBytes || port < 1 || port > 65535 {
		return nil, errors.New("invalid stable node identity or port")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.mutating {
		return nil, errors.New("native client unavailable")
	}
	return &Entry{client: c, peerID: stableNodeID, port: port, generation: c.generation}, nil
}

func (e *Entry) dial(ctx context.Context) (net.Conn, error) {
	c := e.client
	c.control.Lock()
	c.mu.Lock()
	current := !c.closed && !e.closed && !c.mutating && c.generation == e.generation
	c.mu.Unlock()
	if !current {
		c.control.Unlock()
		return nil, errors.New("native entry expired")
	}
	n, err := c.mgr.Running(ctx, dialTimeout)
	c.control.Unlock()
	if err != nil {
		return nil, err
	}
	_, ip, err := n.LookupPeer(ctx, e.peerID)
	if err != nil {
		return nil, err
	}
	conn, err := n.Dial(ctx, net.JoinHostPort(ip, strconv.Itoa(e.port)))
	if err != nil {
		return nil, err
	}
	who, err := n.WhoIs(ctx, conn.RemoteAddr().String())
	if err != nil || who.StableNodeID != e.peerID {
		conn.Close()
		return nil, errors.New("native entry peer verification failed")
	}
	return conn, nil
}

func (e *Entry) admit(id int64, socket bool) (*operation, error) {
	c := e.client
	c.mu.Lock()
	defer c.mu.Unlock()
	if id <= c.lastID || id > 9007199254740991 || c.closed || c.mutating || e.closed || c.generation != e.generation || len(c.ops) >= maxOperations {
		return nil, errors.New("native operation not admitted")
	}
	ctx, cancel := context.WithCancel(c.life)
	op := &operation{id: id, entry: e, ctx: ctx, cancel: cancel, disposition: notSent, socket: socket}
	if socket {
		op.outbound = make(chan socketMessage, maxSocketQueuedMessages)
	}
	c.ops[id] = op
	c.lastID = id
	c.wg.Add(1)
	return op, nil
}

func (c *Client) mark(op *operation, disposition string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !op.done && (op.disposition != handedOff || disposition == handedOff) {
		op.disposition = disposition
	}
}

// willWrite and Cancel share a lock: a cancellation classified not-sent must
// prevent a later first Write even when net/http's writer was already runnable.
func (c *Client) willWrite(op *operation) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || op.done || op.cancelled || op.ctx.Err() != nil || op.entry.closed || c.generation != op.entry.generation {
		return context.Canceled
	}
	if op.disposition == notSent {
		op.disposition = unknown
	}
	return nil
}

// Cancel only marks/cancels in-memory state; it never performs socket or file
// I/O on the JS thread. The operation's executor owns actual teardown.
func (c *Client) Cancel(id int64) string {
	c.mu.Lock()
	op := c.ops[id]
	if op == nil {
		c.mu.Unlock()
		return notSent
	}
	op.cancelled = true
	disposition := op.disposition
	c.mu.Unlock()
	op.cancel()
	return disposition
}

// Release drops a completed handle after the host consumed its terminal event.
// IDs must not be reused during one Client's lifetime.
func (c *Client) Release(id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op := c.ops[id]; op != nil && op.done {
		delete(c.ops, id)
	}
}

func (c *Client) finish(op *operation, ev event) {
	c.mu.Lock()
	if op.done {
		c.mu.Unlock()
		return
	}
	op.done = true
	ev.Disposition = op.disposition
	c.mu.Unlock()
	c.emit(ev)
}

func (c *Client) signalLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// emit backpressures Go producers. Only one NextEvent result can be outstanding
// across the native bridge, so queued data cannot migrate into an unbounded
// Expo event backlog while the JS runtime is suspended.
func (c *Client) emit(ev event) {
	data, err := json.Marshal(ev)
	if err != nil || len(data) > maxEventBytes {
		return
	}
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		if len(c.events) < maxEvents && c.eventBytes+len(data) <= maxEventBytes {
			c.events = append(c.events, string(data))
			c.eventBytes += len(data)
			c.signalLocked()
			c.mu.Unlock()
			return
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-c.life.Done():
			return
		case <-changed:
		}
	}
}

// NextEvent is a blocking native-background call with at most one consumer.
// Empty means the bounded wait expired; closed and concurrent pulls are errors.
// The app dispatches this one result before requesting another, and never logs
// its body (it can contain a pairing response or real terminal bytes).
func (c *Client) NextEvent(timeoutMilliseconds int) (string, error) {
	if timeoutMilliseconds < 1 || timeoutMilliseconds > 30000 {
		return "", errors.New("invalid event wait")
	}
	c.mu.Lock()
	if c.pulling {
		c.mu.Unlock()
		return "", errors.New("native event consumer already active")
	}
	c.pulling = true
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.pulling = false; c.mu.Unlock() }()
	timer := time.NewTimer(time.Duration(timeoutMilliseconds) * time.Millisecond)
	defer timer.Stop()
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return "", errors.New("native client closed")
		}
		if len(c.events) > 0 {
			data := c.events[0]
			c.events[0] = ""
			c.events = c.events[1:]
			c.eventBytes -= len(data)
			c.signalLocked()
			c.mu.Unlock()
			return data, nil
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-timer.C:
			return "", nil
		case <-changed:
		}
	}
}

func (c *Client) cancelOperations() {
	c.mu.Lock()
	var cancels []context.CancelFunc
	for _, op := range c.ops {
		if !op.done {
			op.cancelled = true
			cancels = append(cancels, op.cancel)
		}
	}
	c.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (c *Client) beginMutation() {
	c.mu.Lock()
	c.mutating = true
	c.generation++
	c.mu.Unlock()
	c.cancelOperations()
}

func (c *Client) endMutation() {
	c.mu.Lock()
	c.mutating = false
	c.mu.Unlock()
}

// Stop closes admission and wakes the pull without performing I/O. Native
// lifecycle hooks can call it immediately even when an asynchronous Login or
// NextEvent currently occupies their executor. Close waits for actual teardown.
func (c *Client) Stop() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.events = nil
	c.eventBytes = 0
	c.signalLocked()
	c.mu.Unlock()
	c.stop()
	go func() {
		c.wg.Wait()
		c.control.Lock()
		c.mgr.Close()
		c.control.Unlock()
		if c.ownedLock != nil {
			c.ownedLock.Close()
		}
		close(c.closeDone)
	}()
}

// Close is idempotent and belongs on a native background executor. It waits for
// all owned native operations and node shutdown, retaining enrollment.
func (c *Client) Close() {
	c.Stop()
	<-c.closeDone
}

func (e *Entry) Close() {
	c := e.client
	c.mu.Lock()
	e.closed = true
	var cancels []context.CancelFunc
	for _, op := range c.ops {
		if op.entry == e && !op.done {
			op.cancelled = true
			cancels = append(cancels, op.cancel)
		}
	}
	c.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func validPath(path string, socket bool) bool {
	if socket {
		return path == "/terminal" || path == "/events"
	}
	return path == "/bootstrap" || path == "/pair" || path == "/rpc"
}

func invalid(label string) error { return fmt.Errorf("invalid native %s", label) }
