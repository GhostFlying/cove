package mobile

import (
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"

	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"tailscale.com/net/netmon"
)

const maxNetworkSnapshotBytes = 32 << 10

type androidNetworkInput struct {
	DefaultRoute string `json:"defaultRoute"`
	Interfaces   []struct {
		Name      string   `json:"name"`
		Index     int      `json:"index"`
		MTU       int      `json:"mtu"`
		Up        bool     `json:"up"`
		Addresses []string `json:"addresses"`
	} `json:"interfaces"`
}

type parsedNetworkInterface struct {
	name       string
	index, mtu int
	up         bool
	prefixes   []netip.Prefix
}

type parsedNetwork struct {
	defaultRoute string
	interfaces   []parsedNetworkInterface
}

// Published snapshots are immutable. Only Android registers the package-level
// getter, once during initialization and before any tsnet Start. Callbacks swap
// this pointer rather than racing netmon's unsynchronized getter registration.
var androidNetwork atomic.Pointer[parsedNetwork]

func parseNetworkSnapshot(raw string) (*parsedNetwork, error) {
	if len(raw) == 0 || len(raw) > maxNetworkSnapshotBytes {
		return nil, errors.New("invalid native network snapshot size")
	}
	var input androidNetworkInput
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return nil, errors.New("invalid native network snapshot JSON")
	}
	if len(input.Interfaces) > 16 {
		return nil, errors.New("too many native network interfaces")
	}
	result := &parsedNetwork{defaultRoute: input.DefaultRoute}
	names := map[string]bool{}
	indexes := map[int]bool{}
	addresses := 0
	for _, item := range input.Interfaces {
		if item.Name == "" || len(item.Name) > 64 || strings.ContainsAny(item.Name, "\x00\r\n/") ||
			item.Index <= 0 || item.Index > 2147483647 || item.MTU < 0 || item.MTU > 65535 ||
			names[item.Name] || indexes[item.Index] || len(item.Addresses) > 32 {
			return nil, errors.New("invalid native network interface")
		}
		names[item.Name], indexes[item.Index] = true, true
		entry := parsedNetworkInterface{name: item.Name, index: item.Index, mtu: item.MTU, up: item.Up}
		for _, text := range item.Addresses {
			prefix, err := netip.ParsePrefix(text)
			if err != nil || !prefix.Addr().IsValid() || prefix.Addr().IsUnspecified() {
				return nil, errors.New("invalid native network address prefix")
			}
			addresses++
			if addresses > 128 {
				return nil, errors.New("too many native network addresses")
			}
			entry.prefixes = append(entry.prefixes, prefix)
		}
		result.interfaces = append(result.interfaces, entry)
	}
	if result.defaultRoute != "" && !names[result.defaultRoute] {
		return nil, errors.New("native default route has no current interface")
	}
	return result, nil
}

func (n *parsedNetwork) netmonInterfaces() []netmon.Interface {
	result := make([]netmon.Interface, 0, len(n.interfaces))
	for _, item := range n.interfaces {
		iface := &net.Interface{Name: item.name, Index: item.index, MTU: item.mtu}
		if item.up {
			iface.Flags = net.FlagUp | net.FlagRunning
		}
		// AltAddrs bypasses net.Interface.Addrs, which uses the same denied
		// NETLINK_ROUTE enumeration as net.Interfaces on Android SDK 30+.
		entry := netmon.Interface{Interface: iface, AltAddrs: []net.Addr{}}
		for _, prefix := range item.prefixes {
			entry.AltAddrs = append(entry.AltAddrs, &net.IPNet{IP: net.IP(prefix.Addr().AsSlice()), Mask: net.CIDRMask(prefix.Bits(), prefix.Addr().BitLen())})
		}
		result = append(result, entry)
	}
	return result
}

// SetAndroidNetworkInterfaces installs the initial real SDK snapshot before New
// can restore an enrolled node. Only the serialized Android native opener calls
// this function; a live node uses its instance-bound NetworkChanged method.
func SetAndroidNetworkInterfaces(raw string) error {
	snapshot, err := parseNetworkSnapshot(raw)
	if err != nil {
		return err
	}
	androidNetwork.Store(snapshot)
	return nil
}

// NetworkChanged publishes an OS callback only while this Client still owns its
// node. Stop shares this lock, fencing delayed callbacks from a previous native
// generation before they can overwrite a successor's process-wide snapshot.
// The notification itself is in-memory and does not take the control mutex: a
// connectivity transition must be able to wake an in-flight Login.
func (c *Client) NetworkChanged(raw string) error {
	snapshot, err := parseNetworkSnapshot(raw)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("native node is closed")
	}
	androidNetwork.Store(snapshot)
	current := c.networkNode
	c.mu.Unlock()
	if current != nil && current.changed != nil {
		current.changed()
	}
	return nil
}

type mobileNetworkNode struct {
	node.Node
	owner   *Client
	changed func()
}

func (n *mobileNetworkNode) Close() error {
	n.owner.mu.Lock()
	if n.owner.networkNode == n {
		n.owner.networkNode = nil
	}
	n.owner.mu.Unlock()
	return n.Node.Close()
}

func (c *Client) startNetworkNode(cfg node.Config, key string) (node.Node, error) {
	real, err := node.StartTSNet(cfg, key)
	if err != nil {
		return nil, err
	}
	wrapped := &mobileNetworkNode{Node: real, owner: c}
	if notifier, ok := real.(interface{ NetworkChanged() }); ok {
		wrapped.changed = notifier.NetworkChanged
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		real.Close()
		return nil, errors.New("native node is closed")
	}
	c.networkNode = wrapped
	c.mu.Unlock()
	// An SDK update during Start may have published after netmon's initial
	// read but before this notifier existed. Re-read once after installation
	// rather than waiting for Android's ten-minute fallback polling interval.
	if wrapped.changed != nil {
		wrapped.changed()
	}
	return wrapped, nil
}
