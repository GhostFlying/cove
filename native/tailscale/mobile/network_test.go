package mobile

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
)

const fixtureNetwork = `{"defaultRoute":"wlan0","interfaces":[{"name":"wlan0","index":4,"mtu":1500,"up":true,"addresses":["192.0.2.10/24","2001:db8::10/64"]}]}`

func TestSDKNetworkSnapshotBypassesOSAddressEnumeration(t *testing.T) {
	snapshot, err := parseNetworkSnapshot(fixtureNetwork)
	if err != nil {
		t.Fatal(err)
	}
	interfaces := snapshot.netmonInterfaces()
	addresses, err := interfaces[0].Addrs()
	if err != nil || len(addresses) != 2 || addresses[0].String() != "192.0.2.10/24" || addresses[1].String() != "2001:db8::10/64" {
		t.Fatalf("SDK prefixes were lost: %v, %v", addresses, err)
	}
	if !interfaces[0].IsUp() || interfaces[0].Index != 4 {
		t.Fatal("SDK interface metadata was lost")
	}
	// netmon receives a fresh view; mutating a caller's copy cannot modify a
	// later read or race a concurrently published immutable snapshot.
	interfaces[0].Name = "modified"
	addresses[0].(*net.IPNet).IP[0] = 1
	again := snapshot.netmonInterfaces()
	unchanged, _ := again[0].Addrs()
	if again[0].Name != "wlan0" || unchanged[0].String() != "192.0.2.10/24" {
		t.Fatal("published SDK snapshot was mutable")
	}

	for _, raw := range []string{
		strings.Repeat("x", maxNetworkSnapshotBytes+1),
		`{"defaultRoute":"absent","interfaces":[]}`,
		strings.Replace(fixtureNetwork, "192.0.2.10/24", "not-an-address", 1),
		strings.Replace(fixtureNetwork, `"index":4`, `"index":0`, 1),
		strings.Replace(fixtureNetwork, `"mtu":1500`, `"mtu":-1`, 1),
	} {
		if _, err := parseNetworkSnapshot(raw); err == nil {
			t.Fatal("invalid SDK snapshot accepted")
		}
	}
	var input androidNetworkInput
	if err := json.Unmarshal([]byte(fixtureNetwork), &input); err != nil {
		t.Fatal(err)
	}
	input.Interfaces = append(input.Interfaces, input.Interfaces[0])
	raw, _ := json.Marshal(input)
	if _, err := parseNetworkSnapshot(string(raw)); err == nil {
		t.Fatal("duplicate SDK interfaces accepted")
	}
}

func TestStoppedNetworkCallbackCannotPublishOverItsSuccessor(t *testing.T) {
	previous := androidNetwork.Load()
	t.Cleanup(func() { androidNetwork.Store(previous) })
	c, _, fake := fixture(t, func() (net.Conn, error) { return nil, errors.New("unused fixture dial") }, "server")
	var notifications atomic.Int32
	owned := &mobileNetworkNode{Node: fake, owner: c, changed: func() { notifications.Add(1) }}
	c.networkNode = owned
	if err := c.NetworkChanged(fixtureNetwork); err != nil || notifications.Load() != 1 {
		t.Fatalf("live network callback: %v", err)
	}
	if err := owned.Close(); err != nil {
		t.Fatal(err)
	}
	if c.networkNode != nil {
		t.Fatal("closed concrete node retained its capability")
	}
	c.Close()
	if err := SetAndroidNetworkInterfaces(`{"defaultRoute":"","interfaces":[]}`); err != nil {
		t.Fatal(err)
	}
	successor := androidNetwork.Load()
	if err := c.NetworkChanged(fixtureNetwork); err == nil {
		t.Fatal("stopped callback was accepted")
	}
	if androidNetwork.Load() != successor || notifications.Load() != 1 {
		t.Fatal("old callback changed its successor's network state")
	}
}
