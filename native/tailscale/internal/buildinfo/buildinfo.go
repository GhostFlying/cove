// Package buildinfo reports the cove-tsnet build identity exchanged in hello.
package buildinfo

import "runtime/debug"

// Build is set by scripts/tsnet-build.mjs through
// -ldflags "-X github.com/GhostFlying/cove/native/tailscale/internal/buildinfo.Build=...".
var Build string

// String returns the build identity. Without an injected value it falls back
// to the VCS revision Go embeds, so two development builds from different
// commits still compare as different builds.
func String() string {
	if Build != "" {
		return Build
	}
	rev, dirty := "unknown", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
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
