# cove-tsnet

Go module that builds `cove-tsnet`, Cove's embedded Tailscale (tsnet) helper: `serve` is the
server's tailnet node (M2 D10), `dial` the per-user client daemon (D14). The local protocols are
specified in [PROTOCOL.md](PROTOCOL.md). M2 T4 and T5b wire the CLI and server to it.

## Toolchain and dependencies

- Go is pinned by the exact `go` line in `go.mod` (currently 1.27.3, the minimum
  `tailscale.com` requires). `scripts/tsnet-build.mjs` refuses any other version and sets
  `GOTOOLCHAIN=local`, so Go never downloads a toolchain on its own. Use `COVE_GO` to point at a
  user-local Go, e.g. `~/.cache/cove-toolchain/go-1.27.3/bin/go`.
- `tailscale.com` is pinned to v1.104.2; `go.sum` pins every module.

## Embedded mobile library

`mobile/` is the app-native library, separate from the server/CLI executables. It
reuses the existing node login/identity-hold manager and exposes bounded HTTP and
WebSocket handles to the native host. Each outbound connection resolves the pinned
stable server node ID and checks WhoIs before writing HTTP bytes. The host must
then verify Cove's pre-authentication serverId before releasing an invitation or
device credential. There is no system Tailscale dependency or inbound listener.

The private native adapter pulls one `NextEvent` result at a time and dispatches it
before pulling again. Go queues at most 64 events / 4 MiB of serialized data;
producers wait for space, while close wakes the outstanding pull and producers.
Only one pull is permitted. At most 32 operations are retained, including completed
handles until `Release`. IDs strictly increase across the Client lifetime, so an
old asynchronous result cannot be mistaken for a newly opened handle. HTTP bodies
are capped while reading (256 KiB maximum response, 64 KiB request); each socket
message is at most 256 KiB, matching the client's transport read budget, with at
most 1 MiB / 128 messages queued per writer. Native and host in-flight copies are
bounded in addition to these queues. These limits are correctness bounds, not
protection against the authenticated owner.

`Post`, `OpenSocket`, `Send` and `Cancel` perform only bounded in-memory admission;
network I/O runs on Go executors. A request remains `not-sent` until the first
possible HTTP write; a later failure is `unknown`, and receipt of response headers
proves `handed-off`. Socket send `handed-off` means admission to the native writer,
never remote acceptance. Cancellation prevents a later first write if it returned
`not-sent`. The host must not replay uncertain requests or terminal input.

Native control methods and `NextEvent` belong on native background executors.
Login/logout invalidate existing entry handles and cancel their traffic. `Close`
stops traffic and the node, retaining enrollment; logout removes only this app's
node state, and forgetting a Cove token is a separate host operation. The app must
provide its own backup-excluded native state directory, keep device tokens in
platform secure storage, and never persist/log native event bodies or login URLs.

Before booting a mobile node, its private root binds the selected control URL
with an atomically published, flushed digest marker. An enrolled state requires
that same explicit selection on restart; a missing or different marker refuses
restore before network activity. A fresh, unenrolled node or a completed local
logout permits selecting another control plane. This is an app-owned bootstrap
boundary, not an automatic migration or a rule for the CLI/shared node manager.

The mobile build uses exact gomobile/gobind tools from the module and the same
feature omission list as server builds. Outputs and tool executables stay under
`native/tailscale/dist/mobile/`, separate from server artifacts:

```sh
node scripts/tsnet-mobile-build.mjs android       # arm64 AAR, minSdk31
node scripts/tsnet-mobile-build.mjs ios           # arm64 XCFramework, min iOS16.0
node scripts/tsnet-mobile-build.mjs ios-simulator # arm64 simulator slice, same target
```

Set `COVE_GO` and platform toolchain variables (`JAVA_HOME`, Android SDK/NDK,
`DEVELOPER_DIR`) per command. No global SDK/toolchain selection is changed.
Library compilation alone does not prove an Expo application, login, real network
transport, lifecycle recovery or physical-device acceptance.

## Build and test

```sh
pnpm tsnet:build                       # host binary in native/tailscale/dist/<goos>-<goarch>/cove-tsnet
node scripts/tsnet-build.mjs build --goos linux --goarch arm64 --build <id>
pnpm tsnet:test                        # go vet + go test, including the end-to-end tests
node scripts/tsnet-build.mjs testcontrol --out PATH   # test-only: the test tailnet command
```

`cove-tsnet-testcontrol` (`cmd/cove-tsnet-testcontrol`, package `internal/testnet`) runs the same
test tailnet the end-to-end tests use, for tests outside this module (the CLI's tsnet scenarios):
it prints the control URL, the test auth key and the environment nodes need as one JSON line and
exits at stdin's end-of-file. It is built only by the `testcontrol` command into the path given, never
by `build`, so it is not in `dist/` or in an installed runtime closure.

Builds are static (`CGO_ENABLED=0`), `-trimpath`, stripped, and compiled with the feature tags in
`scripts/tsnet-build.mjs`. Tests use the same tags. `dist/` is ignored; binaries are not committed.

The end-to-end tests (`internal/e2e`) launch the compiled binary, joined to Tailscale's test control
plane (`tailscale.com/tstest/integration/testcontrol`) with an in-process DERP and STUN server on
loopback. That works from this external module on macOS and Linux and needs no network access,
real tailnet or system `tailscaled`. Limits of that setup:

- testcontrol is not a stable Tailscale API and may change with a `tailscale.com` upgrade.
- With `RequireAuthKey` set, testcontrol also rejects a restored node's keyless re-registration
  (real control does not while the node key is valid), so tests that restart a node use a tailnet
  without it. The reauth test enables it on purpose: together with a per-node key expiry it models
  an enrolled node that needs login again. Without it testcontrol approves the client's automatic
  key rotation, which real control does not.
- Everything runs on one host over loopback and DERP, so NAT traversal, real MagicDNS, ACLs, real
  key expiry and admin-console removal are not covered. Those parts of S8/S9 still need a real
  tailnet.
- Child processes run with `PATH` set to one empty directory, so they could not find a system
  `tailscale` or `tailscaled` even on a host that has Tailscale installed, and run no external
  program at all.

## License and size

All linked modules are permissively licensed: `tailscale.com` (BSD-3-Clause), gVisor, groupcache,
btree, klauspost/compress, go-proxyproto and go4.org/mem (Apache-2.0), wireguard-go, bart, cbor,
float16 and go-ps (MIT), goupnp (BSD-2-Clause), and the Go `x/` modules and the rest
(BSD-3-Clause). There is no copyleft dependency. Release packaging (M4) must ship their notices.

Stripped binary sizes at v1.104.2 with Go 1.27.3: darwin/arm64 19.3 MB, darwin/amd64 20.7 MB,
linux/amd64 20.5 MB, linux/arm64 19.0 MB (about 7.4–8.0 MB gzip). The omitted features save about
1 MB; nearly all the size is tsnet itself (gVisor netstack, WireGuard, control client).
