package mobile

import (
	"errors"

	"tailscale.com/net/netmon"
)

func init() {
	// Android app UIDs cannot enumerate NETLINK_ROUTE. Register exactly once;
	// the Java SDK supplies immutable LinkProperties snapshots before Start.
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		snapshot := androidNetwork.Load()
		if snapshot == nil {
			return nil, errors.New("native netmon snapshot unavailable")
		}
		netmon.UpdateLastKnownDefaultRouteInterface(snapshot.defaultRoute)
		return snapshot.netmonInterfaces(), nil
	})
}
