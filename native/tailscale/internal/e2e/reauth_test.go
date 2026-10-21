package e2e

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"tailscale.com/types/key"
)

// renewReauthorizedKeys models the control plane's side of a reauth: a node
// key registered as a rotation of the expired one gets a fresh expiry.
// testcontrol copies the old entry, expiry included, so without this the
// reauthorized node would be told at once that its new key expired too.
func renewReauthorizedKeys(t *testing.T, tn *tailnet, expired key.NodePublic) {
	stop := make(chan struct{})
	done := make(chan struct{})
	t.Cleanup(func() { close(stop); <-done })
	go func() {
		defer close(done)
		for {
			for _, n := range tn.control.AllNodes() {
				if n.Key != expired && !n.KeyExpiry.IsZero() {
					n = n.Clone()
					n.KeyExpiry = time.Time{}
					tn.control.UpdateNode(n)
				}
			}
			select {
			case <-stop:
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()
}

// A persisted node whose key expired needs login again. Logging in with an
// auth key reauthorizes that node in place: same stable ID, state kept.
func TestDialReauthOfExpiredPersistedNode(t *testing.T) {
	// The key-requiring control plane also refuses the restored node's
	// keyless re-registration, as real control does once a key expired; without
	// it testcontrol silently approves the client's automatic key rotation.
	tn := newTailnet(t, true)
	home := filepath.Join(shortDir(t), "tsnet-client")
	d := startDial(t, tn, home)
	cli := loginDial(t, d.sock)

	nodes := tn.control.AllNodes()
	if len(nodes) != 1 {
		t.Fatalf("control has %d nodes", len(nodes))
	}
	n := nodes[0].Clone()
	n.KeyExpiry = time.Now().Add(-time.Minute)
	tn.control.UpdateNode(n)
	deadline := time.Now().Add(30 * time.Second)
	for dialStatus(t, d.sock).State != proto.StateNeedsLogin {
		if time.Now().After(deadline) {
			t.Fatalf("expired node never needed login: %+v", dialStatus(t, d.sock))
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Restart: the node comes back from persisted state, still expired.
	if resp := request(t, d.sock, proto.Request{Op: proto.OpStop}); !resp.OK {
		t.Fatalf("stop: %+v", resp.Error)
	}
	d.wait(15 * time.Second)
	d = startDial(t, tn, home)
	if resp := request(t, d.sock, proto.Request{
		Op: proto.OpDial, Target: &proto.Target{StableNodeID: cli.StableNodeID}, Port: 1, TimeoutMs: 2000,
	}); resp.OK {
		t.Fatal("the expired node opened a stream")
	}

	renewReauthorizedKeys(t, tn, n.Key)
	st := decodeStatus(t, request(t, d.sock, proto.Request{Op: proto.OpLogin, AuthKey: testAuthKey, TimeoutMs: 60000}))
	if st.State != proto.StateRunning || st.Self == nil || st.Self.StableNodeID != cli.StableNodeID {
		t.Fatalf("after reauth: %+v (want stable ID %s)\nstderr:\n%s", st, cli.StableNodeID, d.stderr)
	}
	if _, err := os.Stat(filepath.Join(home, "state", "tailscaled.state")); err != nil {
		t.Fatalf("reauth lost the node state: %v", err)
	}
	assertNoSecret(t, home)
}
