# Cove

A focused workspace for tasks and coding agents, across desktop, web, mobile, and remote hosts.

## Status

Early design stage. No application has been implemented yet.
Initial native platforms: macOS desktop, macOS/Linux servers, and iOS/Android mobile.
The macOS desktop uses Electron. A Web App is a phase-two design target,
currently limited to access via Tailscale.
Desktop and web share the Web UI and client protocol layer.
The initial mobile client uses React Native with a WebView-hosted terminal.
The first terminal backend is xterm.js, behind a replaceable adapter.
The server and first-class CLI use TypeScript on Node.js. Terminal processing is
isolated in a bounded subprocess pool, with one authoritative headless model per
PTY using node-pty, @xterm/headless, and @xterm/addon-serialize behind adapters.
The runtime and workers use a unified pipe protocol. The server alone answers
terminal queries. A Go component provides embedded Tailscale.
Each host stores business metadata and configuration in a local SQLite database
accessed through better-sqlite3.
Clients use JSON-RPC 2.0 over HTTP for business operations and separate HTTP
endpoints for file transfer, with separate WebSocket
channels for business events and terminal interaction.
The server uses Fastify with @fastify/websocket for HTTP and WebSocket endpoints.
Zod defines shared business contracts and runtime validation schemas.
Lynx + WebGL / WebGPU is a later evaluation path.

## Intended scope

- One workspace per task, with one or more repository or folder attachments.
- Start terminals at the workspace root, with repository entries beneath it even
  for a single-repository task.
- List only Cove-managed tasks/workspaces and their explicitly attached resources;
  registering a repository does not import its other worktrees.
- Configure multiple repositories when creating a task, or add them later.
- Choose from pre-registered repositories on each execution host.
- Keep managed workspaces under a configurable root on each server; registered
  repositories and existing checkouts can remain at their original paths.
- Start in an existing checkout and move to isolated worktrees when needed.
- Persistent terminal sessions with remote access and reconnection.
- Distinguish running commands, recent activity, and idle terminals independently
  from whether their sessions are still alive.
- No separate PTY keeper in the first release; server restarts explicitly affect
  sessions. Retain tab records for user-directed reopening; terminal snapshots
  and scrollback remain in memory and are not persisted.
- Replaceable terminal backends, independent of task identity and relay lifetime.
- A standalone persistent host server with direct desktop/mobile/web access and
  multi-client state synchronization, without a desktop intermediary.
- Remote access through SSH or system/embedded Tailscale, with separate Cove
  device authorization. No bare LAN/public plaintext endpoint in the first release.
- An independently versioned relay protocol: compatible client updates reuse
  live sessions; protocol mismatches require explicit recovery or reset.
- TUI-only agent interaction in the first release; lightweight chat UI in phase two.
- A mobile client for the same core workflows.
- A phase-two Tailscale-only Web App with separate Cove pairing and revocation. The proposed
  deployment serves the UI and API from one HTTPS/WSS origin, using
  Tailscale-managed certificates without a desktop intermediary.
- No embedded Tailscale in the initial mobile client; use the system Tailscale
  connection. Mobile SSH support remains a later consideration.
- Relay-managed data transfers to support moving tasks between hosts.
- Scheduled tasks are deferred beyond the first release.
- Single-user, multi-device access with revocable device credentials.
- A first-class, domain-organized CLI covering the complete operator surface,
  including every new capability and setting; graphical clients map onto the
  same operations. No user-maintained configuration file is required.
- No initial general settings UI; authenticated operators can configure remote
  servers through the CLI or the same API used by clients.

See [the design draft](docs/design.md) for the task/workspace model, migration
boundaries, and open decisions.
The [relay protocol draft](docs/relay-protocol.md) defines compatibility,
instance discovery, and upgrade behavior.
The [server architecture draft](docs/server-architecture.md) covers direct
connectivity, state ownership, synchronization, and service lifetime.
The [terminal architecture](docs/terminal-architecture.md) records the selected
terminal stack, recovery boundaries, subscription model, and flow-control design.

Cove treats agents as CLI processes running in terminals. Managed agents,
lossless agent-session migration, and agent database rewrites are outside the
first release. Optional rollout copying is still under consideration.

Shepherd is outside the first release. A later integration will treat it as an
independent board system. Detailed implementation choices and validation remain open.
