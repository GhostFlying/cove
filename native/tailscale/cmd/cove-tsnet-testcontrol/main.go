// Command cove-tsnet-testcontrol runs a test tailnet on loopback for tests
// outside this module (the CLI's M2 S7/S8 scenarios): Tailscale's test
// control plane with a local DERP relay and STUN server (internal/testnet).
//
// It is a test tool only. scripts/tsnet-build.mjs builds it with the
// `testcontrol` command into a directory the caller names; it is never part
// of the shipped build or the runtime closure.
//
//	cove-tsnet-testcontrol [--require-auth-key]
//
// Once the tailnet runs it writes one JSON line to stdout:
//
//	{"controlURL": "http://127.0.0.1:…", "authKey": "tskey-auth-…", "nodeEnv": {"TS_…": "1", …}}
//
// authKey is a key only this control plane accepts. nodeEnv is the
// environment every cove-tsnet node of the test must run with: it keeps the
// node off Tailscale's real control plane (TS_PANIC_IF_HIT_MAIN_CONTROL) and
// out of the host's network configuration. The command exits when its stdin
// reaches end-of-file, so it ends with the test process that started it, or
// on SIGINT/SIGTERM.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/GhostFlying/cove/native/tailscale/internal/testnet"
)

// nodeEnv is what internal/e2e gives its children as well (childEnv).
var nodeEnv = map[string]string{
	"TS_PANIC_IF_HIT_MAIN_CONTROL":  "1",
	"TS_ASSUME_NETWORK_UP_FOR_TEST": "1",
	"TS_DISABLE_PORTMAPPER":         "1",
}

func main() {
	os.Exit(run())
}

func run() int {
	requireKey := flag.Bool("require-auth-key", false,
		"reject registrations without the test auth key (also rejects keyless re-registration of restored nodes)")
	flag.Parse()
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected arguments: %q\n", flag.Args())
		return 2
	}
	// Nothing in this process should reach Tailscale's real control plane
	// either; the variable is read by the tailscale.com packages it links.
	os.Setenv("TS_PANIC_IF_HIT_MAIN_CONTROL", "1")
	// The STUN server logs through the standard logger; keep stdout to the
	// one JSON line and stderr to errors.
	log.SetOutput(io.Discard)

	tn, err := testnet.Start(*requireKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cove-tsnet-testcontrol: %v\n", err)
		return 1
	}
	defer tn.Close()

	out, err := json.Marshal(map[string]any{
		"controlURL": tn.ControlURL,
		"authKey":    testnet.AuthKey,
		"nodeEnv":    nodeEnv,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "cove-tsnet-testcontrol: %v\n", err)
		return 1
	}
	os.Stdout.Write(append(out, '\n'))

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	eof := make(chan struct{})
	go func() {
		io.Copy(io.Discard, os.Stdin)
		close(eof)
	}()
	select {
	case <-signals:
	case <-eof:
	}
	return 0
}
