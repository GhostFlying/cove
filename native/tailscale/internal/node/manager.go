package node

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fsutil"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// Manager owns the login lifecycle of the single node behind one state
// directory. It is not safe for concurrent mutation: callers serialize
// Boot, Login, Logout, Close and any Status while Held (the control mutex
// in both modes). Running, Held, and Status without a hold only read, so
// they may run concurrently with each other.
//
// Identity hold. Paired clients pin the server node's stable ID, so a login
// of an enrolled node that ends as another node (a key of another tailnet,
// say) breaks every pairing. The manager does not try to undo that: putting
// back tailscaled's earlier state cannot cover a crash, or a login the
// backend completes after the attempt timed out, and the clients' pinning
// already fails closed. Instead, from the moment a login of an enrolled
// node starts until the identity it ended as is known to be the enrolled
// one, the manager holds the node: Usable returns nil, so serve keeps its
// listeners closed and dial refuses streams, and Status reports the hold.
// An attempt that did not finish (error, timeout, cancel) stops the node,
// so nothing can complete later in this process; the next Status or Login
// settles the hold by restarting the node from its state and reading the
// persisted identity. A different identity stays held until a logout.
type Manager struct {
	cfg   Config
	start Starter
	node  Node
	// bootErr is why a node with persisted state is not running.
	bootErr error
	// hold is set while the node's identity is not known to be the
	// enrolled one; see the type comment.
	hold *hold
	// onHold, if set, runs whenever a hold is placed, before the login it
	// guards starts.
	onHold func()
}

// hold records why the node may not be used.
type hold struct {
	// enrolled is the stable ID the node was enrolled as.
	enrolled string
	// changed reports that the node was observed as current, another node;
	// only a logout ends that hold.
	changed bool
	current string
	// interactive marks an interactive login that may still complete; it
	// settles only once the node is Running as the enrolled identity.
	interactive bool
	// cause is the redacted error of an attempt that did not finish.
	cause string
}

// NewManager creates a manager; nothing starts until Boot or Login.
func NewManager(cfg Config, start Starter) *Manager {
	return &Manager{cfg: cfg, start: start}
}

// OnHold sets a function to run whenever the manager places a hold, under
// the caller's lock and before the guarded login starts. serve closes its
// listeners there, so the decision to stop accepting is the same decision
// that starts the login, not an earlier, separate observation.
func (m *Manager) OnHold(f func()) { m.onHold = f }

func (m *Manager) placeHold(h *hold) {
	m.hold = h
	if m.onHold != nil {
		m.onHold()
	}
}

// Boot starts the node from persisted state, if there is any. Without state
// it does nothing: a fresh node only contacts the control plane once the
// owner asks to log in.
func (m *Manager) Boot() {
	if !HasState(m.cfg.StateDir) {
		return
	}
	if err := fsutil.EnsurePrivateDir(m.cfg.StateDir); err != nil {
		m.bootErr = err
		return
	}
	n, err := m.start(m.cfg, "")
	if err != nil {
		m.bootErr = err
		return
	}
	m.node, m.bootErr = n, nil
}

// settle tries to end the hold by observing the node's identity. It
// returns the hold's error while the hold remains and nil once it is gone.
func (m *Manager) settle(ctx context.Context) *proto.Error {
	h := m.hold
	if h == nil {
		return nil
	}
	if h.changed {
		return m.holdError()
	}
	if m.node == nil {
		m.Boot()
		if m.node == nil {
			if m.bootErr != nil {
				h.cause = proto.Truncate("restarting the node to check its identity failed: " + m.bootErr.Error())
			}
			return m.holdError()
		}
	}
	if h.interactive {
		return m.settleInteractive(ctx)
	}
	id, err := m.node.StableID(ctx)
	if err != nil {
		h.cause = proto.Truncate("reading the node identity failed: " + err.Error())
		return m.holdError()
	}
	if id != h.enrolled {
		m.markChanged(id)
		return m.holdError()
	}
	m.hold = nil
	return nil
}

// settleInteractive settles the hold of an interactive login, which the
// backend may complete at any moment while the owner has the URL open. The
// identity and the Running state must therefore come from one and the same
// status observation: reading the identity first and the state afterwards
// (#155) lets a login that completes as another node in between pass as the
// enrolled node, Running. A login that has not completed reports the
// enrolled node, or no self at all, and keeps the hold.
func (m *Manager) settleInteractive(ctx context.Context) *proto.Error {
	h := m.hold
	st, err := m.node.Status(ctx)
	if err != nil {
		return m.holdError()
	}
	var id string
	if st.Self != nil {
		id = st.Self.StableNodeID
	}
	if id != "" && id != h.enrolled {
		m.markChanged(id)
		return m.holdError()
	}
	if st.State != proto.StateRunning || id != h.enrolled {
		return m.holdError()
	}
	m.hold = nil
	return nil
}

// markChanged turns the hold into IDENTITY_CHANGED for the observed id. The
// node is stopped, so a node of another tailnet does not stay connected
// there; its profile is still the persisted state, which a logout removes.
func (m *Manager) markChanged(id string) {
	m.closeNode()
	m.hold.changed, m.hold.current = true, id
}

// holdError describes the current hold.
func (m *Manager) holdError() *proto.Error {
	h := m.hold
	switch {
	case h.changed:
		cur := h.current
		if cur == "" {
			cur = "a node without identity"
		}
		return proto.Errorf(proto.CodeIdentityChanged,
			"the node is now %s, not the enrolled %s; it was stopped and serves nothing. Paired clients pin %s and "+
				"must pair again. To recover, log out, log in with the intended key, then pair the clients again",
			proto.Truncate(cur), h.enrolled, h.enrolled)
	case h.interactive:
		return proto.Errorf(proto.CodeLoginUncertain,
			"an interactive login of enrolled node %s is in progress; it serves nothing until it runs as %s again",
			h.enrolled, h.enrolled)
	}
	msg := fmt.Sprintf("a login of enrolled node %s did not finish and may still have completed as another node; "+
		"the node was stopped and serves nothing until its identity is confirmed (status or login checks it)", h.enrolled)
	if h.cause != "" {
		msg += ": " + h.cause
	}
	return proto.Errorf(proto.CodeLoginUncertain, "%s", msg)
}

// Status reports the node state. Without a node it reports LoggedOut, or
// Unavailable when persisted state exists but the node failed to start.
// While a hold remains, Status first tries to settle it and then reports it
// in Hold and the first warning, with the other identity, if observed, as
// Self.
func (m *Manager) Status(ctx context.Context) (proto.Status, error) {
	herr := m.settle(ctx)
	var st proto.Status
	switch {
	case m.node != nil:
		var err error
		if st, err = m.node.Status(ctx); err != nil {
			return st, err
		}
	case herr != nil:
		st = proto.Status{State: proto.StateUnavailable}
	case HasState(m.cfg.StateDir):
		msg := "node state exists but the node is not running"
		if m.bootErr != nil {
			msg = m.bootErr.Error()
		}
		st = proto.Status{State: proto.StateUnavailable, Warnings: []string{msg}}
	default:
		st = proto.Status{State: proto.StateLoggedOut}
	}
	if herr != nil {
		st.Hold = herr.Code
		st.Warnings = append([]string{herr.Message}, st.Warnings...)
		if m.hold.changed {
			st.Self = &proto.NodeInfo{StableNodeID: m.hold.current}
		}
	}
	return st.Bounded(), nil
}

// Login logs the node in.
//
// With authKey and no persisted state it starts a fresh node with the key
// and waits until it is Running; on failure the partial state is deleted,
// so no half-logged-in node remains. With authKey and persisted state (for
// example a node whose key expired) it forces a reauthentication of the
// existing node with the key, under an identity hold. Without authKey it
// starts an interactive login and returns as soon as the control plane
// provides the login URL; the owner then polls Status.
func (m *Manager) Login(ctx context.Context, authKey string, timeout time.Duration) (proto.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// An interactive login in progress may be replaced by another login;
	// any other hold must settle, or be ended by a logout, first.
	if herr := m.settle(ctx); herr != nil && (m.hold.changed || !m.hold.interactive) {
		return proto.Status{}, herr
	}
	if m.node != nil && m.hold == nil {
		st, err := m.node.Status(ctx)
		if err == nil && st.State == proto.StateRunning {
			e := proto.Errorf(proto.CodeAlreadyLoggedIn, "node is already logged in; log out first")
			return st, e
		}
	}
	if err := fsutil.EnsurePrivateDir(m.cfg.StateDir); err != nil {
		return proto.Status{}, err
	}
	if authKey == "" {
		return m.loginInteractive(ctx)
	}
	if HasState(m.cfg.StateDir) {
		return m.reauth(ctx, authKey)
	}
	m.closeNode()
	n, err := m.start(m.cfg, authKey)
	if err == nil {
		m.node = n
		err = n.WaitRunning(ctx)
	}
	if err == nil {
		return m.node.Status(ctx)
	}
	m.closeNode()
	lerr := loginError(ctx, err, authKey)
	if rerr := os.RemoveAll(m.cfg.StateDir); rerr != nil {
		// First, so truncating a long control-plane message cannot drop it.
		lerr.Message = proto.Truncate("removing the partial node state failed: " + rerr.Error() + "; " + lerr.Message)
	}
	return proto.Status{}, lerr
}

// reauth reauthorizes the enrolled node with authKey and reports the
// outcome as it is: the same identity is success, another identity is
// IDENTITY_CHANGED, and an attempt that did not finish is LOGIN_UNCERTAIN,
// because the backend may still complete it (it keeps retrying a failing
// control connection on its own). In the last two cases the node is
// stopped and stays held; see the Manager comment.
func (m *Manager) reauth(ctx context.Context, authKey string) (proto.Status, error) {
	if m.node == nil {
		m.Boot()
	}
	if m.node == nil {
		return proto.Status{}, proto.Errorf(proto.CodeLoginFailed, "the enrolled node cannot start: %v", m.bootErr)
	}
	// A reauth that replaces a pending interactive login keeps that hold's
	// enrolled identity. Reading it again would let the interactive attempt,
	// completing as another node between the settle and this read, become
	// the identity the new login is judged against (#155).
	var enrolled string
	if m.hold != nil {
		enrolled = m.hold.enrolled
	} else {
		id, err := m.node.StableID(ctx)
		if err != nil {
			return proto.Status{}, proto.Errorf(proto.CodeLoginFailed, "reading the enrolled identity: %v", err)
		}
		enrolled = id
	}
	if enrolled == "" {
		// The node never finished a login, so no client can have pinned
		// it: there is no identity to hold.
		m.hold = nil
		if _, err := m.node.Reauth(ctx, authKey); err != nil {
			return proto.Status{}, loginError(ctx, err, authKey)
		}
		return m.node.Status(ctx)
	}
	m.placeHold(&hold{enrolled: enrolled})
	after, err := m.node.Reauth(ctx, authKey)
	if err != nil {
		m.closeNode()
		lerr := loginError(ctx, err, authKey)
		m.hold.cause = proto.Truncate(lerr.Code + ": " + lerr.Message)
		return proto.Status{}, m.holdError()
	}
	if after != enrolled {
		m.closeNode()
		m.hold.changed, m.hold.current = true, after
		return proto.Status{}, m.holdError()
	}
	m.hold = nil
	return m.node.Status(ctx)
}

// loginError classifies a failed login. The control plane's message is
// third-party text; it is redacted so it can never echo the key back.
func loginError(ctx context.Context, err error, authKey string) *proto.Error {
	code := proto.CodeLoginFailed
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		code = proto.CodeShuttingDown
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		code = proto.CodeLoginTimeout
	}
	return proto.Errorf(code, "%s", redact(err.Error(), authKey))
}

// loginInteractive starts an interactive login. For an enrolled node the
// login can complete as another node whenever the owner opens the URL, so
// it is held until Status sees the node Running as the enrolled identity.
func (m *Manager) loginInteractive(ctx context.Context) (proto.Status, error) {
	if m.node == nil {
		n, err := m.start(m.cfg, "")
		if err != nil {
			return proto.Status{}, proto.Errorf(proto.CodeLoginFailed, "%v", err)
		}
		m.node = n
	}
	if m.hold == nil {
		id, err := m.node.StableID(ctx)
		if err != nil {
			return proto.Status{}, proto.Errorf(proto.CodeLoginFailed, "reading the enrolled identity: %v", err)
		}
		if id != "" {
			m.placeHold(&hold{enrolled: id, interactive: true})
		}
	}
	for {
		st, err := m.node.Status(ctx)
		if err == nil && (st.AuthURL != "" || st.State == proto.StateRunning) {
			if m.hold != nil {
				return m.Status(ctx)
			}
			return st, nil
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				return proto.Status{}, proto.Errorf(proto.CodeShuttingDown, "shutting down")
			}
			return proto.Status{}, proto.Errorf(proto.CodeLoginTimeout, "control plane gave no login URL in time")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Logout deauthorizes the node, stops it and deletes its state. The local
// state is deleted even when the control plane does not confirm the logout
// (unreachable, or the node cannot start at all), so a local logout is never
// blocked; the result then says remoteLogoutConfirmed: false with a warning
// that the node may remain listed in the tailnet.
func (m *Manager) Logout(ctx context.Context, timeout time.Duration) (proto.Status, error) {
	hadState := HasState(m.cfg.StateDir)
	if m.node == nil && hadState {
		// Start the node so the control plane learns about the logout.
		m.Boot()
	}
	confirmed := true
	var warnings []string
	switch {
	case m.node != nil:
		lctx, cancel := context.WithTimeout(ctx, timeout)
		err := m.node.Logout(lctx)
		cancel()
		if err != nil {
			confirmed = false
			warnings = append(warnings, "control-plane logout failed; remove the node in the Tailscale admin console: "+err.Error())
		}
	case hadState:
		confirmed = false
		warnings = append(warnings, fmt.Sprintf("the node could not start, so the control plane was not told; remove the node in the Tailscale admin console: %v", m.bootErr))
	}
	m.closeNode()
	if err := os.RemoveAll(m.cfg.StateDir); err != nil {
		return proto.Status{}, fmt.Errorf("deleting node state: %w", err)
	}
	m.bootErr, m.hold = nil, nil
	return proto.Status{State: proto.StateLoggedOut, Warnings: warnings, RemoteLogoutConfirmed: &confirmed}.Bounded(), nil
}

// Running returns the node once its backend is Running, waiting at most
// timeout for a restored node to come up.
func (m *Manager) Running(ctx context.Context, timeout time.Duration) (Node, error) {
	if m.hold != nil {
		// Settling needs the exclusive side; status or login does it.
		return nil, m.holdError()
	}
	n := m.node
	if n == nil {
		return nil, proto.Errorf(proto.CodeNotLoggedIn, "node is not logged in")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	st, err := n.Status(ctx)
	if err != nil {
		return nil, proto.Errorf(proto.CodeNodeUnavailable, "%v", err)
	}
	switch st.State {
	case proto.StateRunning:
		return n, nil
	case proto.StateNeedsLogin, proto.StateNeedsAuth:
		return nil, proto.Errorf(proto.CodeNotLoggedIn, "node needs login (state %s)", st.State)
	}
	if err := n.WaitRunning(ctx); err != nil {
		return nil, proto.Errorf(proto.CodeNodeUnavailable, "node did not reach Running: %v", err)
	}
	return n, nil
}

// Held reports whether an identity hold is in place. Holds change only
// under the caller's exclusive lock, so the shared side may read this.
func (m *Manager) Held() bool { return m.hold != nil }

// Usable returns the started node, Running or not, or nil if there is none
// or it is held.
func (m *Manager) Usable() Node {
	if m.hold != nil {
		return nil
	}
	return m.node
}

// Close stops the node and keeps its state.
func (m *Manager) Close() { m.closeNode() }

func (m *Manager) closeNode() {
	if m.node != nil {
		m.node.Close()
		m.node = nil
	}
}

func redact(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(s, secret, "[redacted]")
}
