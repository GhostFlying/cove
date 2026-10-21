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
	"tailscale.com/types/logger"
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
	// Logout deauthorizes the node with the control plane.
	Logout(ctx context.Context) error
	// Close stops the node; its persisted state is kept.
	Close() error
}

// Config configures a node.
type Config struct {
	// StateDir holds the node key and state (tsnet's file store). The caller
	// creates it 0700.
	StateDir string
	Hostname string
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
	return out, nil
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
		return info, ip, nil
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
	return info, nil
}

func (n *tsnetNode) Listen(port int) (net.Listener, error) {
	return n.srv.Listen("tcp", fmt.Sprintf(":%d", port))
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
