# Cove Mobile development app

This is the M3 iOS/Android client, using Expo 55 / React Native 0.83, the public
ServerSession/business mirror and the bundled terminal WebView bridge. The RN
host connects directly to independent Cove servers; Desktop is not required.
Product source and automated tests do not establish physical-device acceptance.

The initial targets are iOS 16 arm64 and Android 12 / API 31 arm64. Expo Go
cannot load the embedded Go library. Build an actual native application.

## Reproduce from a clean checkout

Use the repository's Node and pnpm pins and a separate install/output directory
for each checkout. No generated artifact from another checkout is needed.

```sh
pnpm install --frozen-lockfile
pnpm --filter @cove/mobile prepare:js
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
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility unchanged. Xcode's simulator
application identifier is linked through its simulated entitlement section;
record it separately from the `codesign` entitlement dictionary.

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

The optional EXPO_PUBLIC_COVE_TEST_CONTROL_URL is a compile-time development
fixture bootstrap, never a production connection form field. The native node
root keeps its digest binding before enrollment and checks it before restore.
An enrolled test node requires the same setting after restart; empty/default or
different selection fails without starting it. Logout removes enrollment before
a new explicit selection. Isolated testcontrol results are distinct from real
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

The fixture observes the exact Client and terminal controller it displays.
Connection loss retires that UI and fences late callbacks; execution evidence
is shown separately from a ready subscription, and unknown never means exited.
One bounded latest input notice shows written/unknown/not-sent byte counts or
aggregate rejection counts, without raw input or error content. Explicit node
logout first retires only the Client and its loss observer, then awaits its
single native logout receipt before reporting success. Failed or uncertain
logout is never automatically repeated.

The terminal document embeds the actual compiled xterm view and bridge code and
CSS, without loading a network page. The server remains the sole terminal model
and query responder. Acquiring control requires the explicit control button;
the fixture does not send PTY query replies or create product UI workflows.

## Core workflows and local persistence

1. Start this phone's embedded network node, log in to Tailnet and open the login
   link. Refresh status after enrollment. Cove never uses system Tailscale.
2. Add a server label and one-use invitation from that independent server. Its
   stable peer and Cove identity are checked before credentials are sent. Each
   pairing owns a fresh SecureStore slot (WHEN_UNLOCKED_THIS_DEVICE_ONLY). A
   pending pairing can check its saved slot without redeeming again; if no token
   was saved or redemption is unknown, request a new invitation.
3. Open the server to register remote repositories, create multi-repository tasks
   from existing checkouts or new worktrees, edit mounts and archive tasks. Paths
   always belong to the execution server. Catalog events do not check filesystem
   readiness: task detail reads current server paths and marks stale observations.
   The main-branch input applies to repository updates after registration.
4. Create shell/command tabs, select a verified existing run, view paginated run
   history, explicitly stop or reopen. Reopen starts a new run from its recipe;
   selecting/reconnecting never starts one. Only the selected terminal subscribes.
   Use Control or an actual terminal focus gesture to acquire control. Observers
   keep the authoritative server grid. No reliable shell activity signal exists
   yet, so activity is unknown.
5. Operations shows original IDs, delivery uncertainty, progress, per-mount results
   and server-advertised recovery actions. Query only reads operation.get. Missing
   records do not prove that the effect never happened. Continue/abandon is an
   explicit new operation, never a replay of the original request.
6. Devices lists current registrations and allows explicit revoke. Forget only
   removes this phone's credential slot. Stop node, Tailnet logout, device revoke
   and forget have separate actions and effects.

One app-private SQLite database stores nonsecret profile metadata and operation
references, summaries and immutable canonical digests. It never stores tokens,
invitation secrets, raw RPC arguments or terminal input/output. A transaction
commits each original reference before dispatch; persistence failure prevents the
write. Outcome persistence failure retains the reference as pending/unknown.
Cold-start reconciliation queries only the original ID with the original
credential slot; a new pairing cannot silently adopt old-principal operations.
The summary is not an exact request copy and cannot be dispatched. Completed or
proven not-sent observations can be acknowledged; unresolved rows are never evicted.
Bounds: 64 profiles, eight connected server sessions (other profiles remain
explicitly disconnected), 256 operation rows / 1 MiB encoded journal, UI pages
of 50 rows. Disconnect a server to free a live connection slot. Full capacity
blocks admission before any write; acknowledge terminal observations to make space.

Backgrounding withdraws input/focus and retires owned transports/views. Foreground
recreates sessions for previously connected profiles and verifies identity anew;
restoring a selected old run never acquires control or replays input. Process death
returns to server navigation. WebView content-process loss creates a fresh bridge
generation. Unknown remote execution remains unknown until observed by the server.
Explicit Stop waits for native close and reports stopping/stopped/shutdown-unverified;
a rejected close never becomes a successful stop. OS background fencing remains immediate.
Task/history/device reads retain their actual session-object/instance provenance;
a replacement session cannot inherit a checked-path label through equal local counters.
Retained reads are qualified as stale, and terminal rows consume exact-run lifecycle,
verification and controller/epoch facts without extra PTY subscriptions. Safe failure
categories distinguish credential storage, entry, identity, protocol and authentication.
No background VPN/service or plaintext credential fallback is provided.

## Verification boundary

Run prepare:js, typecheck and test against emitted private modules. Product tests
use isolated SQLite databases and verify admission-before-dispatch, crash/reopen,
unknown/not-found preservation, credential-slot isolation, bounds and late lifecycle
completion. Native ports tests remain separate. Actual Android/iOS app builds,
Metro/Hermes payloads, native SQLite/SecureStore and lifecycle checks must be recorded
with their exact SHA in the PR. Physical input, real Tailnet with Desktop off,
IME/selection and external-keyboard acceptance are still required M3/T7 evidence;
T0 fixture or simulator results do not establish product acceptance.
