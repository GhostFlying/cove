// Package testnet runs a self-contained test tailnet on loopback: Tailscale's
// test control plane (tstest/integration/testcontrol) with a local DERP relay
// and STUN server, so cove-tsnet nodes can join a real tailnet without
// touching any real one or a system tailscaled.
//
// It is for tests only: the end-to-end tests (internal/e2e) and the
// cove-tsnet-testcontrol command, which the CLI tests start. The shipped
// cove-tsnet binary never imports it.
package testnet

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"

	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stunserver"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// AuthKey is accepted only by a test control plane. With RequireAuthKey it
// is the only key accepted; otherwise testcontrol accepts any key.
const AuthKey = "tskey-auth-cove-e2e-not-a-real-key-0123456789"

// Tailnet is a running test control plane with its DERP and STUN servers.
type Tailnet struct {
	ControlURL string
	Control    *testcontrol.Server
	closers    []func()
}

// Start starts a test tailnet on 127.0.0.1. With requireAuthKey every
// registration without AuthKey is rejected; testcontrol applies that to
// re-registrations of known nodes too (real control does not), so a tailnet
// whose nodes restart from saved state should not require it.
func Start(requireAuthKey bool) (*Tailnet, error) {
	tn := &Tailnet{}
	derpMap, err := tn.startDERPAndSTUN()
	if err != nil {
		tn.Close()
		return nil, err
	}
	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "tail-scale.ts.net",
		Logf:           logger.Discard,
	}
	if requireAuthKey {
		control.RequireAuthKey = AuthKey
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	tn.closers = append(tn.closers, control.HTTPTestServer.Close)
	tn.Control = control
	tn.ControlURL = control.HTTPTestServer.URL
	return tn, nil
}

// Close stops the control plane, DERP and STUN, in reverse start order.
func (tn *Tailnet) Close() {
	for i := len(tn.closers) - 1; i >= 0; i-- {
		tn.closers[i]()
	}
	tn.closers = nil
}

// startDERPAndSTUN starts a loopback DERP relay and STUN server. It mirrors
// tstest/integration.RunDERPAndSTUN, which cannot be imported here because
// that package depends on Tailscale features cove-tsnet compiles out, and
// it uses stunserver rather than stuntest, which needs a *testing.T.
func (tn *Tailnet) startDERPAndSTUN() (*tailcfg.DERPMap, error) {
	d := derpserver.New(key.NewNode(), logger.Discard)
	tn.closers = append(tn.closers, func() { d.Close() })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	httpsrv := httptest.NewUnstartedServer(derpserver.Handler(d))
	httpsrv.Listener.Close()
	httpsrv.Listener = ln
	httpsrv.Config.ErrorLog = logger.StdLogger(logger.Discard)
	httpsrv.Config.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	httpsrv.StartTLS()
	tn.closers = append(tn.closers, func() {
		httpsrv.CloseClientConnections()
		httpsrv.Close()
	})

	ctx, cancel := context.WithCancel(context.Background())
	stun := stunserver.New(ctx)
	if err := stun.Listen("127.0.0.1:0"); err != nil {
		cancel()
		return nil, err
	}
	served := make(chan struct{})
	go func() {
		defer close(served)
		stun.Serve()
	}()
	tn.closers = append(tn.closers, func() {
		cancel()
		<-served
	})
	stunAddr, ok := stun.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil, errors.New("STUN server has no UDP address")
	}

	return &tailcfg.DERPMap{
		Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
			1: {
				RegionID:   1,
				RegionCode: "test",
				Nodes: []*tailcfg.DERPNode{{
					Name:             "t1",
					RegionID:         1,
					HostName:         "127.0.0.1",
					IPv4:             "127.0.0.1",
					IPv6:             "none",
					STUNPort:         stunAddr.Port,
					DERPPort:         ln.Addr().(*net.TCPAddr).Port,
					InsecureForTests: true,
					STUNTestIP:       "127.0.0.1",
				}},
			},
		},
	}, nil
}
