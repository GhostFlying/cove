package dial

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// fakeNode routes every dial to a pipe and reports whoIs for any address,
// modelling a netmap entry whose address now answers as another node. The
// end-to-end tests cannot produce that state with the test control plane.
type fakeNode struct {
	node.Node
	peerID string
	whoIs  string
	dialed net.Conn
}

func (f *fakeNode) LookupPeer(_ context.Context, id string) (proto.NodeInfo, string, error) {
	if id != f.peerID {
		return proto.NodeInfo{}, "", node.ErrPeerNotFound
	}
	return proto.NodeInfo{StableNodeID: id}, "100.64.0.9", nil
}

func (f *fakeNode) Dial(context.Context, string) (net.Conn, error) {
	a, b := net.Pipe()
	f.dialed = a
	go func() {
		b.Read(make([]byte, 1))
		b.Close()
	}()
	return a, nil
}

func (f *fakeNode) WhoIs(context.Context, string) (proto.NodeInfo, error) {
	return proto.NodeInfo{StableNodeID: f.whoIs}, nil
}

func TestOpenVerifiedRejectsAnotherNode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n := &fakeNode{peerID: "nServer", whoIs: "nImpostor"}
	_, _, err := openVerified(ctx, n, "nServer", 7001)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodePeerMismatch {
		t.Fatalf("got %v", err)
	}
	// The unverified connection is closed, never handed to the CLI.
	if _, err := n.dialed.Write([]byte("x")); err == nil {
		t.Fatal("mismatched connection is still open")
	}

	n = &fakeNode{peerID: "nServer", whoIs: "nServer"}
	c, info, err := openVerified(ctx, n, "nServer", 7001)
	if err != nil || info.StableNodeID != "nServer" {
		t.Fatalf("verified peer: %v %+v", err, info)
	}
	c.Close()
}
