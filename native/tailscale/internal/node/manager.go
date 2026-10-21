package node

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/fsutil"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// Manager owns the login lifecycle of the single node behind one state
// directory. It is not safe for concurrent mutation: callers serialize
// Boot, Login, Logout and Close (the control mutex in both modes), while
// Running may run concurrently with other Running calls.
type Manager struct {
	cfg   Config
	start Starter
	node  Node
	// bootErr is why a node with persisted state is not running.
	bootErr error
}

// NewManager creates a manager; nothing starts until Boot or Login.
func NewManager(cfg Config, start Starter) *Manager {
	return &Manager{cfg: cfg, start: start}
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

// Status reports the node state. Without a node it reports LoggedOut, or
// Unavailable when persisted state exists but the node failed to start.
func (m *Manager) Status(ctx context.Context) (proto.Status, error) {
	if m.node == nil {
		if HasState(m.cfg.StateDir) {
			msg := "node state exists but the node is not running"
			if m.bootErr != nil {
				msg = m.bootErr.Error()
			}
			return proto.Status{State: proto.StateUnavailable, Warnings: []string{msg}}, nil
		}
		return proto.Status{State: proto.StateLoggedOut}, nil
	}
	return m.node.Status(ctx)
}

// Login logs the node in. With authKey it restarts the node with that key
// and waits until it is Running. Without authKey it starts an interactive
// login and returns as soon as the control plane provides the login URL;
// the owner then polls Status. A failed key login of a node that had no
// state removes the partial state, so no half-logged-in node remains.
func (m *Manager) Login(ctx context.Context, authKey string, timeout time.Duration) (proto.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if m.node != nil {
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
	hadState := HasState(m.cfg.StateDir)
	// A node already started without a key ignores a key supplied later, so
	// the key login always uses a fresh node over the same state.
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
	if hadState {
		m.Boot()
	} else {
		os.RemoveAll(m.cfg.StateDir)
	}
	code := proto.CodeLoginFailed
	if errors.Is(err, context.DeadlineExceeded) {
		code = proto.CodeLoginTimeout
	}
	// The control plane's message is third-party text; never let it echo the
	// key back to the caller.
	return proto.Status{}, proto.Errorf(code, "%s", redact(err.Error(), authKey))
}

func (m *Manager) loginInteractive(ctx context.Context) (proto.Status, error) {
	if m.node == nil {
		n, err := m.start(m.cfg, "")
		if err != nil {
			return proto.Status{}, proto.Errorf(proto.CodeLoginFailed, "%v", err)
		}
		m.node = n
	}
	for {
		st, err := m.node.Status(ctx)
		if err == nil && (st.AuthURL != "" || st.State == proto.StateRunning) {
			return st, nil
		}
		select {
		case <-ctx.Done():
			return proto.Status{}, proto.Errorf(proto.CodeLoginTimeout, "control plane gave no login URL in time")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Logout deauthorizes the node, stops it and deletes its state. If the
// control plane cannot be reached the local state is still deleted, and the
// result carries a warning that the node may remain listed in the tailnet.
func (m *Manager) Logout(ctx context.Context, timeout time.Duration) (proto.Status, error) {
	if m.node == nil && HasState(m.cfg.StateDir) {
		// Start the node so the control plane learns about the logout.
		m.Boot()
	}
	var warnings []string
	if m.node != nil {
		lctx, cancel := context.WithTimeout(ctx, timeout)
		err := m.node.Logout(lctx)
		cancel()
		if err != nil {
			warnings = append(warnings, "control-plane logout failed; remove the node in the Tailscale admin console: "+err.Error())
		}
	}
	m.closeNode()
	if err := os.RemoveAll(m.cfg.StateDir); err != nil {
		return proto.Status{}, err
	}
	m.bootErr = nil
	return proto.Status{State: proto.StateLoggedOut, Warnings: warnings}, nil
}

// Running returns the node once its backend is Running, waiting at most
// timeout for a restored node to come up.
func (m *Manager) Running(ctx context.Context, timeout time.Duration) (Node, error) {
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

// Node returns the started node, Running or not, or nil.
func (m *Manager) Node() Node { return m.node }

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
