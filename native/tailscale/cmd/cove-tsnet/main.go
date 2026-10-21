// Command cove-tsnet is Cove's embedded Tailscale (tsnet) helper. It never
// uses a system tailscaled (M2 D9) and has two modes:
//
//	cove-tsnet serve  the server node, a supervised child of cove-server (D10)
//	cove-tsnet dial   the per-user client daemon used by the CLI (D14)
//
// See native/tailscale/PROTOCOL.md for the local protocols. Secrets (auth
// keys) arrive only inside control frames: serve reads them from stdin, dial
// from its 0700 socket. Neither mode accepts a secret in argv or the
// environment, and neither writes one to stdout, stderr or disk.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/GhostFlying/cove/native/tailscale/internal/buildinfo"
	"github.com/GhostFlying/cove/native/tailscale/internal/dial"
	"github.com/GhostFlying/cove/native/tailscale/internal/node"
	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
	"github.com/GhostFlying/cove/native/tailscale/internal/serve"
	"tailscale.com/envknob"
)

// Exit codes; PROTOCOL.md documents them for the CLI and the server.
const (
	exitOK     = 0
	exitError  = 1
	exitUsage  = 2
	exitLocked = 75 // EX_TEMPFAIL: another dial daemon owns the directory.
)

// scrubbedEnv lists the variables tsnet would otherwise read credentials or
// a control URL from. Cove passes all of them explicitly, so an inherited
// value must never take effect silently.
var scrubbedEnv = []string{
	"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID",
	"TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TSNET_FORCE_LOGIN",
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	// Every file and directory this process creates (node state, lock,
	// socket) is private to the user regardless of the inherited umask.
	syscall.Umask(0o077)
	for _, k := range scrubbedEnv {
		os.Unsetenv(k)
	}
	// Never upload logs to Tailscale's log service; the logtail feature is
	// also compiled out (scripts/tsnet-build.mjs).
	envknob.SetNoLogsNoSupport()

	if len(args) == 0 {
		usage()
		return exitUsage
	}
	switch args[0] {
	case "serve":
		return runServe(args[1:])
	case "dial":
		return runDial(args[1:])
	case "version":
		fmt.Printf("cove-tsnet build=%s protocol=%d\n", buildinfo.String(), proto.Version)
		return exitOK
	case "-h", "--help", "help":
		usage()
		return exitOK
	default:
		usage()
		return exitUsage
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  cove-tsnet serve --home DIR --forward-socket PATH [--hostname NAME] [--control-url URL] [--verbose]
  cove-tsnet dial  --home DIR [--hostname NAME] [--control-url URL] [--idle-timeout DUR] [--verbose]
  cove-tsnet version
`)
}

type common struct {
	home, hostname, controlURL string
	verbose                    bool
}

func (c *common) register(fs *flag.FlagSet, defaultHostPrefix string) {
	fs.StringVar(&c.home, "home", "", "tsnet directory (required)")
	fs.StringVar(&c.hostname, "hostname", defaultHostname(defaultHostPrefix), "tailnet hostname for a new node")
	fs.StringVar(&c.controlURL, "control-url", "", "coordination server URL (default: Tailscale)")
	fs.BoolVar(&c.verbose, "verbose", false, "write tsnet backend logs to stderr (may include login URLs)")
}

func defaultHostname(prefix string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return prefix
	}
	h, _, _ = strings.Cut(h, ".")
	return prefix + "-" + h
}

func (c *common) nodeLogf() func(string, ...any) {
	if !c.verbose {
		return nil
	}
	return log.New(os.Stderr, "tsnet: ", log.LstdFlags).Printf
}

func eventLogf() func(string, ...any) {
	return log.New(os.Stderr, "cove-tsnet: ", log.LstdFlags).Printf
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func parse(fs *flag.FlagSet, args []string) bool {
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		return false
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected arguments: %q\n", fs.Args())
		return false
	}
	return true
}

func runServe(args []string) int {
	var c common
	var forward string
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	c.register(fs, "cove")
	fs.StringVar(&forward, "forward-socket", "", "Unix socket of the Cove server (required)")
	if !parse(fs, args) {
		return exitUsage
	}
	if c.home == "" || forward == "" {
		fmt.Fprintln(os.Stderr, "serve needs --home and --forward-socket")
		return exitUsage
	}
	ctx, cancel := signalContext()
	defer cancel()
	err := serve.Run(ctx, serve.Config{
		Home:          c.home,
		Hostname:      c.hostname,
		ControlURL:    c.controlURL,
		ForwardSocket: forward,
		Build:         buildinfo.String(),
		Start:         node.StartTSNet,
		NodeLogf:      c.nodeLogf(),
		Logf:          eventLogf(),
		In:            os.Stdin,
		Out:           os.Stdout,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "cove-tsnet serve: %v\n", err)
		return exitError
	}
	return exitOK
}

// debugPause stops the process at a test pause point and returns only after
// SIGCONT. Stopping oneself is asynchronous on Linux, so the calling thread
// could otherwise run past the pause point before the stop takes effect.
func debugPause(point string) {
	cont := make(chan os.Signal, 1)
	signal.Notify(cont, syscall.SIGCONT)
	defer signal.Stop(cont)
	fmt.Fprintf(os.Stderr, "cove-tsnet: debug pause at %s pid=%d\n", point, os.Getpid())
	syscall.Kill(os.Getpid(), syscall.SIGSTOP)
	<-cont
}

func runDial(args []string) int {
	var c common
	var idle time.Duration
	var pauseAt string
	fs := flag.NewFlagSet("dial", flag.ContinueOnError)
	c.register(fs, "cove-client")
	fs.DurationVar(&idle, "idle-timeout", 10*time.Minute, "exit after this long without connections")
	// Test-only: stop the process with SIGSTOP at a named point so a fixture
	// can interleave startup and shutdown races (PROTOCOL.md).
	fs.StringVar(&pauseAt, "debug-pause-at", "", "")
	if !parse(fs, args) {
		return exitUsage
	}
	if c.home == "" {
		fmt.Fprintln(os.Stderr, "dial needs --home")
		return exitUsage
	}
	if idle <= 0 {
		fmt.Fprintln(os.Stderr, "--idle-timeout must be positive")
		return exitUsage
	}
	pauses := map[string]bool{}
	for p := range strings.SplitSeq(pauseAt, ",") {
		if p != "" {
			pauses[p] = true
		}
	}
	ctx, cancel := signalContext()
	defer cancel()
	err := dial.Run(ctx, dial.Config{
		Home:        c.home,
		Hostname:    c.hostname,
		ControlURL:  c.controlURL,
		IdleTimeout: idle,
		Build:       buildinfo.String(),
		Start:       node.StartTSNet,
		NodeLogf:    c.nodeLogf(),
		Logf:        eventLogf(),
		Pause: func(point string) {
			if pauses[point] {
				debugPause(point)
			}
		},
	})
	if errors.Is(err, dial.ErrLocked) {
		fmt.Fprintln(os.Stderr, "cove-tsnet dial: another dial daemon owns this directory")
		return exitLocked
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "cove-tsnet dial: %v\n", err)
		return exitError
	}
	return exitOK
}
