// Package buildinfo reports the cove-tsnet build identity exchanged in hello.
package buildinfo

import (
	"runtime/debug"

	"github.com/GhostFlying/cove/native/tailscale/internal/proto"
)

// Build is set by scripts/tsnet-build.mjs through
// -ldflags "-X github.com/GhostFlying/cove/native/tailscale/internal/buildinfo.Build=...".
// The script only accepts identifiers that satisfy proto.ValidBuild.
var Build string

// String returns the build identity. Without an injected value it falls back
// to the VCS revision Go embeds, so two development builds from different
// commits still compare as different builds. An injected value that is not a
// valid identifier (a build not made by the script) reports "invalid", which
// never equals a real build and so is always treated as a different build.
func String() string {
	if Build != "" {
		if proto.ValidBuild(Build) {
			return Build
		}
		return "invalid"
	}
	rev, dirty := "unknown", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				if proto.ValidBuild(s.Value) {
					rev = s.Value
				}
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
	}
	if dirty {
		return "dev+" + rev + "-dirty"
	}
	return "dev+" + rev
}
