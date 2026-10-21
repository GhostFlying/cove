# cove-tsnet local protocol, version 1

`cove-tsnet` is Cove's embedded Tailscale helper (M2 D9, D10, D14). It never uses a system
`tailscaled` or the `tailscale` CLI. This document is the contract between `cove-tsnet` and its
two local consumers: the Cove server, which supervises `serve` (T5b), and the CLI, which starts and
uses the `dial` daemon (T4). The Go types live in `internal/proto`; keep them and this document in
sync.

## Versioning

- The local protocol version is an integer (`proto.Version`, currently `1`). Two peers are
  compatible exactly when their versions are equal. It is independent of the Cove protocol version
  and of the application build.
- The **build** is a string identifying the binary: the value injected by
  `scripts/tsnet-build.mjs build --build <id>`, otherwise `dev+<git revision>[-dirty]`. Equal builds
  are the same program.
- **Frozen surface.** These never change in any future version, so a client of any version can
  identify, list and replace a daemon of any other version: the framing below, the `hello` request
  and result, the `streams` entries (`id`, `stableNodeID`, `port`, `label`, `startedAt`), the
  `stop` request, and the response envelope. Any other change to an existing operation, or a
  removed operation, requires a new version.

## Framing

Every control message is one JSON object on one line, terminated by `\n`, at most 65,536 bytes.
Unknown fields are ignored. Longer frames are rejected with `BAD_REQUEST`.

Request:

```json
{"id": "7", "op": "status", ...operation fields}
```

Response:

```json
{"id": "7", "ok": true, "result": {...}}
{"id": "7", "ok": false, "error": {"code": "NOT_LOGGED_IN", "message": "...", "streams": [...]}}
```

`id` is echoed. It is required on the serve control channel, where requests are concurrent and
responses can arrive out of order; on the dial socket it is optional.

### Error codes

| Code                | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `BAD_REQUEST`       | Malformed frame, missing or invalid field, unknown op, first op not `hello`.  |
| `PROTOCOL_MISMATCH` | The client's `hello` protocol differs; only frozen operations are accepted.   |
| `NOT_LOGGED_IN`     | No node, or the node needs login.                                             |
| `ALREADY_LOGGED_IN` | `login` while the node is Running; log out first.                             |
| `LOGIN_FAILED`      | The control plane rejected the login (message is redacted of the key).        |
| `LOGIN_TIMEOUT`     | Login did not finish within the request's timeout.                            |
| `NODE_UNAVAILABLE`  | The node did not reach Running in time, or its local API failed.              |
| `PEER_NOT_FOUND`    | No peer with the requested stable node ID is visible in the netmap.           |
| `PEER_MISMATCH`     | The connected address answered WhoIs as a different node, or WhoIs failed.    |
| `DIAL_FAILED`       | The tailnet connection failed (for example, nothing listens on that port).    |
| `ACTIVE_STREAMS`    | `logout`/`stop` without `force` while streams are open; `streams` lists them. |
| `TOO_MANY_STREAMS`  | 256 streams are already open.                                                 |
| `SHUTTING_DOWN`     | The daemon is exiting.                                                        |
| `LISTEN_FAILED`     | `serve` could not open a requested tailnet port.                              |
| `INTERNAL`          | Anything else.                                                                |

### Status object

Returned by `status`, `login`, `logout` and `setPorts`:

```json
{
  "state": "Running",
  "authURL": "https://login.tailscale.com/a/…",
  "self": {
    "stableNodeID": "nXXXXCNTRL",
    "name": "cove-devbox.tailnet.ts.net",
    "hostName": "cove-devbox",
    "loginName": "user@example.com",
    "tailscaleIPs": ["100.64.0.1", "fd7a:…"]
  },
  "ports": [7443],
  "streams": [],
  "warnings": []
}
```

`state` is a Tailscale backend state (`NoState`, `NeedsLogin`, `NeedsMachineAuth`, `Starting`,
`Running`, `Stopped`), `LoggedOut` when no node state exists, or `Unavailable` when state exists but
the node failed to start (`warnings` says why). `authURL` is present while an interactive login is
pending; whoever opens it can attach the node to their tailnet, so it is returned only to the
requesting owner and never logged. Names come from the control plane and are display data; only
`stableNodeID` identifies a node.

## Secrets and output

- An auth key is accepted only as the `authKey` field of a `login` request: from stdin for `serve`,
  from the 0700 socket for `dial` (the CLI reads it from its own stdin or prompt). There is no flag
  for it. On startup `cove-tsnet` unsets `TS_AUTHKEY`, `TS_AUTH_KEY`, `TS_CLIENT_SECRET`,
  `TS_CLIENT_ID`, `TS_ID_TOKEN`, `TS_AUDIENCE`, `TS_CONTROL_URL` and `TSNET_FORCE_LOGIN`, so inherited
  values never take effect.
- The key is never written to stdout, stderr, the state directory or any error message. tsnet keeps
  only the node key and state it derives (file store, 0600 in a 0700 directory).
- stderr carries one-line events with stream IDs, stable node IDs and ports only. `--verbose` adds
  tsnet backend logs, which can include login URLs; use it only for debugging.
- Log upload to Tailscale is disabled (`TS_NO_LOGS_NO_SUPPORT`, and logtail is compiled out).
- Every file and directory is created with umask 077.

## Exposure

Both modes are built without Tailscale's PeerAPI server and without SSH, Taildrop, Drive, the web
client, peer relay, exit-node or subnet-router support (`scripts/tsnet-build.mjs`). The client
node therefore listens on no tailnet port, and the server node only on the ports requested with
`setPorts`; tsnet's userspace stack resets connections to any other port. The end-to-end tests
check this from a third node.

## `cove-tsnet dial` (client daemon, D14)

```sh
cove-tsnet dial --home <cove home>/tsnet-client [--hostname NAME] [--control-url URL] [--idle-timeout 10m] [--verbose]
```

One daemon per OS user owns the client node. The CLI starts it detached when it cannot connect.

### Files

| Path                   | Mode | Purpose                                                               |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| `<home>/`              | 0700 | Created if missing; looser modes are tightened, other owners refused. |
| `<home>/run/`          | 0700 | Lock and socket.                                                      |
| `<home>/run/lock`      | 0600 | Kernel `flock(LOCK_EX)`; held for the daemon's whole life.            |
| `<home>/run/dial.sock` | 0600 | The CLI socket. The path must be at most 103 bytes.                   |
| `<home>/state/`        | 0700 | tsnet node state. Created on first login, deleted by logout.          |

Trust on the socket is file permissions only: anyone who can connect is the owning user (D7). The
daemon holds no Cove device token; the CLI sends the token through the stream.

### Lifecycle

1. Take the lock without blocking. If another process holds it, exit with code **75** and touch
   nothing else.
2. Remove any socket file (it can only belong to a dead owner), listen, and accept requests at once.
   If node state exists, the node starts in the background; requests that need it wait boundedly.
   A daemon without state never contacts the control plane until `login`.
3. Exit after `--idle-timeout` with no connections at all (an open stream or an in-flight request
   keeps it alive), on `stop`, or on SIGINT/SIGTERM. Exit order: unlink the socket, close streams,
   close the node (state kept), release the lock by exiting. Exit code 0.

Exit codes: `0` normal, `1` error (stderr says why), `2` usage, `75` lock held.

**CLI startup loop (T4).** Ownership is decided by the lock, not by the socket file. A daemon can
hold the lock with no socket (starting, or idle-exiting after unlink), and a socket file can exist
with no daemon (after SIGKILL). So the CLI, within one total deadline (default 10 s): connect to the
socket; on failure spawn a daemon and back off briefly; repeat. Exit code 75 from a spawned daemon
only means "someone else holds the lock right now", not that it will become ready. Only once a
connection is established and `hello` answered may the CLI send a business request; after that, a
broken connection is a connection loss, never retried silently.

### Connection

Each connection carries `hello`, then at most one request. A connection that sends only `hello`
and closes is fine (version probe). `hello` and the request must arrive within 10 s.

`hello` (frozen):

```json
{"op": "hello", "protocol": 1, "build": "<cli build>"}
→ {"ok": true, "result": {"protocol": 1, "build": "<daemon build>", "mode": "dial", "pid": 4242,
                          "streams": [{"id": "s3", "stableNodeID": "n…", "port": 7443, "label": "attach task-1",
                                       "startedAt": "2026-10-21T09:00:00Z"}]}}
```

The daemon answers `hello` whatever the client's version. If `protocol` differs, every later
request except `stop` fails with `PROTOCOL_MISMATCH`. Version rules for the CLI (D14): same build →
continue; different build and no streams → `stop`, then start the current binary; different build
with streams → continue with a stderr warning if the protocol matches, otherwise fail with a
version-mismatch error listing the streams.

### Operations

| Op       | Fields                                                                                       | Result                            |
| -------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `status` | —                                                                                            | Status (with `streams`)           |
| `login`  | `authKey?`, `timeoutMs?` (default 60 s, max 5 min)                                           | Status                            |
| `logout` | `force?`                                                                                     | Status (`LoggedOut`)              |
| `stop`   | `force?` (frozen)                                                                            | `{}`, then the daemon exits       |
| `dial`   | `target.stableNodeID`, `port`, `label?` (≤ 200 bytes), `timeoutMs?` (default 15 s, max 60 s) | `{streamId, peer}` then raw bytes |

`login`, `logout` and `stop` are serialized with each other and with `status` and stream setup;
established streams continue during them.

- `login` with `authKey` (re)starts the node with the key and waits for Running. On failure, a node
  that had no state before has its partial state deleted, so no half-logged-in node remains. Without
  `authKey` it starts an interactive login and returns as soon as `authURL` is known (or the node is
  Running); the CLI shows the URL and polls `status`. `ALREADY_LOGGED_IN` if Running.
- `logout` and `stop` with open streams and no `force` fail with `ACTIVE_STREAMS` and change
  nothing. With `force` they close the streams first. `logout` then deauthorizes the node with the
  control plane (10 s bound) and deletes `<home>/state`; if the control plane cannot be reached the
  state is still deleted and `warnings` says the node may remain in the admin console. `stop`
  unlinks the socket before replying, so a reconnect never reaches the exiting daemon.
- `dial` resolves `target.stableNodeID` in the current netmap (waiting up to 5 s for it to appear),
  dials that peer's Tailscale address (IPv4 preferred), and keeps the connection only if WhoIs on
  its remote address reports the same stable ID. It never resolves a DNS name. On success the
  response line is followed by raw bytes in both directions; half-close is propagated. The CLI must
  not send stream bytes before reading the response.

## `cove-tsnet serve` (server node, D10)

```sh
cove-tsnet serve --home <cove home>/tsnet --forward-socket <dir>/<name>.sock [--hostname cove-<host>] [--control-url URL] [--verbose]
```

A child of the Cove server. Node state lives in `<home>/state/` (0700). The forward socket's
directory must already exist, be owned by the user and have no group/other permissions, or serve
exits with code 1. Serve exits 0 when stdin reaches EOF (the server went away) or on SIGINT/SIGTERM,
closing listeners and the node and keeping the state.

### Control channel

Requests on stdin, responses on stdout, each with an `id`. Requests run concurrently;
`login`, `logout` and `setPorts` are serialized with each other and with `status`. The first
request must be `hello`.

| Op         | Fields                   | Result                              |
| ---------- | ------------------------ | ----------------------------------- |
| `hello`    | `protocol`, `build`      | Hello (`mode: "serve"`, no streams) |
| `status`   | —                        | Status (with `ports`)               |
| `login`    | `authKey?`, `timeoutMs?` | Status — same semantics as dial     |
| `logout`   | —                        | Status (`LoggedOut`)                |
| `setPorts` | `ports` (≤ 16, 1–65535)  | Status                              |

`setPorts` is declarative: it sets the full list of tailnet TCP ports to listen on (business port,
plus the pairing port while an invitation is open). The list is kept and reapplied whenever a node
starts (restored state or login), so after a restart the server sends it once. Closing a port never
affects connections already accepted on it. While logged out nothing listens. `logout` closes every
listener and every connection.

### Forwarded connections

For each accepted tailnet connection, serve connects to the forward socket (5 s bound; on failure
the tailnet connection is closed), writes one header line, then copies raw bytes both ways with
half-close:

```json
{
  "protocol": 1,
  "port": 7443,
  "remoteAddr": "100.64.0.2:51234",
  "peer": {
    "stableNodeID": "n…",
    "name": "laptop.tailnet.ts.net",
    "hostName": "laptop",
    "loginName": "user@example.com",
    "tailscaleIPs": ["100.64.0.2"]
  },
  "whoIsError": ""
}
```

`peer` is the WhoIs result for `remoteAddr`, or `null` with `whoIsError` set. It is for display and
audit only and never authorizes anything: the connection still needs a Cove device token. At most
512 forwarded connections are open at once; more are closed on accept.

## Test pause points

`cove-tsnet dial --debug-pause-at <point>[,<point>]` makes the daemon print
`cove-tsnet: debug pause at <point> pid=<pid>` to stderr and stop itself with SIGSTOP. It does not
continue past the point until it receives SIGCONT, so a test fixture can interleave races and then
SIGCONT or SIGKILL it. It is for tests only.

| Point      | State when paused                                                                          |
| ---------- | ------------------------------------------------------------------------------------------ |
| `locked`   | Lock held, stale socket not yet removed, not listening (a race winner before it is ready). |
| `unlinked` | Exiting: socket removed, lock still held (idle exit or stop between unlink and unlock).    |
