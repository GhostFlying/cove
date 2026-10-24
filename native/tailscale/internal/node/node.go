// Package node adapts a tsnet.Server to the small surface the two modes use,
// so their state machines can be tested against a fake node.
package node

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/persist"
)

// Node is one tailnet node owned by this process.
type Node interface {
	// Status reports the backend state and this node's identity.
	Status(ctx context.Context) (proto.Status, error)
	// WaitRunning blocks until the backend is Running, reports a login
	// error, or ctx ends.
	WaitRunning(ctx context.Context) error
	// LookupPeer finds a peer in the current netmap by stable node ID and
	// returns it with the Tailscale IP to dial.
	LookupPeer(ctx context.Context, stableNodeID string) (proto.NodeInfo, string, error)
	// Dial opens a TCP connection over the tailnet to addr ("ip:port").
	Dial(ctx context.Context, addr string) (net.Conn, error)
	// WhoIs resolves the node behind a tailnet address ("ip:port").
	WhoIs(ctx context.Context, addr string) (proto.NodeInfo, error)
	// Listen opens a tailnet TCP listener on port on all of this node's
	// Tailscale addresses.
	Listen(port int) (net.Listener, error)
	// StableID reports the stable node ID of the current login profile,
	// which tailscaled persists with the state; empty if the node never
	// finished a login. It needs no netmap, so a node that needs login
	// reports the identity it is enrolled as.
	StableID(ctx context.Context) (string, error)
	// Reauth forces a new login of an already enrolled node with authKey,
	// as `tailscale up --force-reauth --auth-key` does, and waits until that
	// login completed: the node runs with a new node key. It returns the
	// stable ID the login completed as; the caller decides whether a change
	// of identity is acceptable. After an error the backend may still
	// complete the login on its own, so the caller cannot treat an error as
	// proof that nothing changed.
	Reauth(ctx context.Context, authKey string) (string, error)
	// Logout deauthorizes the node with the control plane.
	Logout(ctx context.Context) error
	// Close stops the node; its persisted state is kept.
	Close() error
}

// Config configures a node.
type Config struct {
	// StateDir holds the node key and state (tsnet's file store). The caller
	// creates it 0700.
	// StrictStateDirectory selects the server rule: existing directories are
	// checked, never chmodded. Dial clients retain EnsurePrivateDir behavior.
	StrictStateDirectory bool
	StateDir             string
	Hostname             string
	// ControlURL selects the coordination server; empty uses Tailscale's.
	ControlURL string
	// Logf receives verbose backend logs; nil discards them. Backend logs
	// can contain interactive login URLs, so they are off by default.
	Logf logger.Logf
}

// Starter starts a node. authKey is empty for a node restored from state or
// for an interactive login.
type Starter func(cfg Config, authKey string) (Node, error)

// stateFile is the name tsnet's file store uses inside StateDir.
const stateFile = "tailscaled.state"

// HasState reports whether StateDir holds persisted node state.
func HasState(stateDir string) bool {
	_, err := os.Stat(filepath.Join(stateDir, stateFile))
	return err == nil
}

// ErrPeerNotFound reports that the netmap has no peer with the stable ID.
var ErrPeerNotFound = errors.New("peer not found in netmap")

type tsnetNode struct {
	srv *tsnet.Server
	lc  *local.Client
}

// StartTSNet starts a real tsnet node. It does not wait for login.
func StartTSNet(cfg Config, authKey string) (Node, error) {
	discard := func(string, ...any) {}
	logf := cfg.Logf
	if logf == nil {
		logf = discard
	}
	srv := &tsnet.Server{
		Dir:        cfg.StateDir,
		Hostname:   cfg.Hostname,
		ControlURL: cfg.ControlURL,
		AuthKey:    authKey,
		Logf:       cfg.Logf,
		// UserLogf would print the interactive login URL; the URL is
		// returned to the requesting owner instead.
		UserLogf: logf,
	}
	if err := srv.Start(); err != nil {
		srv.Close()
		return nil, err
	}
	lc, err := srv.LocalClient()
	if err != nil {
		srv.Close()
		return nil, err
	}
	return &tsnetNode{srv: srv, lc: lc}, nil
}

func (n *tsnetNode) Status(ctx context.Context) (proto.Status, error) {
	st, err := n.lc.StatusWithoutPeers(ctx)
	if err != nil {
		return proto.Status{}, err
	}
	out := proto.Status{State: st.BackendState, AuthURL: st.AuthURL}
	if st.Self != nil && st.Self.ID != "" {
		info := peerInfo(st.Self)
		if u, ok := st.User[st.Self.UserID]; ok {
			info.LoginName = u.LoginName
		}
		out.Self = &info
	}
	return out.Bounded(), nil
}

func (n *tsnetNode) WaitRunning(ctx context.Context) error {
	w, err := n.lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		return err
	}
	defer w.Close()
	for {
		msg, err := w.Next()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if msg.ErrMessage != nil {
			return &LoginError{Message: *msg.ErrMessage}
		}
		if msg.State != nil && *msg.State == ipn.Running {
			return nil
		}
	}
}

// LoginError carries an error the control plane reported during login.
type LoginError struct{ Message string }

func (e *LoginError) Error() string { return e.Message }

func (n *tsnetNode) LookupPeer(ctx context.Context, stableNodeID string) (proto.NodeInfo, string, error) {
	st, err := n.lc.Status(ctx)
	if err != nil {
		return proto.NodeInfo{}, "", err
	}
	for _, ps := range st.Peer {
		if string(ps.ID) != stableNodeID {
			continue
		}
		info := peerInfo(ps)
		if u, ok := st.User[ps.UserID]; ok {
			info.LoginName = u.LoginName
		}
		ip := ""
		for _, a := range ps.TailscaleIPs {
			if a.Is4() {
				ip = a.String()
				break
			}
			if ip == "" {
				ip = a.String()
			}
		}
		if ip == "" {
			return info, "", fmt.Errorf("peer %s has no Tailscale address", stableNodeID)
		}
		return info.Bounded(), ip, nil
	}
	return proto.NodeInfo{}, "", ErrPeerNotFound
}

func (n *tsnetNode) Dial(ctx context.Context, addr string) (net.Conn, error) {
	return n.srv.Dial(ctx, "tcp", addr)
}

func (n *tsnetNode) WhoIs(ctx context.Context, addr string) (proto.NodeInfo, error) {
	who, err := n.lc.WhoIs(ctx, addr)
	if err != nil {
		return proto.NodeInfo{}, err
	}
	if who.Node == nil {
		return proto.NodeInfo{}, errors.New("whois returned no node")
	}
	info := nodeInfo(who.Node)
	if who.UserProfile != nil {
		info.LoginName = who.UserProfile.LoginName
	}
	return info.Bounded(), nil
}

func (n *tsnetNode) Listen(port int) (net.Listener, error) {
	return n.srv.Listen("tcp", fmt.Sprintf(":%d", port))
}

func (n *tsnetNode) StableID(ctx context.Context) (string, error) {
	cur, _, err := n.lc.ProfileStatus(ctx)
	if err != nil {
		return "", err
	}
	return string(cur.NodeID), nil
}

// Reauth restarts the backend with the key and starts a login, the sequence
// of `tailscale up --force-reauth --auth-key`. tsnet itself uses
// Server.AuthKey only for a node without state, and only forces a login
// through the TSNET_FORCE_LOGIN environment variable, which would put the
// decision in the environment; the local API does the same explicitly. The
// key goes to the in-process control client and is not persisted.
func (n *tsnetNode) Reauth(ctx context.Context, authKey string) (string, error) {
	return runReauth(ctx, reauthOps{
		profileKey: func(ctx context.Context) (ipn.StateKey, error) {
			cur, _, err := n.lc.ProfileStatus(ctx)
			return cur.Key, err
		},
		storedKey: n.storedNodeKey,
		watch: func(ctx context.Context) (func() (ipn.Notify, error), func(), error) {
			w, err := n.lc.WatchIPNBus(ctx, 0)
			if err != nil {
				return nil, nil, err
			}
			return w.Next, func() { w.Close() }, nil
		},
		start: func(ctx context.Context) error { return n.lc.Start(ctx, ipn.Options{AuthKey: authKey}) },
		login: n.lc.StartLoginInteractive,
	})
}

// reauthOps are the local API steps of a reauth, separate so a test can
// check their order against a fake bus.
type reauthOps struct {
	profileKey func(ctx context.Context) (ipn.StateKey, error)
	storedKey  func(ipn.StateKey) (key.NodePublic, error)
	watch      func(ctx context.Context) (next func() (ipn.Notify, error), stop func(), err error)
	start      func(ctx context.Context) error
	login      func(ctx context.Context) error
}

// runReauth needs completion evidence from this attempt. A Running state
// alone is not enough: the old enrollment can be (or become) Running on its
// own, for example from an in-flight map poll. A forced login always
// rotates the node key, so like `tailscale up` this waits for both Running
// and a self node with a key other than the enrolled one. The watcher is
// subscribed before Start and the login: the bus only delivers what is
// sent after the subscription, so subscribing later could miss the
// completion or an early error.
func runReauth(ctx context.Context, ops reauthOps) (string, error) {
	k, err := ops.profileKey(ctx)
	if err != nil {
		return "", err
	}
	origKey, err := ops.storedKey(k)
	if err != nil {
		return "", fmt.Errorf("reading the enrolled node key: %w", err)
	}
	next, stop, err := ops.watch(ctx)
	if err != nil {
		return "", err
	}
	defer stop()
	if err := ops.start(ctx); err != nil {
		return "", err
	}
	if err := ops.login(ctx); err != nil {
		return "", err
	}
	self, err := waitReauth(ctx, next, origKey)
	if err != nil {
		return "", err
	}
	return string(self.StableID), nil
}

// storedNodeKey returns the public node key saved in the profile under k,
// or the zero key if the profile has none. The local API strips private
// keys from prefs, and the status carries the key only once a netmap
// arrived (a node that needs login has none), so it is read from the
// state store this process owns.
func (n *tsnetNode) storedNodeKey(k ipn.StateKey) (key.NodePublic, error) {
	store, ok := n.srv.Sys().StateStore.GetOK()
	if !ok || k == "" {
		return key.NodePublic{}, nil
	}
	bs, err := store.ReadState(k)
	if errors.Is(err, ipn.ErrStateNotExist) || len(bs) == 0 {
		return key.NodePublic{}, nil
	}
	if err != nil {
		return key.NodePublic{}, err
	}
	prefs := ipn.NewPrefs()
	prefs.Persist = &persist.Persist{}
	if err := ipn.PrefsFromBytes(bs, prefs); err != nil {
		return key.NodePublic{}, err
	}
	return prefs.Persist.PublicNodeKey(), nil
}

// waitReauth consumes IPN notifications until a forced login completed:
// the backend is Running and has reported a self node whose key differs
// from origKey. The two arrive separately and in either order. An error
// message from the backend fails the login.
func waitReauth(ctx context.Context, next func() (ipn.Notify, error), origKey key.NodePublic) (*tailcfg.Node, error) {
	running := false
	var self *tailcfg.Node
	for {
		msg, err := next()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		if msg.ErrMessage != nil {
			return nil, &LoginError{Message: *msg.ErrMessage}
		}
		if msg.State != nil {
			running = *msg.State == ipn.Running
		}
		if sc := msg.SelfChange; sc != nil && !sc.Key.IsZero() && sc.Key != origKey {
			self = sc
		}
		if running && self != nil {
			return self, nil
		}
	}
}

func (n *tsnetNode) Logout(ctx context.Context) error { return n.lc.Logout(ctx) }

func (n *tsnetNode) Close() error { return n.srv.Close() }

func peerInfo(ps *ipnstate.PeerStatus) proto.NodeInfo {
	info := proto.NodeInfo{
		StableNodeID: string(ps.ID),
		Name:         strings.TrimSuffix(ps.DNSName, "."),
		HostName:     ps.HostName,
	}
	for _, a := range ps.TailscaleIPs {
		info.TailscaleIPs = append(info.TailscaleIPs, a.String())
	}
	return info
}

func nodeInfo(n *tailcfg.Node) proto.NodeInfo {
	info := proto.NodeInfo{
		StableNodeID: string(n.StableID),
		Name:         strings.TrimSuffix(n.Name, "."),
	}
	if n.Hostinfo.Valid() {
		info.HostName = n.Hostinfo.Hostname()
	}
	for _, a := range n.Addresses {
		info.TailscaleIPs = append(info.TailscaleIPs, a.Addr().String())
	}
	return info
}

// NetworkChanged is an optional mobile capability, deliberately outside Node's
// domain contract. Android SDK callbacks wake the same tsnet monitor; they do not
// create another network model or change the process's selected OS network.
func (n *tsnetNode) NetworkChanged() {
	if sys := n.srv.Sys(); sys != nil {
		if monitor, ok := sys.NetMon.GetOK(); ok && monitor != nil {
			monitor.InjectEvent()
		}
	}
}
