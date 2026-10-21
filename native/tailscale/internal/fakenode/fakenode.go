// Package fakenode is an in-memory node.Node for tests of the serve and dial
// state machines. It is imported only by tests.
package fakenode

import (
	"context"
	"errors"
	"net"
	"sync"

	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// Peer is a node the fake can dial.
type Peer struct {
	IP string
	// Dial opens the connection the fake returns for this peer.
	Dial func() (net.Conn, error)
	// WhoIs is the stable ID WhoIs reports for the connection; it differs
	// from the peer's own ID to model an address that answers as another
	// node.
	WhoIs string
}

// Node is a fake tailnet node. Its fields are set before use.
type Node struct {
	mu sync.Mutex
	// State is reported by Status; WaitRunning succeeds once it is Running.
	State string
	Self  proto.NodeInfo
	Peers map[string]Peer
	// BlockWait makes WaitRunning block until its context ends.
	BlockWait bool
	// Listen backs Listen; nil fails.
	ListenFn func(port int) (net.Listener, error)
	// WhoIsAddr answers WhoIs for an address no Peer dial produced.
	WhoIsAddr func(addr string) (proto.NodeInfo, error)
	LogoutErr error
	// ReauthAs is the stable ID a reauth completes as; empty keeps Self's.
	ReauthAs string
	// ReauthErr fails a reauth.
	ReauthErr error
	// OnReauth, OnWait and OnLookup, if set, run when those calls start, so
	// a test can act at a known point.
	OnReauth, OnWait, OnLookup func()

	Reauths []string
	Closed  bool
	dialed  map[string]string // remote addr → whois ID
}

var _ node.Node = (*Node)(nil)

func (n *Node) Status(context.Context) (proto.Status, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	self := n.Self
	return proto.Status{State: n.State, Self: &self}, nil
}

func (n *Node) WaitRunning(ctx context.Context) error {
	if n.OnWait != nil {
		n.OnWait()
	}
	n.mu.Lock()
	block, state := n.BlockWait, n.State
	n.mu.Unlock()
	if block || state != proto.StateRunning {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func (n *Node) LookupPeer(_ context.Context, id string) (proto.NodeInfo, string, error) {
	if n.OnLookup != nil {
		n.OnLookup()
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	p, ok := n.Peers[id]
	if !ok {
		return proto.NodeInfo{}, "", node.ErrPeerNotFound
	}
	return proto.NodeInfo{StableNodeID: id}, p.IP, nil
}

func (n *Node) Dial(_ context.Context, addr string) (net.Conn, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	for _, p := range n.Peers {
		if p.IP == host {
			c, err := p.Dial()
			if err != nil {
				return nil, err
			}
			if n.dialed == nil {
				n.dialed = map[string]string{}
			}
			n.dialed[c.RemoteAddr().String()] = p.WhoIs
			return c, nil
		}
	}
	return nil, errors.New("fakenode: no route")
}

func (n *Node) WhoIs(_ context.Context, addr string) (proto.NodeInfo, error) {
	n.mu.Lock()
	id, ok := n.dialed[addr]
	fn := n.WhoIsAddr
	n.mu.Unlock()
	if ok {
		return proto.NodeInfo{StableNodeID: id}, nil
	}
	if fn != nil {
		return fn(addr)
	}
	return proto.NodeInfo{}, errors.New("fakenode: unknown address")
}

func (n *Node) Listen(port int) (net.Listener, error) {
	if n.ListenFn == nil {
		return nil, errors.New("fakenode: listen unsupported")
	}
	return n.ListenFn(port)
}

func (n *Node) Reauth(ctx context.Context, key string) (node.ReauthResult, error) {
	if n.OnReauth != nil {
		n.OnReauth()
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.Reauths = append(n.Reauths, key)
	if n.ReauthErr != nil {
		return node.ReauthResult{}, n.ReauthErr
	}
	res := node.ReauthResult{Before: n.Self.StableNodeID, After: n.Self.StableNodeID}
	if n.ReauthAs != "" {
		res.After = n.ReauthAs
		n.Self.StableNodeID = n.ReauthAs
	}
	n.State = proto.StateRunning
	return res, nil
}

func (n *Node) Logout(context.Context) error { return n.LogoutErr }

func (n *Node) Close() error {
	n.mu.Lock()
	n.Closed = true
	n.mu.Unlock()
	return nil
}

// SetState changes the reported state.
func (n *Node) SetState(s string) {
	n.mu.Lock()
	n.State = s
	n.mu.Unlock()
}
