# Cove Native development fixture

This is the M3 native transport fixture, using Expo 55 / React Native 0.83 and
the existing Cove client and terminal WebView bridge. It provides explicit
Tailnet login, one secure Cove pairing, RPC verification, and attachment to an
existing isolated test tab. It is not the product navigation or session list.

The initial targets are iOS 16 arm64 and Android 12 / API 31 arm64. Expo Go
cannot load the embedded Go library. Build an actual native application.

## Reproduce from a clean checkout

Use the repository's Node and pnpm pins and a separate install/output directory
for each checkout. No generated artifact from another checkout is needed.

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b packages/terminal-web/tsconfig.production.json
pnpm --filter @cove/mobile build:terminal
pnpm --filter @cove/mobile typecheck
pnpm --filter @cove/mobile test
```

Expo's configuration loader requires TypeScript 5's `transpileModule`, which is
absent from the repository's TypeScript 7 API. The app pins TypeScript 5.9.3
privately for that loader only. Both app typecheck and compiled port tests invoke
the root TypeScript 7.0.2 executable explicitly; strict peer checks stay enabled.

The RN host imports this app's compiled private ports from `dist/`, the same
artifacts exercised by its compiled tests. Their NodeNext `.js` imports resolve
to real emitted files in Metro as well as Node, without a source alias or custom
resolver. `prepare:js` builds those ports and the offline terminal document;
`start`, `android` and `ios` run it before invoking Expo. The terminal build also
builds its referenced public view artifacts when starting from a clean checkout.

Build the embedded library using the scoped SDK/toolchain environment described
in [the native README](../../native/tailscale/README.md). The commands below use
repository-relative outputs; SDK locations may be supplied through environment
variables without changing global Xcode, Java or service state.

```sh
# Run from the repository root, one platform at a time.
node scripts/tsnet-mobile-build.mjs android
node apps/mobile/scripts/prepare-native.mjs android
node scripts/tsnet-mobile-build.mjs ios
node apps/mobile/scripts/prepare-native.mjs ios
pnpm --filter @cove/mobile prebuild
```

CNG generates the ignored `apps/mobile/android` and `apps/mobile/ios` projects.
Local Expo modules under `modules/cove-tsnet` are source; only their `generated`
binding artifacts are ignored. Android compiles against the extracted AAR's
Java classes and packages its arm64 JNI library. iOS links the generated arm64
XCFramework. A simulator requires its own `ios-simulator` library build; a
device-only framework is not simulator evidence. The Apple module config explicitly
names the module-root podspec: Expo's implicit scan searches child directories,
while the root podspec is needed so CocoaPods includes the generated framework.

For an installed arm64 iOS Simulator runtime, build `ios-simulator` with the
native build script and pass `ios-simulator` to `prepare-native.mjs`. This selects
that actual framework for the same local pod. Rerun `pod install` after switching
between device and simulator artifacts. Return to `prepare-native.mjs ios` before
building for a device. A simulator run is intermediate functionality evidence;
it does not validate physical-device input, background policy or performance.

Simulator credential checks need an app with its normal local signing and
application entitlement. A `CODE_SIGNING_ALLOWED=NO` compile/link result does
not validate Keychain writes: the synthetic same-options probe returns
`missing-entitlement` on that unsigned simulator app. For a local simulator
build, use Xcode's ordinary ad-hoc identity (`CODE_SIGN_IDENTITY=-`,
`CODE_SIGNING_ALLOWED=YES`) and inspect the resulting signature/entitlements
before recording the probe result. This requires no Apple account, device
registration or physical-device provisioning change. Keep SecureStore's
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility unchanged.

For an ordinary development build, start Metro with `pnpm --filter @cove/mobile
start` and use `pnpm --filter @cove/mobile android` or `ios`. The generated Android
project also supports a serial arm64 build without launching or adopting a
device:

```sh
cd apps/mobile/android
./gradlew :app:assembleDebug --no-daemon --max-workers=2 \
  -Dorg.gradle.parallel=false -PreactNativeArchitectures=arm64-v8a
```

An APK build, an XCFramework build, and successful TypeScript tests do not prove
native app launch, login, network payload exchange, signing or physical-device
behavior. Record these separately in the task PR. A debug Android build normally
needs reachable Metro; a bundled build is needed for an offline cloud-device
installation. Generated development signing is not release distribution.

## Ownership and verification behavior

The app owns one embedded tsnet node in platform-private, backup-excluded app
storage. Fresh installation does not log in automatically. Tailnet enrollment
and Cove's device token are separate: forgetting Cove does not log out Tailnet,
and node logout does not revoke an existing Cove pairing. SecureStore must
successfully persist a pairing before the UI reports it saved; there is no
plaintext fallback. Invitation secrets and auth keys are not logged.

The embedded process explicitly keeps Tailscale diagnostic state in this node
root's private `logs/` directory, outside the enrollment subtree that logout
removes. It does not change the host environment or use a system Tailscale path.
On Android, `ACCESS_NETWORK_STATE` permits observing real `ConnectivityManager`
and `LinkProperties` snapshots. A single registered Go interface getter reads
bounded immutable snapshots, and native OS callbacks wake the existing tsnet
monitor. The app creates no VPN service and does not bind the process to another
network. Stop and native generation checks reject obsolete callbacks.

Native control failures expose only a fixed vocabulary of bounded categories and
safe reasons. Original Go errors, control-plane bodies, credentials and URLs are
never reflected into these diagnostics or default logs. A failure remains an
unverified outcome; its reason does not authorize automatically repeating login,
logout, RPC or terminal input.
Pairing failures additionally retain a fixed stage and the request/redemption
delivery dispositions. An identity check may have reached the server while
redemption is still `not-sent`; a persistence failure can follow a handed-off
redemption. These diagnostics never authorize repeating a redemption.
The fixture can independently check secure storage with a fresh synthetic key,
using the same API and accessibility options as pairing. Success requires
write/read/delete; failures expose only fixed platform categories and whether
synthetic-key deletion was confirmed. The saved pairing record is untouched.

The fixture's optional control URL is an explicit local bootstrap setting. Edit
it and reconnect before login; the field is not persisted. The native node root
keeps a digest binding before enrollment can start, and checks it before any
restore. An enrolled node requires the same selection after process restart;
an empty/default or different value fails without starting it. Logout removes
enrollment and permits a new explicit selection. There is no automatic control
plane migration or adoption of another node's state. Isolated testcontrol plus
a fresh cloud-device lease can validate real embedded-tsnet app payloads without
creating a real Tailnet node; that result is recorded separately from real
Tailnet and physical-device coverage.

Each native call is bound to a node generation, so a delayed event pull, close,
cancel or release cannot affect a newer foreground node. Native background hooks
stop admission immediately. JS releases its connection and view; foreground
creates a fresh host, rechecks peer identity and `serverId`, then reconnects. It
reattaches only a previously selected, still-live exact run. Network loss never
means the remote process exited and never creates a replacement run.

Every TCP connection passes the selected stable peer's WhoIs check before HTTP
bytes, including credentials, are written. Bootstrap verifies `serverId` before
pair redemption or authenticated RPC. HTTP response and individual WebSocket
payloads are capped at 256 KiB; native operations, event queues and sends have
independent bounds. One asynchronous pull drains the native queue. Synchronous
native calls perform bounded local admission only. `/terminal` and `/events`
share raw transport support; their protocol owners validate their own schemas.

Cancellation reports `not-sent` only while the native first-write guard proves
that no request bytes could have been written. A bridge exception or possible
write remains `unknown`; the UI never retries uncertain pairing, RPC or input.
Backgrounding closes client transports but does not stop server-owned PTYs.

The terminal document embeds the actual compiled xterm view and bridge code and
CSS, without loading a network page. The server remains the sole terminal model
and query responder. Acquiring control requires the explicit control button;
the fixture does not send PTY query replies or create product UI workflows.
