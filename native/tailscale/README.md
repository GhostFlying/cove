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

## Build and test

```sh
pnpm tsnet:build                       # host binary in native/tailscale/dist/<goos>-<goarch>/cove-tsnet
node scripts/tsnet-build.mjs build --goos linux --goarch arm64 --build <id>
pnpm tsnet:test                        # go vet + go test, including the end-to-end tests
```

Builds are static (`CGO_ENABLED=0`), `-trimpath`, stripped, and compiled with the feature tags in
`scripts/tsnet-build.mjs`. Tests use the same tags. `dist/` is ignored; binaries are not committed.

The end-to-end tests (`internal/e2e`) launch the compiled binary, joined to Tailscale's test control
plane (`tailscale.com/tstest/integration/testcontrol`) with an in-process DERP and STUN server on
loopback. That works from this external module on macOS and Linux and needs no network access,
real tailnet or system `tailscaled`. Limits of that setup:

- testcontrol is not a stable Tailscale API and may change with a `tailscale.com` upgrade.
- With `RequireAuthKey` set, testcontrol also rejects a restored node's re-registration (real
  control does not), so only the rejected-key test enables it.
- Everything runs on one host over loopback and DERP, so NAT traversal, real MagicDNS, ACLs, key
  expiry and admin-console removal are not covered. Those parts of S8/S9 still need a real tailnet.

## License and size

All linked modules are permissively licensed: `tailscale.com` (BSD-3-Clause), gVisor, groupcache,
btree, klauspost/compress, go-proxyproto and go4.org/mem (Apache-2.0), wireguard-go, bart, cbor,
float16 and go-ps (MIT), goupnp (BSD-2-Clause), and the Go `x/` modules and the rest
(BSD-3-Clause). There is no copyleft dependency. Release packaging (M4) must ship their notices.

Stripped binary sizes at v1.104.2 with Go 1.27.3: darwin/arm64 19.3 MB, darwin/amd64 20.7 MB,
linux/amd64 20.5 MB, linux/arm64 19.0 MB (about 7.4–8.0 MB gzip). The omitted features save about
1 MB; nearly all the size is tsnet itself (gVisor netstack, WireGuard, control client).
