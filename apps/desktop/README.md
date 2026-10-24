# Cove Desktop

The macOS client connects directly to an independently installed Cove execution
server. Electron main owns the shared `ServerSession`, terminal controllers and
credentials. The sandboxed renderer contains the workbench and bundled xterm view;
it receives domain facts and the bounded, generation-fenced terminal view bridge.
The renderer never receives device tokens or runs a CLI subprocess for business
operations. Server SQLite/PTY addons remain in the standalone Node process.

## Development

Use the repository's pinned Node 26.10.0, pnpm 12.6.0 and TypeScript 7.0.2:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @cove/desktop start
```

`pnpm --filter @cove/desktop dev` uses electron-vite's development renderer.
`build:app` creates the actual main/preload/renderer bundles; `tsc -b` type-checks
source and shared package references. Electron is pinned to 45.0.0, electron-vite
to 6.0.0 and React/ReactDOM to 19.2.0; Vite 8.3.1 and Playwright 1.63.0 use the
existing workspace versions. No installer, auto-update, signing or notarization
flow is provided in M3.

Electron45 declares macOS13+ and arm64 binaries, compatible with Cove's proposed
macOS14 arm64 floor. Running on a newer macOS version does not prove execution on
macOS14. The actual runtime matrix and unexecuted checks belong to PR #219.

Electron's combined vendor declarations reference DOM types from the Node host
declaration file. With TS7 they still report unresolved DOM names in that file
even with the DOM library included. Only the Desktop Node project's vendor
declaration check uses `skipLibCheck`; application source remains strict, renderer
source remains strict, and the rest of the workspace keeps its existing checks.
This workaround is not evidence of runtime compatibility.

## First connection

- Install the execution server explicitly with `cove server install`. If needed,
  start the installed service with `cove server service start`. Desktop displays
  these commands and never installs or replaces a server when it opens.
- Choose **Pair this Mac**, confirm the Cove home, alias and device name. This
  explicit bootstrap reads that home's rendezvous, verifies its loopback identity,
  creates a one-time invitation, redeems an independent device token, and discards
  the local owner credential. Ordinary operations then use that device token.
- For another server, choose **Pair server** and paste its one-time invitation.
  Select SSH or embedded Tailnet explicitly. SSH must already have a trusted host
  key in the normal user's known_hosts. A local-only invitation has no advertised
  remote entries; use **Same host only** on its server's host.
- Select a server, choose a recorded entry, then **Connect**. There is no automatic
  fallback to another entry after failure. Every connection verifies the channel
  peer and the server identity before the token supplier is consulted.

Desktop and CLI share only the per-user resident Tailnet network node under
`<COVE_HOME>/tsnet-client`. Desktop locates its helper at the stable installed
`<COVE_HOME>/install/current/bin/cove-tsnet`; it never keeps the shared daemon
dependent on an app build directory. Tailnet login/status use that daemon's domain
protocol. Explicit CLI logout/stop can disconnect Desktop; the UI marks retained
facts stale instead of claiming the run exited. Desktop quit never stops that
daemon, a server, or a PTY run.

## Workspaces and terminals

Register a repository using its absolute **server-side** path. Create a task with
zero, one or multiple registered repository mounts. Checkout mounts preserve the
existing working directory; worktree mounts create independent server worktrees.
Add/remove/retry mounts, convert a checkout to a worktree, and explicitly delete
a managed worktree through the corresponding controls. The server remains the
authority for revision conflicts, blocking live runs, user changes and partial
per-repository results. **Check paths** obtains a fresh domain observation;
business-event task projections alone do not prove filesystem liveness.

Create/select a terminal tab to attach a real server run. Only the visible view
subscribes to terminal output. Selecting a different page/tab or closing a view
releases its controller, bridge and drawing resources; it leaves the run alive.
**Stop run** is a separate explicit action. **Reopen** creates a new run only after
the server permits it; no old input is replayed. Run history contains retained
lifecycle metadata, not a persistent terminal transcript.

Focus, control and subscription remain separate. The shared controller processes
deliberate focus/input and server control facts. Rendering or reconnecting does
not acquire control on its own. Incomplete/unknown input outcomes are shown with
their written/unknown/not-sent counts. Activity is **unknown** because shell
integration is deferred; output or Enter is never presented as busy/idle proof.

## Credentials, recovery and forgetting

Device tokens persist only in an encrypted credential envelope in Desktop's app
data directory. Its encryption key is protected by macOS Keychain through
Electron45's asynchronous safeStorage API. There is no CLI token-file import and
no plaintext fallback. Keychain denial/unavailability and durable save failure
are errors. If redemption succeeded but storage failed, Desktop does not report
paired; revoke the named leftover device on the server and use a new invitation.
Development builds may be prompted differently by Keychain across changes to the
app signature; stable distribution signing is a later release concern.

Before a domain write is dispatched, Desktop durably saves a bounded, secret-free
operation reference (original server/instance/method/ID). Storage failure prevents
dispatch. After app restart, connect and use **Verify original ID** to query the
same operation. A missing record or a network failure does not prove no effect.
Original intents, terminal input, tokens and invitation secrets are not stored in
this ledger. It is a query ledger, never a deferred-send queue. The shared
session's known same-turn explicit-rejection/retirement issue (#212) remains a
possible conservative unknown result; Desktop does not work around it by replay.

**Revoke device** acts on the server and disconnects that device's authorized
connections. **Forget** only removes this Desktop's stored credential; it does
not revoke remote authorization or delete unresolved operation references.
Completed observations can be acknowledged; unresolved and in-progress operations
remain available for read-only verification.

## Verification boundaries

`pnpm --filter @cove/desktop test` runs the Node/core project after the repository
build: storage/error/crash boundaries and actual compiled standalone-server
integration. Injected test ciphers do not establish Keychain behavior. The actual
Playwright Electron launch, real Keychain store/restore, rendered workbench,
native PTY input/control and app-quit continuity are separate macOS acceptance in
PR #219. Browser-only screenshots do not substitute for that native integration.

Explicit task-only environment settings `COVE_DESKTOP_PROFILE` and
`COVE_DESKTOP_DATA_DIR` isolate development/test app identity and files. `COVE_HOME`
selects the shared network/bootstrap home, independently of Desktop credentials.
Tests create fresh homes/processes/profiles and never operate on an active/default
user server, node, terminal or existing credential entry.
