import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
  unlink,
  readdir,
  realpath,
  mkdir,
  chmod,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApplication } from "../../dist/entry/main.js";
import { validateLocalOptions, parseLocalOptions } from "../../dist/entry/m0-local-options.js";
import { LocalRendezvous, launchIdentity } from "../../dist/entry/local-rendezvous.js";
import { LocalRuntimeClock } from "../../dist/terminal/local-runtime-clock.js";
import { WorkerProcess } from "../../dist/terminal/worker-process.js";
import { actualHeaders } from "../../dist/transport/local-admission.js";
import { TerminalWebSocket } from "../../dist/transport/terminal-websocket.js";
import { rpcBody, boundRpcResponseBody } from "../../dist/transport/http-rpc.js";
import { createPipeDecoder, encodePipeFrame } from "@cove/protocol/pipe";
import { encodeTerminalFrame, MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import { REQUIRED_CAPABILITIES, BootstrapFailureSchema } from "@cove/protocol/bootstrap";
import { composeRpcResponse } from "@cove/protocol/rpc";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { ConnectionRefSchema } from "@cove/protocol/identity";
import { qualifiedWebSocketCarrier } from "../independent/qualified-websocket-carrier.mjs";

async function recordAuthor(name, data) {
  const sink = process.env.COVE_D_AUTHOR_OUTPUT;
  if (!sink) return;
  await mkdir(sink, { recursive: true });
  await writeFile(join(sink, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}
const identity = {
  serverId: "author-server",
  relayInstanceId: "author-instance",
  secret: "s".repeat(43),
};
const options = {
  mode: "m0-local",
  host: "127.0.0.1",
  port: 32123,
  rendezvousPath: join(tmpdir(), "cove-author-rendezvous"),
  allowedOrigins: ["http://127.0.0.1:32124"],
};
const bootstrap = {
  type: "cove-bootstrap",
  bootstrapVersion: 1,
  protocolVersion: 2,
  buildVersion: "different-build",
  capabilities: [...REQUIRED_CAPABILITIES],
  profiles: [PROFILE],
  encodings: [BASELINE_ENCODING],
};
const auth = { host: "127.0.0.1:32123", authorization: `Bearer ${identity.secret}` };
const business = {
  ...auth,
  "cove-protocol": "2",
  "cove-server-id": identity.serverId,
  "cove-instance-id": identity.relayInstanceId,
};
const statusCall = { jsonrpc: "2.0", id: "status", method: "server.status", params: {} };
const utf8 = (input) => Buffer.from(JSON.stringify(input));
async function withApp(body, budgets = { ...M0_LIMITS }) {
  const local = createLocalApplication(options, { identity, budgets });
  try {
    await local.app.ready();
    return await body(local);
  } finally {
    await local.app.close();
    local.disposeCore();
  }
}

function workerWriteControl(core, mode) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const failure = new Error("real lower Writable failure");
  const decoder = createPipeDecoder();
  const events = [];
  let completeWrite;
  let worker;
  let resolveCallback;
  const callbackDelivered = new Promise((resolve) => {
    resolveCallback = resolve;
  });
  child.stdin = new Writable({
    write(bytes, _encoding, completed) {
      const frames = decoder.read(bytes).frames;
      events.push({
        type: "lower-write",
        bytes: Buffer.from(bytes).toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        metadata: frames.map((frame) => JSON.parse(Buffer.from(frame.metadata).toString())),
      });
      if (mode === "late") {
        completeWrite = completed;
        return;
      }
      if (mode === "error") {
        completed(failure);
        return;
      }
      for (const frame of frames) {
        const hello = JSON.parse(Buffer.from(frame.metadata).toString());
        const readyBytes = encodePipeFrame(
          2,
          utf8({ ...hello, type: "ready" }),
          new Uint8Array(),
        ).value;
        events.push({
          type: "ready-frame",
          bytes: Buffer.from(readyBytes).toString("base64"),
          sha256: createHash("sha256").update(readyBytes).digest("hex"),
        });
        child.stdout.write(readyBytes);
      }
      completed();
    },
  });
  const originalWrite = child.stdin.write;
  child.stdin.write = function (bytes, callback) {
    const returned = Reflect.apply(originalWrite, this, [
      bytes,
      function (error) {
        events.push({
          type: "callback-before",
          category: error === null ? "NULL" : error === undefined ? "UNDEFINED" : "ERROR",
          sameError: error === failure,
          error: error instanceof Error ? { name: error.name, message: error.message } : null,
          session: worker.session.snapshot(),
        });
        try {
          return Reflect.apply(callback, this, [error]);
        } finally {
          events.push({
            type: "callback-after",
            snapshot: worker.snapshot(),
            session: worker.session.snapshot(),
          });
          resolveCallback(error);
        }
      },
    ]);
    events.push({ type: "write-return", returned });
    return returned;
  };
  child.stdin.on("finish", () => child.stdin.destroy());
  child.stdin.on("close", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  worker = new WorkerProcess(
    core.runtime,
    {
      serverId: identity.serverId,
      relayInstanceId: identity.relayInstanceId,
      workerId: `write-${mode}`,
      workerIncarnationId: "birth",
    },
    () => 0,
    () => child,
  );
  return {
    child,
    worker,
    failure,
    events,
    callbackDelivered,
    finishLowerWrite: () => completeWrite(),
  };
}

class Socket extends EventEmitter {
  sent = [];
  codes = [];
  send(bytes, callback) {
    this.sent.push(typeof bytes === "string" ? bytes : Buffer.from(bytes));
    callback();
  }
  close(code) {
    this.codes.push(code);
  }
  finish() {
    this.emit("close");
    this.emit("close");
  }
}
function timerFixture() {
  const jobs = new Set();
  return {
    jobs,
    set: (callback) => {
      jobs.add(callback);
      return callback;
    },
    clear: (callback) => jobs.delete(callback),
    fire: () => {
      const first = jobs.values().next().value;
      if (first) {
        jobs.delete(first);
        first();
      }
    },
  };
}
async function withWs(body, budgets = { ...M0_LIMITS }) {
  await withApp(async (local) => {
    const timer = timerFixture();
    let now = 0;
    const terminal = new TerminalWebSocket(
      local.admission,
      local.core,
      local.arbiter,
      () => now,
      timer,
    );
    const peers = [];
    const open = () => {
      const prepared = terminal.prepare(auth);
      expect(prepared.kind).toBe("accepted");
      const socket = new Socket();
      peers.push(socket);
      terminal.accept(socket, prepared.claim);
      return socket;
    };
    try {
      await body({
        local,
        terminal,
        timer,
        open,
        time: (value) => {
          now = value;
        },
      });
    } finally {
      terminal.close();
      for (const peer of peers) peer.finish();
    }
  }, budgets);
}

const wsClassificationControls = [
  {
    id: "D-A39.valid-version1",
    group: "A39",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-result",
        bootstrapVersion: 1,
        serverId: "author-server",
        relayInstanceId: "author-instance",
        protocolVersion: 2,
        buildVersion: "0.0.0",
        capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
        profile: "pragmatic-logical-grid-v1",
        encoding: "vt-checkpoint-tail-v1",
        effectiveBudgets: "CURRENT_DEFAULT_M0_LIMITS_FULL_EQUAL",
        connection: "ACTUAL_FULL_CONNECTION_REF_SCHEMA",
      },
      closeCodes: [],
      authenticated: 1,
      unauthenticated: 0,
      rpc: 0,
      services: 1,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.unsupported-version2",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "BOOTSTRAP_UNSUPPORTED",
        message: "BOOTSTRAP UNSUPPORTED",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.unsupported-version2-held",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: true,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "BOOTSTRAP_UNSUPPORTED",
        message: "BOOTSTRAP UNSUPPORTED",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.protocol-mismatch",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 3,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "PROTOCOL_MISMATCH",
        message: "PROTOCOL MISMATCH",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.capability-unavailable",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: [],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "CAPABILITY_UNAVAILABLE",
        message: "CAPABILITY UNAVAILABLE",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.profile-unsupported",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["unsupported-profile"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "PROFILE_UNSUPPORTED",
        message: "PROFILE UNSUPPORTED",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A40.encoding-unsupported",
    group: "A40",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["unsupported-encoding"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: {
        type: "cove-bootstrap-error",
        kind: "PROFILE_UNSUPPORTED",
        message: "PROFILE UNSUPPORTED",
        supportedVersions: {
          bootstrap: [1],
          protocol: [2],
        },
      },
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.wrong-secret",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "wrong",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.absent-secret",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "absent",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 0,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.invalid-secret-grammar",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "invalid",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.wrong-type",
    group: "A41",
    input: {
      type: "wrong",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.missing-build",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: null,
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.invalid-protocol",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 0,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.long-build",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.long-capability",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.invalid-profile-type",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: 1,
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.tag-string",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: "2",
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.tag-zero",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 0,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.tag-fraction",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2.5,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.oversize",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: false,
    oversize: true,
    held: false,
    expected: {
      response: null,
      closeCodes: [1009],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 0,
      clockReads: 1,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.late-time",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 5001,
    binary: false,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1008],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 1,
      clockReads: 2,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
  {
    id: "D-A41.binary",
    group: "A41",
    input: {
      type: "cove-bootstrap",
      bootstrapVersion: 2,
      expectedServerId: "author-server",
      expectedRelayInstanceId: "author-instance",
      protocolVersion: 2,
      buildVersion: "different-build",
      capabilities: ["terminal-framing-v2", "logical-grid-recovery-v1"],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    },
    secretKind: "current",
    elapsed: 0,
    binary: true,
    oversize: false,
    held: false,
    expected: {
      response: null,
      closeCodes: [1002],
      authenticated: 0,
      unauthenticated: 0,
      rpc: 0,
      services: 0,
      verifyCalls: 0,
      clockReads: 1,
      finallyClosed: true,
      finallyLedgerTotal: 0,
      finallyLive: {
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      },
      timerJobs: 0,
    },
  },
];

async function wsClassificationControl(control) {
  const events = [];
  const errors = [];
  const timer = timerFixture();
  let now = 0;
  let clockReads = 0;
  let verifyCalls = 0;
  const local = createLocalApplication(options, {
    identity,
    timer,
    monotonic: () => {
      clockReads++;
      return now;
    },
  });
  const originalVerify = local.admission.verifies;
  local.admission.verifies = function (...args) {
    verifyCalls++;
    return Reflect.apply(originalVerify, this, args);
  };
  const redact = (raw) => {
    const bytes = Buffer.from(raw);
    const text = bytes.toString();
    return {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      redactedBase64: Buffer.from(
        text.replaceAll(identity.secret, "?".repeat(43)).replaceAll("w".repeat(43), "?".repeat(43)),
      ).toString("base64"),
      actualPrivateBytesNotPublished: true,
    };
  };
  const capture = (event, value) => {
    events.push({
      ordinal: events.length + 1,
      event,
      ...value,
      raw: value.raw === undefined ? undefined : redact(value.raw),
      bytes: value.bytes === undefined ? undefined : redact(value.bytes),
      error:
        value.error instanceof Error
          ? { name: value.error.name, message: value.error.message }
          : value.error,
      counts: local.admission.snapshot(),
      ledger: local.core.runtime.composition.bytes.snapshot(),
    });
  };
  const carrier = qualifiedWebSocketCarrier(control.id, capture, control.held);
  let actual;
  try {
    await local.app.ready();
    const prepared = local.terminal.prepare(auth);
    capture("actual-public-prepare", { kind: prepared.kind, claimPresent: !!prepared.claim });
    if (!prepared.claim) throw new Error("Expected fixed author upgrade admission");
    local.terminal.accept(carrier.socket, prepared.claim);
    const input = structuredClone(control.input);
    if (control.secretKind === "current") input.secret = identity.secret;
    if (control.secretKind === "wrong") input.secret = "w".repeat(43);
    if (control.secretKind === "invalid") input.secret = "!".repeat(43);
    const bytes = control.oversize ? Buffer.alloc(8193, 32) : utf8(input);
    now = control.elapsed;
    capture("fixed-input-before-message", {
      bytes,
      input: control.input,
      secretKind: control.secretKind,
      elapsed: now,
      binary: control.binary,
      expected: control.expected,
    });
    carrier.message(bytes, control.binary);
    await carrier.settle();
    const response = carrier.writes.length ? JSON.parse(carrier.writes[0].toString()) : null;
    actual = {
      response,
      closeCodes: [...carrier.closeCodes],
      authenticated: local.admission.snapshot().authenticated,
      unauthenticated: local.admission.snapshot().unauthenticated,
      rpc: local.admission.snapshot().rpc,
      services: local.terminal.services.size,
      verifyCalls,
      clockReads,
      timerJobs: timer.jobs.size,
    };
    await recordAuthor(control.id + "-before-guards", {
      control,
      actual,
      events,
      actualResponseBytes: carrier.writes.map(redact),
      ownedBaselineDistinct: local.core.runtime.composition.bytes.snapshot(),
    });
  } catch (error) {
    errors.push(error);
    await recordAuthor(control.id + "-primary-before-finally", {
      error: { name: error.name, message: error.message },
      events,
    });
  } finally {
    for (const cleanup of [
      () => carrier.dispose(),
      () => local.terminal.close(),
      () => local.app.close(),
      () => local.disposeCore(),
      () => {
        local.admission.verifies = originalVerify;
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (actual) {
      actual.finallyClosed = carrier.transport.closed;
      actual.finallyLedgerTotal = local.core.runtime.composition.bytes.snapshot().total;
      actual.finallyLive = local.admission.snapshot();
    }
    await recordAuthor(control.id + "-finally", {
      actual,
      events,
      counts: local.admission.snapshot(),
      ledger: local.core.runtime.composition.bytes.snapshot(),
      errors: errors.map((error) => ({ name: error.name, message: error.message })),
    });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "WS classification control body/cleanup");
  return actual;
}

const batchEnvelopeAuthorControls = [
  {
    id: "D-A36.invalid-member-array",
    group: "A36",
    payload: [false],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: [{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }],
      dispatchCount: 0,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A36.valid-singleton-array",
    group: "A36",
    payload: [{ jsonrpc: "2.0", id: "A36-single", method: "server.status", params: {} }],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: [
        {
          jsonrpc: "2.0",
          id: "A36-single",
          result: {
            serverId: "author-server",
            relayInstanceId: "author-instance",
            buildVersion: "0.0.0",
            protocolVersion: 2,
            profile: "pragmatic-logical-grid-v1",
            effectiveBudgets: {
              maxRuns: 128,
              maxCols: 120,
              maxRows: 40,
              historyLines: 1000,
              listPage: 128,
              baselineVtBytes: 8388608,
              baselineTailBytes: 65536,
              baselineChunks: 129,
              recoveryDeadlineMs: 15000,
              concurrentGenerationsPerWorker: 2,
              replayBytes: 1048576,
              replayEvents: 4096,
              postNBytes: 1048576,
              postNEvents: 4096,
              parseLowBytes: 131072,
              parseHighBytes: 524288,
              parseHardBytes: 1048576,
              inputQueueBytes: 65536,
              pendingWorkerCommands: 256,
              subscriptionCreditBytes: 262144,
              outboundConnectionBytes: 1048576,
              reservedControlBytes: 65536,
              subscriptionsPerConnection: 16,
              authenticatedSockets: 32,
              unauthenticatedSockets: 8,
              pipeQueuedBytes: 4194304,
              previewBytesPerRun: 65536,
              previewGlobalBytes: 8388608,
              previewRefreshes: 4,
              bootstrapBytes: 8192,
              rpcRequestBytes: 65536,
              rpcResponseBytes: 262144,
              rpcBatch: 16,
              rpcInflight: 32,
              operationReceipts: 4096,
              canonicalIntentBytes: 8192,
              operationRecordBytes: 4096,
              runtimeBytes: 268435456,
              workerBytes: 67108864,
              executableBytes: 4096,
              cwdBytes: 4096,
              argvCount: 64,
              argvBytes: 8192,
              capabilityCount: 32,
            },
            workerCount: 0,
            runCount: 0,
            admission: "unavailable",
            health: "unverifiable",
          },
        },
      ],
      dispatchCount: 1,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A36.empty-whole-envelope",
    group: "A36",
    payload: [],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      dispatchCount: 0,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A36.structural-whole-envelope",
    group: "A36",
    payload: [
      {
        jsonrpc: "2.0",
        id: "A36-deep",
        method: "server.status",
        params: {
          extra: {
            next: {
              next: {
                next: {
                  next: {
                    next: {
                      next: {
                        next: {
                          next: {
                            next: {
                              next: {
                                next: {
                                  next: {
                                    next: {
                                      next: {
                                        next: { next: { next: { next: { next: { next: 0 } } } } },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      dispatchCount: 0,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A37.lower1-valid-singleton",
    group: "A37",
    payload: [{ jsonrpc: "2.0", id: "A37-one", method: "server.status", params: {} }],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 1,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: [
        {
          jsonrpc: "2.0",
          id: "A37-one",
          result: {
            serverId: "author-server",
            relayInstanceId: "author-instance",
            buildVersion: "0.0.0",
            protocolVersion: 2,
            profile: "pragmatic-logical-grid-v1",
            effectiveBudgets: {
              maxRuns: 128,
              maxCols: 120,
              maxRows: 40,
              historyLines: 1000,
              listPage: 128,
              baselineVtBytes: 8388608,
              baselineTailBytes: 65536,
              baselineChunks: 129,
              recoveryDeadlineMs: 15000,
              concurrentGenerationsPerWorker: 2,
              replayBytes: 1048576,
              replayEvents: 4096,
              postNBytes: 1048576,
              postNEvents: 4096,
              parseLowBytes: 131072,
              parseHighBytes: 524288,
              parseHardBytes: 1048576,
              inputQueueBytes: 65536,
              pendingWorkerCommands: 256,
              subscriptionCreditBytes: 262144,
              outboundConnectionBytes: 1048576,
              reservedControlBytes: 65536,
              subscriptionsPerConnection: 16,
              authenticatedSockets: 32,
              unauthenticatedSockets: 8,
              pipeQueuedBytes: 4194304,
              previewBytesPerRun: 65536,
              previewGlobalBytes: 8388608,
              previewRefreshes: 4,
              bootstrapBytes: 8192,
              rpcRequestBytes: 65536,
              rpcResponseBytes: 262144,
              rpcBatch: 1,
              rpcInflight: 32,
              operationReceipts: 4096,
              canonicalIntentBytes: 8192,
              operationRecordBytes: 4096,
              runtimeBytes: 268435456,
              workerBytes: 67108864,
              executableBytes: 4096,
              cwdBytes: 4096,
              argvCount: 64,
              argvBytes: 8192,
              capabilityCount: 32,
            },
            workerCount: 0,
            runCount: 0,
            admission: "unavailable",
            health: "unverifiable",
          },
        },
      ],
      dispatchCount: 1,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A37.lower1-refused-two",
    group: "A37",
    payload: [
      { jsonrpc: "2.0", id: "A37-a", method: "server.status", params: {} },
      { jsonrpc: "2.0", id: "A37-b", method: "server.status", params: {} },
    ],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 1,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      dispatchCount: 0,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A37.lower2-valid-two",
    group: "A37",
    payload: [
      { jsonrpc: "2.0", id: "A37-a", method: "server.status", params: {} },
      { jsonrpc: "2.0", id: "A37-b", method: "server.status", params: {} },
    ],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 2,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: [
        {
          jsonrpc: "2.0",
          id: "A37-a",
          result: {
            serverId: "author-server",
            relayInstanceId: "author-instance",
            buildVersion: "0.0.0",
            protocolVersion: 2,
            profile: "pragmatic-logical-grid-v1",
            effectiveBudgets: {
              maxRuns: 128,
              maxCols: 120,
              maxRows: 40,
              historyLines: 1000,
              listPage: 128,
              baselineVtBytes: 8388608,
              baselineTailBytes: 65536,
              baselineChunks: 129,
              recoveryDeadlineMs: 15000,
              concurrentGenerationsPerWorker: 2,
              replayBytes: 1048576,
              replayEvents: 4096,
              postNBytes: 1048576,
              postNEvents: 4096,
              parseLowBytes: 131072,
              parseHighBytes: 524288,
              parseHardBytes: 1048576,
              inputQueueBytes: 65536,
              pendingWorkerCommands: 256,
              subscriptionCreditBytes: 262144,
              outboundConnectionBytes: 1048576,
              reservedControlBytes: 65536,
              subscriptionsPerConnection: 16,
              authenticatedSockets: 32,
              unauthenticatedSockets: 8,
              pipeQueuedBytes: 4194304,
              previewBytesPerRun: 65536,
              previewGlobalBytes: 8388608,
              previewRefreshes: 4,
              bootstrapBytes: 8192,
              rpcRequestBytes: 65536,
              rpcResponseBytes: 262144,
              rpcBatch: 2,
              rpcInflight: 32,
              operationReceipts: 4096,
              canonicalIntentBytes: 8192,
              operationRecordBytes: 4096,
              runtimeBytes: 268435456,
              workerBytes: 67108864,
              executableBytes: 4096,
              cwdBytes: 4096,
              argvCount: 64,
              argvBytes: 8192,
              capabilityCount: 32,
            },
            workerCount: 0,
            runCount: 0,
            admission: "unavailable",
            health: "unverifiable",
          },
        },
        {
          jsonrpc: "2.0",
          id: "A37-b",
          result: {
            serverId: "author-server",
            relayInstanceId: "author-instance",
            buildVersion: "0.0.0",
            protocolVersion: 2,
            profile: "pragmatic-logical-grid-v1",
            effectiveBudgets: {
              maxRuns: 128,
              maxCols: 120,
              maxRows: 40,
              historyLines: 1000,
              listPage: 128,
              baselineVtBytes: 8388608,
              baselineTailBytes: 65536,
              baselineChunks: 129,
              recoveryDeadlineMs: 15000,
              concurrentGenerationsPerWorker: 2,
              replayBytes: 1048576,
              replayEvents: 4096,
              postNBytes: 1048576,
              postNEvents: 4096,
              parseLowBytes: 131072,
              parseHighBytes: 524288,
              parseHardBytes: 1048576,
              inputQueueBytes: 65536,
              pendingWorkerCommands: 256,
              subscriptionCreditBytes: 262144,
              outboundConnectionBytes: 1048576,
              reservedControlBytes: 65536,
              subscriptionsPerConnection: 16,
              authenticatedSockets: 32,
              unauthenticatedSockets: 8,
              pipeQueuedBytes: 4194304,
              previewBytesPerRun: 65536,
              previewGlobalBytes: 8388608,
              previewRefreshes: 4,
              bootstrapBytes: 8192,
              rpcRequestBytes: 65536,
              rpcResponseBytes: 262144,
              rpcBatch: 2,
              rpcInflight: 32,
              operationReceipts: 4096,
              canonicalIntentBytes: 8192,
              operationRecordBytes: 4096,
              runtimeBytes: 268435456,
              workerBytes: 67108864,
              executableBytes: 4096,
              cwdBytes: 4096,
              argvCount: 64,
              argvBytes: 8192,
              capabilityCount: 32,
            },
            workerCount: 0,
            runCount: 0,
            admission: "unavailable",
            health: "unverifiable",
          },
        },
      ],
      dispatchCount: 2,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A38.notification-only",
    group: "A38",
    payload: [{ jsonrpc: "2.0", method: "server.status", params: {} }],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: { status: 204, body: null, dispatchCount: 1 },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
  {
    id: "D-A38.mixed-retains-array",
    group: "A38",
    payload: [
      { jsonrpc: "2.0", method: "server.status", params: {} },
      { jsonrpc: "2.0", id: "A38-call", method: "server.status", params: {} },
      false,
    ],
    budgets: {
      maxRuns: 128,
      maxCols: 120,
      maxRows: 40,
      historyLines: 1000,
      listPage: 128,
      baselineVtBytes: 8388608,
      baselineTailBytes: 65536,
      baselineChunks: 129,
      recoveryDeadlineMs: 15000,
      concurrentGenerationsPerWorker: 2,
      replayBytes: 1048576,
      replayEvents: 4096,
      postNBytes: 1048576,
      postNEvents: 4096,
      parseLowBytes: 131072,
      parseHighBytes: 524288,
      parseHardBytes: 1048576,
      inputQueueBytes: 65536,
      pendingWorkerCommands: 256,
      subscriptionCreditBytes: 262144,
      outboundConnectionBytes: 1048576,
      reservedControlBytes: 65536,
      subscriptionsPerConnection: 16,
      authenticatedSockets: 32,
      unauthenticatedSockets: 8,
      pipeQueuedBytes: 4194304,
      previewBytesPerRun: 65536,
      previewGlobalBytes: 8388608,
      previewRefreshes: 4,
      bootstrapBytes: 8192,
      rpcRequestBytes: 65536,
      rpcResponseBytes: 262144,
      rpcBatch: 16,
      rpcInflight: 32,
      operationReceipts: 4096,
      canonicalIntentBytes: 8192,
      operationRecordBytes: 4096,
      runtimeBytes: 268435456,
      workerBytes: 67108864,
      executableBytes: 4096,
      cwdBytes: 4096,
      argvCount: 64,
      argvBytes: 8192,
      capabilityCount: 32,
    },
    expected: {
      status: 200,
      body: [
        {
          jsonrpc: "2.0",
          id: "A38-call",
          result: {
            serverId: "author-server",
            relayInstanceId: "author-instance",
            buildVersion: "0.0.0",
            protocolVersion: 2,
            profile: "pragmatic-logical-grid-v1",
            effectiveBudgets: {
              maxRuns: 128,
              maxCols: 120,
              maxRows: 40,
              historyLines: 1000,
              listPage: 128,
              baselineVtBytes: 8388608,
              baselineTailBytes: 65536,
              baselineChunks: 129,
              recoveryDeadlineMs: 15000,
              concurrentGenerationsPerWorker: 2,
              replayBytes: 1048576,
              replayEvents: 4096,
              postNBytes: 1048576,
              postNEvents: 4096,
              parseLowBytes: 131072,
              parseHighBytes: 524288,
              parseHardBytes: 1048576,
              inputQueueBytes: 65536,
              pendingWorkerCommands: 256,
              subscriptionCreditBytes: 262144,
              outboundConnectionBytes: 1048576,
              reservedControlBytes: 65536,
              subscriptionsPerConnection: 16,
              authenticatedSockets: 32,
              unauthenticatedSockets: 8,
              pipeQueuedBytes: 4194304,
              previewBytesPerRun: 65536,
              previewGlobalBytes: 8388608,
              previewRefreshes: 4,
              bootstrapBytes: 8192,
              rpcRequestBytes: 65536,
              rpcResponseBytes: 262144,
              rpcBatch: 16,
              rpcInflight: 32,
              operationReceipts: 4096,
              canonicalIntentBytes: 8192,
              operationRecordBytes: 4096,
              runtimeBytes: 268435456,
              workerBytes: 67108864,
              executableBytes: 4096,
              cwdBytes: 4096,
              argvCount: 64,
              argvBytes: 8192,
              capabilityCount: 32,
            },
            workerCount: 0,
            runCount: 0,
            admission: "unavailable",
            health: "unverifiable",
          },
        },
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      ],
      dispatchCount: 2,
    },
    credit: "NEW_AUTHOR_CONTROL_NOT_ORIGINAL166",
    nativeParserCredit: false,
  },
];

async function batchEnvelopeAuthorControl(control) {
  const local = createLocalApplication(options, { identity, budgets: control.budgets });
  const errors = [];
  const events = [];
  let dispatched = 0;
  let requestID;
  let actual;
  const pool = local.core.runtime.pool;
  const original = pool.snapshot;
  const descriptor = Object.getOwnPropertyDescriptor(pool, "snapshot");
  pool.snapshot = function (...args) {
    dispatched++;
    events.push({ event: "public-status-snapshot", ordinal: dispatched });
    return Reflect.apply(original, this, args);
  };
  local.app.addHook("onRequest", (request, _reply, done) => {
    requestID = request.id;
    events.push({
      event: "framework-request",
      requestID,
      rawHeaderPairs: request.raw.rawHeaders.map((value, index, all) =>
        index > 0 && all[index - 1].toLowerCase() === "authorization"
          ? "Bearer <redacted43>"
          : value,
      ),
    });
    done();
  });
  try {
    await local.app.ready();
    const input = utf8(control.payload);
    const response = await local.app.inject({
      method: "POST",
      url: "/rpc",
      headers: business,
      payload: input,
    });
    await recordAuthor(control.id, {
      control,
      requestID,
      events,
      dispatched,
      inputBytes: input.toString("base64"),
      inputSha256: createHash("sha256").update(input).digest("hex"),
      status: response.statusCode,
      headers: response.headers,
      responseBody: response.body,
      responseBytes: Buffer.from(response.body).toString("base64"),
      responseSha256: createHash("sha256").update(response.body).digest("hex"),
      admission: local.admission.snapshot(),
      ledger: local.core.runtime.composition.bytes.snapshot(),
      nativeParserCredit: false,
    });
    actual = {
      status: response.statusCode,
      body: response.statusCode === 204 ? response.body : response.json(),
      dispatchCount: dispatched,
      rpcCount: local.admission.snapshot().rpc,
      registryCount: local.core.runtime.registry.count,
    };
  } catch (error) {
    errors.push(error);
  } finally {
    if (descriptor) Object.defineProperty(pool, "snapshot", descriptor);
    else delete pool.snapshot;
    try {
      await local.app.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      local.disposeCore();
    } catch (error) {
      errors.push(error);
    }
    try {
      await recordAuthor(control.id + "-finally", {
        events,
        dispatched,
        admission: local.admission.snapshot(),
        ledger: local.core.runtime.composition.bytes.snapshot(),
        errors: errors.map((error) => ({
          name: error.name,
          message: error.message,
          stack: error.stack,
        })),
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (local.core.runtime.composition.bytes.snapshot().total !== 0)
    errors.push(new Error("Owned batch-control retained bytes remain after true cleanup"));
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Batch envelope control and cleanup failed");
  return actual;
}

describe("D passive production local entry", () => {
  it("D-A01 explicit numeric options refuse implicit modes and foreign bind authorities", () => {
    expect(validateLocalOptions(options).host).toBe("127.0.0.1");
    expect(validateLocalOptions({ ...options, host: "::1", port: 0 }).host).toBe("::1");
    for (const change of [
      { mode: "remote" },
      { host: "0.0.0.0" },
      { host: "localhost" },
      { port: 65536 },
      { rendezvousPath: "relative" },
      { allowedOrigins: ["null"] },
    ])
      expect(() => validateLocalOptions({ ...options, ...change })).toThrow(
        "Invalid explicit m0-local options",
      );
    expect(() => parseLocalOptions(["--port", "32123"])).toThrow(
      "Invalid explicit m0-local options",
    );
  });
  it("D-A02 the registered passive bootstrap authenticates and redacts the per-launch secret", async () => {
    await withApp(async ({ app, core }) => {
      expect(app.server.listening).toBe(false);
      const good = await app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: auth,
        payload: utf8(bootstrap),
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().type).toBe("cove-bootstrap-result");
      expect(good.body).not.toContain(identity.secret);
      for (const headers of [
        { ...auth, host: "localhost:32123" },
        { ...auth, origin: "null" },
        { ...auth, origin: "http://hostile" },
        { ...auth, authorization: "Bearer wrong" },
      ]) {
        const result = await app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload: utf8(bootstrap),
        });
        expect([401, 403]).toContain(result.statusCode);
        expect(result.body).not.toContain(identity.secret);
      }
      expect(core.runtime.pool.snapshot().workers).toBe(0);
    });
  });
  it("D-A03 actual fetch headers require browser Origin while CLI absence stays eligible", async () => {
    await withApp(async ({ app }) => {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/bootstrap",
            headers: { ...auth, "sec-fetch-mode": "cors" },
            payload: utf8(bootstrap),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/bootstrap",
            headers: { ...auth, "sec-fetch-mode": "cors", origin: options.allowedOrigins[0] },
            payload: utf8(bootstrap),
          })
        ).statusCode,
      ).toBe(200);
    });
  });
  it("D-A04 real registered OPTIONS and per-request metadata never bypass domain admission", async () => {
    await withApp(async ({ app, core }) => {
      const preflight = {
        host: auth.host,
        origin: options.allowedOrigins[0],
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type,Cove-Protocol",
      };
      expect(
        (await app.inject({ method: "OPTIONS", url: "/rpc", headers: preflight })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "OPTIONS",
            url: "/rpc",
            headers: { ...preflight, "access-control-request-headers": "X-Foreign" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: auth,
            payload: utf8(statusCall),
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: { ...business, "cove-instance-id": "foreign" },
            payload: utf8(statusCall),
          })
        ).statusCode,
      ).toBe(409);
      const result = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8(statusCall),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().result.health).toBe("unverifiable");
      expect(core.runtime.registry.count).toBe(0);
    });
  });
  it("D-A05 framework byte readers admit exact encoded caps and refuse cap plus one", async () => {
    await withApp(async ({ app, admission }) => {
      for (const [url, value, cap, headers] of [
        ["/bootstrap", bootstrap, 8192, auth],
        ["/rpc", statusCall, 65536, business],
      ]) {
        const data = utf8(value);
        const payload = Buffer.concat([data, Buffer.alloc(cap - data.length, 32)]);
        expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
        expect(
          (
            await app.inject({
              method: "POST",
              url,
              headers,
              payload: Buffer.concat([payload, Buffer.from(" ")]),
            })
          ).statusCode,
        ).toBe(413);
      }
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A06 classifier batch and notification behavior remain schema-bound without partial writes", async () => {
    await withApp(async ({ app, core, admission }) => {
      const batch = Array.from({ length: 16 }, (_, id) => ({ ...statusCall, id }));
      expect(
        (
          await app.inject({ method: "POST", url: "/rpc", headers: business, payload: utf8(batch) })
        ).json(),
      ).toHaveLength(16);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: business,
            payload: utf8([...batch, statusCall]),
          })
        ).json(),
      ).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: business,
            payload: utf8({ jsonrpc: "2.0", method: "terminal.create", params: {} }),
          })
        ).statusCode,
      ).toBe(204);
      expect(core.runtime.registry.count).toBe(0);
      const snapshot = core.runtime.pool.snapshot.bind(core.runtime.pool);
      let dispatched = 0;
      core.runtime.pool.snapshot = () => {
        dispatched++;
        return snapshot();
      };
      const notification = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8({ jsonrpc: "2.0", method: "server.status", params: {} }),
      });
      await recordAuthor("A06-notification", {
        status: notification.statusCode,
        body: notification.body,
        headers: notification.headers,
        dispatched,
        quota: admission.snapshot(),
      });
      expect(notification.statusCode).toBe(204);
      expect(notification.body).toBe("");
      expect(dispatched).toBe(1);
    });
  });
  it("D-A07 in-flight readers hold ownership until the correlated domain completion", async () => {
    await withApp(async ({ app, admission, core }) => {
      const held = [];
      core.operations.create = (_principal, params) =>
        new Promise((resolve) =>
          held.push(() =>
            resolve({
              operation: {
                operationId: params.operationId,
                method: "terminal.create",
                revision: 0,
                state: "accepted",
                run: {
                  serverId: identity.serverId,
                  relayInstanceId: identity.relayInstanceId,
                  runId: params.operationId,
                },
              },
            }),
          ),
        );
      const call = (id) => ({
        jsonrpc: "2.0",
        id,
        method: "terminal.create",
        params: {
          operationId: `operation-${id}`,
          expectedRelayInstanceId: identity.relayInstanceId,
          executable: "/bin/sh",
          argv: [],
          cwd: "/tmp",
          geometry: { cols: 80, rows: 24 },
        },
      });
      const pending = Array.from({ length: 32 }, (_, id) =>
        app.inject({ method: "POST", url: "/rpc", headers: business, payload: utf8(call(id)) }),
      );
      try {
        for (let turn = 0; turn < 100 && held.length !== 32; turn++)
          await new Promise(setImmediate);
        expect(held).toHaveLength(32);
        expect(admission.snapshot().rpc).toBe(32);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/rpc",
              headers: business,
              payload: utf8(call(33)),
            })
          ).statusCode,
        ).toBe(429);
        expect(held).toHaveLength(32);
      } finally {
        for (const finish of held) finish();
        await Promise.all(pending);
      }
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A08 unauthenticated upgrade slots reserve before carrier ownership and release once", async () => {
    await withApp(async ({ admission, terminal }) => {
      const claims = Array.from({ length: 8 }, () => terminal.prepare(auth));
      expect(claims.every((x) => x.kind === "accepted")).toBe(true);
      expect(terminal.prepare(auth).kind).toBe("busy");
      expect(terminal.prepare({ ...auth, host: "foreign" }).kind).toBe("forbidden");
      for (const x of claims) {
        x.claim.release();
        x.claim.release();
      }
      expect(admission.snapshot().unauthenticated).toBe(0);
    });
  });
  it("D-A09 pre-auth binary business is refused and close requests are not physical-close proof", async () => {
    await withWs(async ({ open, local }) => {
      const peer = open();
      peer.emit("message", Buffer.from([1, 2, 3]), true);
      expect(peer.codes).toEqual([1002]);
      expect(local.admission.snapshot().unauthenticated).toBe(1);
      expect(local.core.runtime.registry.count).toBe(0);
      peer.finish();
      expect(local.admission.snapshot().unauthenticated).toBe(0);
    });
  });
  it("D-A10 first-message monotonic equality and timeout ordering cannot resurrect authentication", async () => {
    await withWs(async ({ open, time, timer, local }) => {
      const eligible = open();
      time(5000);
      eligible.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(JSON.parse(eligible.sent[0]).type).toBe("cove-bootstrap-result");
      eligible.finish();
      const late = open();
      time(10001);
      late.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(late.codes).toEqual([1008]);
      late.finish();
      const expired = open();
      timer.fire();
      expired.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(expired.sent).toHaveLength(0);
      expired.finish();
      expect(local.admission.snapshot().authenticated).toBe(0);
    });
  });
  it("D-A11 authenticated maximum preserves healthy peers and refuses promotion plus one", async () => {
    for (const cap of [32, 2]) {
      await withWs(
        async ({ open, local }) => {
          const peers = Array.from({ length: cap }, () => {
            const peer = open();
            peer.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
            return peer;
          });
          expect(
            peers.every(
              (peer) =>
                peer.codes.length === 0 &&
                JSON.parse(peer.sent[0]).type === "cove-bootstrap-result",
            ),
          ).toBe(true);
          expect(local.admission.snapshot().authenticated).toBe(cap);
          const refused = open();
          refused.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
          expect(refused.codes).toEqual([1013]);
          refused.finish();
          expect(local.admission.snapshot().authenticated).toBe(cap);
          for (const peer of peers) peer.finish();
          expect(local.admission.snapshot().authenticated).toBe(0);
        },
        { ...M0_LIMITS, authenticatedSockets: cap },
      );
    }
  });
  it("D-A12 authenticated binary framing validates full connection identity before service dispatch", async () => {
    await withWs(async ({ open, local }) => {
      const peer = open();
      peer.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      const result = JSON.parse(peer.sent[0]);
      const attach = {
        type: "attach",
        requestId: "attach-one",
        run: {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          runId: "not-created",
        },
        connection: { ...result.connection, connectionId: "foreign" },
        viewId: "view",
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
      };
      peer.emit("message", encodeTerminalFrame(1, utf8(attach), new Uint8Array()).value, true);
      expect(peer.codes).toEqual([1002]);
      expect(local.core.runtime.registry.count).toBe(0);
      peer.finish();
    });
  });
  it("D-A13 monotonic watchdog stops its own timer on regression and preserves one failure", () => {
    const timer = timerFixture();
    let value = 100;
    let ticks = 0;
    let failures = 0;
    const clock = new LocalRuntimeClock(
      () => ticks++,
      () => failures++,
      timer,
      () => value,
    );
    clock.start();
    clock.start();
    timer.fire();
    expect(ticks).toBe(1);
    value = 99;
    timer.fire();
    expect(failures).toBe(1);
    expect(timer.jobs.size).toBe(0);
    clock.start();
    expect(timer.jobs.size).toBe(0);
  });
  it("D-A14 actual process adapter orders public-bin hello/ready and keeps contact-loss separate", async () => {
    await withApp(async ({ core }) => {
      const child = new EventEmitter();
      child.pid = 123;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const decoder = createPipeDecoder();
      let selectedBin;
      child.stdin.on("data", (bytes) => {
        for (const frame of decoder.read(bytes).frames) {
          const hello = JSON.parse(Buffer.from(frame.metadata).toString());
          expect(hello.type).toBe("hello");
          child.stdout.write(
            encodePipeFrame(2, utf8({ ...hello, type: "ready" }), new Uint8Array()).value,
          );
        }
      });
      child.stdin.on("finish", () => {
        child.stdin.destroy();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      const process = new WorkerProcess(
        core.runtime,
        {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          workerId: "worker",
          workerIncarnationId: "birth",
        },
        () => 0,
        (bin) => {
          selectedBin = bin;
          return child;
        },
      );
      process.start();
      await process.ready;
      expect(selectedBin).toMatch(/node_modules[/\\]\.bin[/\\]cove-terminal-worker$/);
      expect(process.snapshot().ready).toBe(true);
      child.stdout.emit("error", new Error("synthetic lower carrier"));
      expect(process.snapshot().contact).toBe("unverifiable");
      expect(process.snapshot().directlyOwnedLeaderExited).toBe(false);
      expect((await process.close()).status).toBe("exited");
      expect(process.snapshot().directlyOwnedLeaderExited).toBe(true);
    });
  });
  it("D-A15 rendezvous publishes complete restricted bytes and preserves a replaced foreign file", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "cove-entry-author-"));
    const path = join(dir, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await file.publish({
        bootstrapVersion: 1,
        ...launchIdentity(),
        endpoint: "http://127.0.0.1:32123",
      });
      expect(JSON.parse(await readFile(path, "utf8")).endpoint).toBe("http://127.0.0.1:32123");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(["rendezvous"]);
      await unlink(path);
      await writeFile(path, "owned-by-other-fixture");
      await file.close();
      await file.close();
      expect(await readFile(path, "utf8")).toBe("owned-by-other-fixture");
    } finally {
      await file.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("D-A16 failed publication never overwrites prior rendezvous or leaks owned temporary resources", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "cove-entry-failure-"));
    const path = join(dir, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await writeFile(path, "prior");
      await expect(
        file.publish({
          bootstrapVersion: 1,
          ...launchIdentity(),
          endpoint: "http://127.0.0.1:32123",
        }),
      ).rejects.toThrow("publication failed");
      expect(await readFile(path, "utf8")).toBe("prior");
      expect(await readdir(dir)).toEqual(["rendezvous"]);
      await file.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("D-A17 response validation distinguishes invalid results from encoded whole-response overflow", async () => {
    await withApp(async ({ core }) => {
      core.runtime.pool.snapshot = () => ({ workers: -1, runs: 0, readyWorkers: 0 });
      expect(JSON.parse((await rpcBody(core, utf8(statusCall))).body).error.code).toBe(-32603);
      const records = Array.from({ length: 123 }, (_, i) => ({
        run: { serverId: "x".repeat(128), relayInstanceId: "y".repeat(128), runId: `run-${i}` },
        status: "live",
        geometry: { cols: 80, rows: 24 },
        controlEpoch: 0,
        controlHolder: null,
        preview: { version: 0, generatedAtMs: 0, checkedAtMs: 0, stale: false, byteLength: 0 },
      }));
      core.runtime.previews.cache.list = () => ({ runs: records });
      const list = { jsonrpc: "2.0", id: "list", method: "terminal.list", params: { limit: 128 } };
      expect((await rpcBody(core, utf8(Array.from({ length: 16 }, () => list)))).status).toBe(413);
    });
  });
  it("D-A18 secure missing leaf directory is created 0700 and removed only after owned file cleanup", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cove-secure-parent-"));
    const parent = join(root, "owned");
    const path = join(parent, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await file.publish({
        bootstrapVersion: 1,
        ...launchIdentity(),
        endpoint: "http://127.0.0.1:32123",
      });
      const directory = await lstat(parent);
      const published = await lstat(path);
      await recordAuthor("A18-published", {
        directory: { uid: directory.uid, mode: directory.mode & 0o777 },
        file: { uid: published.uid, mode: published.mode & 0o777 },
        names: await readdir(parent),
      });
      expect(directory.mode & 0o777).toBe(0o700);
      expect(directory.uid).toBe(process.getuid());
      expect(published.mode & 0o777).toBe(0o600);
      await file.close();
      await file.close();
      const remaining = await readdir(root);
      await recordAuthor("A18-closed", { remaining });
      expect(remaining).toEqual([]);
    } finally {
      await file.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("D-A19 insecure and symlinked configured parents refuse publication and preserve foreign bytes", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cove-refused-parent-"));
    try {
      const insecure = join(root, "insecure");
      const target = join(root, "target");
      const alias = join(root, "alias");
      await mkdir(insecure, { mode: 0o700 });
      await chmod(insecure, 0o755);
      await mkdir(target, { mode: 0o700 });
      await symlink(target, alias);
      await writeFile(join(insecure, "prior"), "foreign-insecure");
      await writeFile(join(target, "prior"), "foreign-target");
      for (const [name, parent] of [
        ["insecure", insecure],
        ["symlink", alias],
      ]) {
        const file = new LocalRendezvous(join(parent, "rendezvous"));
        let error;
        try {
          await file.publish({
            bootstrapVersion: 1,
            ...launchIdentity(),
            endpoint: "http://127.0.0.1:32123",
          });
        } catch (caught) {
          error = caught;
        } finally {
          await file.close();
        }
        const info = await lstat(parent);
        const names = await readdir(parent);
        await recordAuthor(`A19-${name}`, {
          error: error?.message,
          mode: info.mode & 0o777,
          symlink: info.isSymbolicLink(),
          names,
          prior: await readFile(join(parent, "prior"), "utf8"),
        });
        expect(error?.message).toBe("Local rendezvous publication failed");
        expect(names).toEqual(["prior"]);
      }
      expect((await lstat(insecure)).mode & 0o777).toBe(0o755);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(target, "prior"), "utf8")).toBe("foreign-target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("D-A20 valid notifications dispatch through the real map and invalid or unknown notifications do not", async () => {
    await withApp(async ({ app, core, admission }) => {
      const snapshot = core.runtime.pool.snapshot.bind(core.runtime.pool);
      let dispatches = 0;
      core.runtime.pool.snapshot = () => {
        dispatches++;
        return snapshot();
      };
      const payload = [
        { jsonrpc: "2.0", method: "server.status", params: {} },
        { jsonrpc: "2.0", method: "server.status", params: [] },
        { jsonrpc: "2.0", method: "unknown", params: {} },
        statusCall,
      ];
      const response = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8(payload),
      });
      await recordAuthor("A20-mixed", {
        status: response.statusCode,
        body: response.body,
        headers: response.headers,
        dispatches,
        quota: admission.snapshot(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0].id).toBe("status");
      expect(dispatches).toBe(2);
      expect(admission.snapshot().rpc).toBe(0);
      core.runtime.pool.snapshot = () => {
        throw new Error("fixed snapshot failure");
      };
      const failedNotification = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8({ jsonrpc: "2.0", method: "server.status", params: {} }),
      });
      await recordAuthor("A20-failed-notification", {
        status: failedNotification.statusCode,
        body: failedNotification.body,
        headers: failedNotification.headers,
        quota: admission.snapshot(),
      });
      expect(failedNotification.statusCode).toBe(204);
      expect(failedNotification.body).toBe("");
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A21 admitted RPC success, parse failure, no-reply and size refusal retain exact current identity headers", async () => {
    await withApp(async ({ app, admission }) => {
      for (const [name, payload, status] of [
        ["success", utf8(statusCall), 200],
        ["parse", Buffer.from("{"), 200],
        ["notification", utf8({ jsonrpc: "2.0", method: "server.status", params: {} }), 204],
        ["too-large", Buffer.alloc(65537, 32), 413],
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/rpc",
          headers: business,
          payload,
        });
        await recordAuthor(`A21-${name}`, {
          status: response.statusCode,
          body: response.body,
          headers: response.headers,
          quota: admission.snapshot(),
        });
        expect(response.statusCode).toBe(status);
        expect(response.headers["cove-protocol"]).toBe("2");
        expect(response.headers["cove-server-id"]).toBe(identity.serverId);
        expect(response.headers["cove-instance-id"]).toBe(identity.relayInstanceId);
        expect(response.headers.authorization).toBeUndefined();
        expect(response.body).not.toContain(identity.secret);
        expect(admission.snapshot().rpc).toBe(0);
      }
    });
  });
  it("D-A22 malformed and ambiguous real raw headers precede authority, credential and metadata mismatch", async () => {
    await withApp(async ({ admission, app }) => {
      const raw = Object.entries(business).flatMap(([key, value]) => [key, value]);
      const cases = [
        ["missing-host", { ...business, host: undefined }],
        ["bad-host", { ...business, host: "bad host" }],
        ["bad-protocol", { ...business, "cove-protocol": "NaN" }],
        ["bad-server", { ...business, "cove-server-id": "bad id" }],
        ["missing-instance", { ...business, "cove-instance-id": undefined }],
        ...["host", "origin", "authorization"].map((key) => [
          `duplicate-${key}`,
          actualHeaders(business, [...raw, key, "foreign", key, "second"]),
        ]),
      ];
      for (const [name, headers] of cases) {
        const result = admission.http("POST", "/rpc", headers, 0);
        await recordAuthor(`A22-${name}`, {
          result,
          headers: { ...headers, authorization: "[REDACTED]" },
          quota: admission.snapshot(),
        });
        expect(result).toBe("malformed");
      }
      for (const key of ["host", "origin", "authorization"]) {
        const headers = actualHeaders(auth, [
          "Host",
          auth.host,
          key,
          "one",
          key.toUpperCase(),
          "two",
        ]);
        expect(admission.http("POST", "/bootstrap", headers, 0)).toBe("malformed");
        expect(admission.http("OPTIONS", "/rpc", headers, 0)).toBe("malformed");
        expect(admission.upgrade("/terminal", headers)).toBe("malformed");
      }
      expect(admission.http("POST", "/rpc", { ...business, host: "example.com:32123" }, 0)).toBe(
        "forbidden",
      );
      expect(
        admission.http("POST", "/rpc", { ...business, authorization: "Bearer wrong" }, 0),
      ).toBe("unauthenticated");
      expect(admission.http("POST", "/rpc", { ...business, "cove-server-id": "foreign" }, 0)).toBe(
        "mismatch",
      );
      const response = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: { ...business, "cove-protocol": "NaN" },
        payload: utf8(statusCall),
      });
      await recordAuthor("A22-real-route", {
        status: response.statusCode,
        body: response.body,
        headers: response.headers,
        quota: admission.snapshot(),
      });
      expect(response.statusCode).toBe(400);
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A23 wrong message kinds use protocol close while true oversized messages retain size close", async () => {
    await withWs(async ({ open, local }) => {
      const oversized = open();
      oversized.emit("message", Buffer.alloc(8193), false);
      const text = open();
      text.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      text.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      const binary = open();
      binary.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      binary.emit("message", Buffer.alloc(MAX_FRAME_BYTES + 1), true);
      await recordAuthor("A23-before-close", {
        oversized: oversized.codes,
        secondText: text.codes,
        binary: binary.codes,
        quota: local.admission.snapshot(),
      });
      expect(oversized.codes).toEqual([1009]);
      expect(text.codes).toEqual([1002]);
      expect(binary.codes).toEqual([1009]);
      oversized.finish();
      text.finish();
      binary.finish();
      await recordAuthor("A23-physical-close", { quota: local.admission.snapshot() });
      expect(local.admission.snapshot().authenticated).toBe(0);
      expect(local.admission.snapshot().unauthenticated).toBe(0);
    });
  });
  it("D-A24 registered HTTP bootstrap preserves four exact kind refusals and success/mismatch/malformed classes", async () => {
    const fixed = [
      {
        name: "DN08.http-bootstrap-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 2,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "0f13595b09415125e87a3433e4f5e1bc814185e8fe529cfeb5876d27fa1a2f9c",
        expected: {
          type: "cove-bootstrap-error",
          kind: "BOOTSTRAP_UNSUPPORTED",
          message: "BOOTSTRAP UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-missing-capability",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: ["terminal-framing-v2"],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "ddb277f478a994d03fbecddba0ce16788a65e7b5ebbbdf8d7ef214fa72cacef4",
        expected: {
          type: "cove-bootstrap-error",
          kind: "CAPABILITY_UNAVAILABLE",
          message: "CAPABILITY UNAVAILABLE",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-profile-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["unsupported-profile"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "276eaf1526a429f11cb380fb83aefc636486c43c1be838a49d2c8debb9e77a35",
        expected: {
          type: "cove-bootstrap-error",
          kind: "PROFILE_UNSUPPORTED",
          message: "PROFILE UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-encoding-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["unsupported-encoding"],
        },
        inputSha256: "e2e8a6fa284c0b8f6654e8e8a80335aee90398d3441de2e88386548cb887c87f",
        expected: {
          type: "cove-bootstrap-error",
          kind: "PROFILE_UNSUPPORTED",
          message: "PROFILE UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
    ];
    const valid = {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "dn-server",
      expectedRelayInstanceId: "dn-instance",
      protocolVersion: 2,
      buildVersion: "oracle-client-a",
      capabilities: [
        "terminal-framing-v2",
        "logical-grid-recovery-v1",
        "worker-pipe-v2",
        "terminal-preview-v1",
        "operation-receipts-v1",
      ],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    };
    const local = createLocalApplication(
      { ...options, port: 19041, allowedOrigins: ["http://127.0.0.1:19042"] },
      { identity: { ...identity, serverId: "dn-server", relayInstanceId: "dn-instance" } },
    );
    const headers = {
      host: "127.0.0.1:19041",
      origin: "http://127.0.0.1:19042",
      authorization: `Bearer ${identity.secret}`,
    };
    try {
      await local.app.ready();
      for (const row of fixed) {
        const bytes = utf8(row.input);
        const inputSha256 = createHash("sha256").update(bytes).digest("hex");
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload: bytes,
        });
        await recordAuthor(row.name, {
          input: row.input,
          inputSha256,
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
          quota: local.admission.snapshot(),
        });
        expect(inputSha256).toBe(row.inputSha256);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual(row.expected);
        expect(local.admission.snapshot().rpc).toBe(0);
        expect(local.core.runtime.registry.count).toBe(0);
      }
      for (const [name, payload, expectedStatus, kind, type, empty] of [
        ["success", utf8(valid), 200, undefined, "cove-bootstrap-result", false],
        [
          "protocol",
          utf8({ ...valid, protocolVersion: 3 }),
          409,
          "PROTOCOL_MISMATCH",
          "cove-bootstrap-error",
          false,
        ],
        [
          "instance",
          utf8({ ...valid, expectedRelayInstanceId: "other" }),
          409,
          "INSTANCE_MISMATCH",
          "cove-bootstrap-error",
          false,
        ],
        [
          "malformed",
          Buffer.from("{"),
          400,
          "BOOTSTRAP_UNSUPPORTED",
          "cove-bootstrap-error",
          false,
        ],
      ]) {
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload,
        });
        await recordAuthor(`A24-${name}`, {
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
          quota: local.admission.snapshot(),
        });
        expect(response.statusCode).toBe(expectedStatus);
        const parsedBody = response.body === "" ? undefined : response.json();
        expect(parsedBody?.kind).toBe(kind);
        expect(parsedBody?.type).toBe(type);
        expect(response.body === "").toBe(empty);
        expect(response.body).not.toContain(identity.secret);
      }
    } finally {
      await local.app.close();
      local.disposeCore();
    }
  });
  it("D-A25 actual factory forwards one timer to clock and first-message deadlines with genuine handle cleanup", async () => {
    const jobs = new Map();
    const events = [];
    let next = 0;
    let now = 0;
    const timer = {
      set: (callback, milliseconds) => {
        const handle = ++next;
        jobs.set(handle, { callback, milliseconds });
        events.push({ type: "set", handle, milliseconds });
        return handle;
      },
      clear: (handle) => {
        events.push({ type: "clear", handle, removed: jobs.delete(handle) });
      },
    };
    const local = createLocalApplication(options, { identity, timer, monotonic: () => now });
    const peers = [];
    const open = () => {
      const prepared = local.terminal.prepare(auth);
      const peer = new Socket();
      peers.push(peer);
      local.terminal.accept(peer, prepared.claim);
      return peer;
    };
    try {
      await local.app.ready();
      local.clock.start();
      const clockHandle = next;
      expect(jobs.get(clockHandle).milliseconds).toBe(25);
      local.clock.stop();
      local.clock.stop();
      const eligible = open();
      const bootstrapHandle = next;
      now = 5000;
      eligible.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      await recordAuthor("A25-equality", {
        events,
        sent: eligible.sent,
        codes: eligible.codes,
        quota: local.admission.snapshot(),
      });
      expect(JSON.parse(eligible.sent[0]).type).toBe("cove-bootstrap-result");
      expect(
        events.find((event) => event.type === "set" && event.handle === bootstrapHandle)
          .milliseconds,
      ).toBe(5000);
      expect(jobs.has(bootstrapHandle)).toBe(false);
      eligible.finish();
      eligible.finish();
      const late = open();
      now = 10001;
      late.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(late.codes).toEqual([1008]);
      late.finish();
      const expired = open();
      const deadline = next;
      jobs.get(deadline).callback();
      expired.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(expired.sent).toEqual([]);
      expect(expired.codes).toEqual([1008]);
      expired.finish();
      await recordAuthor("A25-retired", {
        events,
        remainingHandles: [...jobs.keys()],
        quota: local.admission.snapshot(),
      });
      expect(
        events.filter((event) => event.type === "clear" && event.handle === clockHandle),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === "clear" && event.handle === bootstrapHandle && event.removed,
        ),
      ).toHaveLength(1);
      expect(jobs.size).toBe(0);
      expect(local.admission.snapshot().authenticated).toBe(0);
    } finally {
      local.terminal.close();
      for (const peer of peers) peer.finish();
      await local.app.close();
      local.disposeCore();
    }
  });
  it("D-A26 actual factory forwards WorkerSpawn through the original worker handshake and lower retirement", async () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const decoder = createPipeDecoder();
    const writes = [];
    const events = [];
    let worker;
    const originalWrite = child.stdin.write;
    child.stdin.write = function (bytes, callback) {
      const returned = Reflect.apply(originalWrite, this, [
        bytes,
        function (error) {
          events.push({
            type: "callback-before",
            error:
              error === null
                ? "NULL"
                : error === undefined
                  ? "UNDEFINED"
                  : { name: error.name, message: error.message },
            snapshot: worker.snapshot(),
            session: worker.session.snapshot(),
          });
          try {
            return Reflect.apply(callback, this, [error]);
          } finally {
            events.push({
              type: "callback-after",
              snapshot: worker.snapshot(),
              session: worker.session.snapshot(),
            });
          }
        },
      ]);
      events.push({
        type: "write-return",
        returned,
        bytes: Buffer.from(bytes).toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return returned;
    };
    for (const streamName of ["stdin", "stdout", "stderr"]) {
      for (const event of ["error", "end", "finish", "close"]) {
        child[streamName].on(event, (error) =>
          events.push({
            streamName,
            type: event,
            error: error instanceof Error ? { name: error.name, message: error.message } : null,
          }),
        );
      }
    }
    for (const event of ["exit", "close"])
      child.on(event, (code, signal) => events.push({ type: `child-${event}`, code, signal }));
    let selectedBin;
    let spawns = 0;
    child.stdin.on("data", (bytes) => {
      for (const frame of decoder.read(bytes).frames) {
        const hello = JSON.parse(Buffer.from(frame.metadata).toString());
        writes.push({ hello, bytes: Buffer.from(bytes).toString("base64") });
        const readyBytes = encodePipeFrame(
          2,
          utf8({ ...hello, type: "ready" }),
          new Uint8Array(),
        ).value;
        events.push({
          type: "ready-frame",
          hello,
          bytes: Buffer.from(readyBytes).toString("base64"),
          sha256: createHash("sha256").update(readyBytes).digest("hex"),
        });
        child.stdout.write(readyBytes);
      }
    });
    child.stdin.on("finish", () => {
      child.stdin.destroy();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    const local = createLocalApplication(options, {
      identity,
      monotonic: () => 0,
      workerSpawn: (bin) => {
        selectedBin = bin;
        spawns++;
        return child;
      },
    });
    let primaryError;
    let errors;
    try {
      await local.app.ready();
      worker = local.createWorker();
      worker.start();
      await worker.ready;
      await recordAuthor("A26-ready", {
        selectedBin,
        spawns,
        writes,
        snapshot: worker.snapshot(),
        lowerPid123NotNativeBirth: true,
      });
      expect(worker).toBeInstanceOf(WorkerProcess);
      expect(selectedBin).toMatch(/node_modules[/\\]\.bin[/\\]cove-terminal-worker$/);
      expect(spawns).toBe(1);
      expect(writes[0].hello.type).toBe("hello");
      const sink = process.env.COVE_D_AUTHOR_OUTPUT;
      if (sink) {
        mkdirSync(sink, { recursive: true });
        writeFileSync(
          join(sink, "A26-live-guard.json"),
          JSON.stringify(
            {
              events,
              snapshot: worker.snapshot(),
              session: worker.session.snapshot(),
              lowerPid123NotNativeBirth: true,
            },
            null,
            2,
          ) + "\n",
        );
      }
      expect(worker.snapshot().ready).toBe(true);
      child.stdout.emit("error", new Error("fixed lower contact loss"));
      expect(worker.snapshot().contact).toBe("unverifiable");
      expect(worker.snapshot().directlyOwnedLeaderExited).toBe(false);
      const receipt = await worker.close();
      await recordAuthor("A26-closed", { receipt, snapshot: worker.snapshot(), spawns });
      expect(receipt.status).toBe("exited");
      expect(worker.snapshot().directlyOwnedLeaderExited).toBe(true);
    } catch (error) {
      primaryError = error;
    } finally {
      errors = primaryError === undefined ? [] : [primaryError];
      for (const [name, action] of [
        [
          "before-close-observation",
          () =>
            recordAuthor("A26-before-finally", {
              events,
              snapshot: worker?.snapshot(),
              session: worker?.session.snapshot(),
            }),
        ],
        ["worker.close", () => worker?.close()],
        ["stdin.destroy", () => child.stdin.destroy()],
        ["stdout.destroy", () => child.stdout.destroy()],
        ["stderr.destroy", () => child.stderr.destroy()],
        ["app.close", () => local.app.close()],
        ["disposeCore", () => local.disposeCore()],
      ]) {
        try {
          await action();
          events.push({ type: "finally-attempt", name, outcome: "returned" });
        } catch (error) {
          errors.push(error);
          events.push({
            type: "finally-attempt",
            name,
            outcome: "threw",
            error: { name: error.name, message: error.message },
          });
        }
      }
      try {
        await recordAuthor("A26-finally-after", {
          events,
          snapshot: worker?.snapshot(),
          session: worker?.session.snapshot(),
          destroyed: {
            stdin: child.stdin.destroyed,
            stdout: child.stdout.destroyed,
            stderr: child.stderr.destroyed,
          },
          errors: errors.map((error) => ({ name: error.name, message: error.message })),
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Worker fixture body and cleanup failures", {
        cause: errors[0],
      });
  });
  it("D-A28 real Node Writable null success retains live readiness and retires physical backing", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "success");
      try {
        rig.worker.start();
        await rig.worker.ready;
        const error = await rig.callbackDelivered;
        await recordAuthor("A28-null-success", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(error).toBe(null);
        expect(rig.worker.snapshot().ready).toBe(true);
        expect(rig.worker.snapshot().contact).toBe("live");
        expect(rig.worker.session.snapshot().physicalBytes).toBe(0);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A29 real Node Writable Error preserves identity and refuses ready resurrection", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "error");
      try {
        rig.worker.start();
        const error = await rig.callbackDelivered;
        await recordAuthor("A29-real-error", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(error).toBe(rig.failure);
        await expect(rig.worker.ready).rejects.toThrow("Worker startup unavailable");
        expect(rig.worker.snapshot().ready).toBe(false);
        expect(rig.worker.snapshot().contact).toBe("unverifiable");
        expect(rig.worker.session.snapshot().physicalBytes).toBe(0);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A30 actual stream close precedes late Writable completion without duplicate retirement", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "late");
      try {
        rig.worker.start();
        const held = rig.worker.session.snapshot();
        await recordAuthor("A30-held", {
          events: rig.events,
          held,
          snapshot: rig.worker.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(held.physicalBytes).toBeGreaterThan(0);
        const closed = new Promise((resolve) => rig.child.stdin.once("close", resolve));
        rig.child.stdin.destroy();
        await closed;
        const released = rig.worker.session.snapshot();
        await recordAuthor("A30-closed-before-late", {
          events: rig.events,
          released,
          snapshot: rig.worker.snapshot(),
        });
        expect(released.physicalBytes).toBe(0);
        rig.finishLowerWrite();
        await rig.callbackDelivered;
        await recordAuthor("A30-late-after-close", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
        });
        expect(rig.worker.session.snapshot()).toEqual(released);
        expect(rig.worker.snapshot().ready).toBe(false);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
        expect((await rig.worker.close()).status).toBe("exited");
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A27 extracted aggregate response guard keeps exact UTF8 boundaries without closed-method bypass", async () => {
    const envelope = { jsonrpc: "2.0", id: "component", result: "" };
    const overhead = Buffer.byteLength(JSON.stringify(envelope));
    for (const [bytes, expectedStatus, accepted] of [
      [262144, 200, true],
      [262145, 413, false],
    ]) {
      const remaining = bytes - overhead;
      const result = "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
      const value = { ...envelope, result };
      const body = JSON.stringify(value);
      const composer = composeRpcResponse(value, (text) => Buffer.from(text));
      const guard = boundRpcResponseBody(body, 262144);
      await recordAuthor(`A27-${bytes}`, {
        body,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
        composer,
        guard,
        credit: "COMPONENT_ONLY",
      });
      expect(Buffer.byteLength(body)).toBe(bytes);
      expect(guard.status).toBe(expectedStatus);
      expect(composer).toEqual(accepted ? value : null);
      expect(guard.body).toBe(accepted ? body : undefined);
      const changed = body.replace("é", "è");
      const changedGuard = boundRpcResponseBody(changed, 262144);
      await recordAuthor(`A27-changed-${bytes}`, {
        body: changed,
        bytes: Buffer.byteLength(changed),
        guard: changedGuard,
      });
      expect(Buffer.byteLength(changed)).toBe(bytes);
      expect(changedGuard.status).toBe(guard.status);
      expect(changed).not.toBe(body);
    }
    expect(
      composeRpcResponse(
        { ...envelope, error: { code: -32603, message: "Internal error" } },
        (text) => Buffer.from(text),
      ),
    ).toBeNull();
  });
  it("D-A31 real admission count retirement preserves shared backing and rejects ledger exhaustion", async () => {
    await withApp(async ({ admission, core }) => {
      const bytes = core.runtime.composition.bytes;
      const before = bytes.snapshot();
      const claims = [];
      let denial;
      try {
        for (let i = 0; i < 32; i++) claims.push(admission.claim("rpc"));
        await recordAuthor("A31-full", {
          quota: admission.snapshot(),
          bytes: bytes.snapshot(),
          before,
          credit: "ADMISSION_COMPONENT_ONLY",
        });
        expect(claims.every((claim) => claim !== null)).toBe(true);
        expect(admission.snapshot().rpc).toBe(32);
        expect(bytes.snapshot().total).toBe(before.total + 32 * 69632);
        expect(admission.claim("rpc")).toBe(null);
        claims[0].retireAdmission();
        claims[0].retireAdmission();
        await recordAuthor("A31-count-only", {
          quota: admission.snapshot(),
          bytes: bytes.snapshot(),
        });
        expect(admission.snapshot().rpc).toBe(31);
        expect(bytes.snapshot().total).toBe(before.total + 32 * 69632);
        const replacement = admission.claim("rpc");
        expect(replacement).not.toBe(null);
        claims.push(replacement);
        for (const claim of claims) claim.retireAdmission();
        expect(admission.snapshot().rpc).toBe(0);
        expect(bytes.snapshot().total).toBe(before.total + 33 * 69632);
        const remaining = bytes.limit - bytes.controlReserve - bytes.snapshot().ordinary;
        denial = bytes.reserve(remaining);
        await recordAuthor("A31-real-ledger-denial", {
          quota: admission.snapshot(),
          bytes: bytes.snapshot(),
          remaining,
        });
        expect(denial).not.toBe(null);
        expect(admission.claim("rpc")).toBe(null);
      } finally {
        denial?.release();
        for (const claim of claims) {
          claim?.release();
          claim?.release();
        }
      }
      await recordAuthor("A31-released", { quota: admission.snapshot(), bytes: bytes.snapshot() });
      expect(bytes.snapshot()).toEqual(before);
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A32 default factory admits 32 pending readers and refuses the 33rd without domain dispatch", async () => {
    await withApp(async ({ app, admission, core }) => {
      const before = core.runtime.composition.bytes.snapshot();
      const streams = Array.from({ length: 32 }, () => new PassThrough());
      const pending = streams.map((payload) =>
        app.inject({
          method: "POST",
          url: "/rpc",
          headers: { ...business, "content-type": "application/json" },
          payload,
        }),
      );
      let responses;
      try {
        for (let turn = 0; turn < 100 && admission.snapshot().rpc !== 32; turn++)
          await new Promise(setImmediate);
        await recordAuthor("A32-pending-readers", {
          quota: admission.snapshot(),
          bytes: core.runtime.composition.bytes.snapshot(),
          before,
          pendingReader: 32,
          pendingDomain: "NOT_EXERCISED",
          requestIds: streams.map((_stream, id) => `reader-${id}`),
        });
        expect(admission.snapshot().rpc).toBe(32);
        expect(core.runtime.composition.bytes.snapshot().total).toBe(before.total + 32 * 1118976);
        const refused = await app.inject({
          method: "POST",
          url: "/rpc",
          headers: business,
          payload: utf8({ ...statusCall, id: "reader-33" }),
        });
        await recordAuthor("A32-refused", {
          status: refused.statusCode,
          body: refused.body,
          headers: refused.headers,
          quota: admission.snapshot(),
          bytes: core.runtime.composition.bytes.snapshot(),
        });
        expect(refused.statusCode).toBe(429);
        expect(admission.snapshot().rpc).toBe(32);
      } finally {
        streams.forEach((stream, id) => stream.end(utf8({ ...statusCall, id: `reader-${id}` })));
        responses = await Promise.all(pending);
        for (const stream of streams) stream.destroy();
      }
      await recordAuthor("A32-actual-finish", {
        responses: responses.map((response) => ({
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        })),
        quota: admission.snapshot(),
        bytes: core.runtime.composition.bytes.snapshot(),
        carrier: "passive inject framework finish; not real OS socket",
      });
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(responses.map((response) => response.json().id)).toEqual(
        streams.map((_stream, id) => `reader-${id}`),
      );
      expect(admission.snapshot().rpc).toBe(0);
      expect(core.runtime.composition.bytes.snapshot()).toEqual(before);
    });
  });
  it("D-A33 legal bootstrap input greater than RPC input keeps independent generated response capacity", async () => {
    await withApp(
      async ({ app, admission, core }) => {
        const before = core.runtime.composition.bytes.snapshot();
        const payload = utf8(bootstrap);
        const response = await app.inject({
          method: "POST",
          url: "/bootstrap",
          headers: auth,
          payload,
        });
        await recordAuthor("A33-bootstrap", {
          input: payload.toString("base64"),
          inputBytes: payload.byteLength,
          headers: response.headers,
          status: response.statusCode,
          body: response.body,
          bodyBytes: Buffer.byteLength(response.body),
          quota: admission.snapshot(),
          bytes: core.runtime.composition.bytes.snapshot(),
          advertised: core.runtime.composition.budgets,
        });
        expect(payload.byteLength).toBeGreaterThan(128);
        expect(response.statusCode).toBe(200);
        expect(response.json().type).toBe("cove-bootstrap-result");
        expect(Buffer.byteLength(response.body)).toBeGreaterThan(128);
        expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(2371);
        expect(response.json().effectiveBudgets.rpcResponseBytes).toBe(128);
        const rpc = await app.inject({
          method: "POST",
          url: "/rpc",
          headers: business,
          payload: utf8({ ...statusCall, id: "small-response" }),
        });
        await recordAuthor("A33-rpc-small-response", {
          headers: rpc.headers,
          status: rpc.statusCode,
          body: rpc.body,
          quota: admission.snapshot(),
          bytes: core.runtime.composition.bytes.snapshot(),
        });
        expect(rpc.statusCode).toBe(413);
        expect(core.runtime.composition.bytes.snapshot()).toEqual(before);
      },
      { ...M0_LIMITS, rpcRequestBytes: 128, rpcResponseBytes: 128 },
    );
  });
  it("D-A34 original 16 admitted FIFO effects continue after early aggregate overflow", async () => {
    await withApp(
      async ({ app, core, admission }) => {
        const actualSnapshot = core.runtime.pool.snapshot;
        const effects = [];
        core.runtime.pool.snapshot = function (...args) {
          const result = Reflect.apply(actualSnapshot, this, args);
          effects.push({ ordinal: effects.length, result });
          return result;
        };
        const batch = Array.from({ length: 16 }, (_unused, index) =>
          index < 2
            ? { ...statusCall, id: `overflow-${index}` }
            : { jsonrpc: "2.0", method: "server.status", params: {} },
        );
        const before = core.runtime.composition.bytes.snapshot();
        try {
          const response = await app.inject({
            method: "POST",
            url: "/rpc",
            headers: business,
            payload: utf8(batch),
          });
          await recordAuthor("A34-fifo-overflow", {
            batch,
            response: {
              status: response.statusCode,
              headers: response.headers,
              body: response.body,
            },
            effects,
            quota: admission.snapshot(),
            bytes: core.runtime.composition.bytes.snapshot(),
            before,
          });
          expect(response.statusCode).toBe(413);
          expect(response.body).toBe("");
          expect(effects).toHaveLength(16);
          expect(effects.map((effect) => effect.ordinal)).toEqual(
            Array.from({ length: 16 }, (_unused, index) => index),
          );
          expect(admission.snapshot().rpc).toBe(0);
          expect(core.runtime.composition.bytes.snapshot()).toEqual(before);
        } finally {
          core.runtime.pool.snapshot = actualSnapshot;
        }
      },
      { ...M0_LIMITS, rpcResponseBytes: 1024 },
    );
  });
  it("D-A35 borrowed small view is copied into exact owned input before backing mutation", async () => {
    const local = createLocalApplication(options, { identity });
    const source = new PassThrough();
    const large = Buffer.alloc(1048576);
    const input = utf8({ ...statusCall, id: "borrowed-view" });
    large.set(input);
    const view = large.subarray(0, input.byteLength);
    const observed = [];
    let resolveReader;
    let resolveConsumed;
    const readerReady = new Promise((resolve) => {
      resolveReader = resolve;
    });
    const consumed = new Promise((resolve) => {
      resolveConsumed = resolve;
    });
    let copied;
    let responsePromise;
    local.app.addHook("preParsing", (request, _reply, payload, done) => {
      request.raw.on("data", (chunk) => {
        observed.push({
          byteLength: chunk.byteLength,
          backingBytes: chunk.buffer.byteLength,
          sha256: createHash("sha256").update(chunk).digest("hex"),
        });
        resolveConsumed();
      });
      resolveReader();
      done(null, payload);
    });
    local.app.addHook("preValidation", (request, _reply, done) => {
      copied = {
        byteLength: request.body.byteLength,
        backingBytes: request.body.buffer.byteLength,
        sameIncomingBacking: request.body.buffer === large.buffer,
        bytes: Buffer.from(request.body).toString("base64"),
        sha256: createHash("sha256").update(request.body).digest("hex"),
      };
      done();
    });
    try {
      await local.app.ready();
      responsePromise = local.app.inject({
        method: "POST",
        url: "/rpc",
        headers: { ...business, "content-type": "application/json" },
        payload: source,
      });
      await readerReady;
      source.write(view);
      await consumed;
      large.fill(0);
      source.end();
      const response = await responsePromise;
      await recordAuthor("A35-borrowed-copy", {
        observed,
        copied,
        originalBytes: input.toString("base64"),
        originalSha256: createHash("sha256").update(input).digest("hex"),
        observerOwnedIncomingBackingBytes: large.buffer.byteLength,
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
        quota: local.admission.snapshot(),
        bytes: local.core.runtime.composition.bytes.snapshot(),
      });
      expect(observed).toHaveLength(1);
      expect(copied.backingBytes).toBe(65536);
      expect(copied.sameIncomingBacking).toBe(false);
      expect(copied.bytes).toBe(input.toString("base64"));
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe("borrowed-view");
    } finally {
      source.end();
      source.destroy();
      try {
        if (responsePromise) await responsePromise;
      } finally {
        try {
          await local.app.close();
        } finally {
          local.disposeCore();
        }
      }
    }
  });
  it("D-A36 whole-envelope refusal stays distinct from valid singleton member arrays", async () => {
    const controls = batchEnvelopeAuthorControls.filter((row) => row.group === "A36");
    expect(controls.map((control) => control.id)).toEqual([
      "D-A36.invalid-member-array",
      "D-A36.valid-singleton-array",
      "D-A36.empty-whole-envelope",
      "D-A36.structural-whole-envelope",
    ]);
    for (const control of controls) {
      const actual = await batchEnvelopeAuthorControl(control);
      expect(actual).toEqual({
        status: control.expected.status,
        body: control.expected.status === 204 ? "" : control.expected.body,
        dispatchCount: control.expected.dispatchCount,
        rpcCount: 0,
        registryCount: 0,
      });
    }
  });
  it("D-A37 public lower effective batch cap preserves valid arrays and rejects whole over-cap envelopes", async () => {
    const controls = batchEnvelopeAuthorControls.filter((row) => row.group === "A37");
    expect(controls.map((control) => control.id)).toEqual([
      "D-A37.lower1-valid-singleton",
      "D-A37.lower1-refused-two",
      "D-A37.lower2-valid-two",
    ]);
    for (const control of controls) {
      const actual = await batchEnvelopeAuthorControl(control);
      expect(actual).toEqual({
        status: control.expected.status,
        body: control.expected.status === 204 ? "" : control.expected.body,
        dispatchCount: control.expected.dispatchCount,
        rpcCount: 0,
        registryCount: 0,
      });
    }
  });
  it("D-A38 notification and mixed envelopes preserve dispatch counts and array omission semantics", async () => {
    const controls = batchEnvelopeAuthorControls.filter((row) => row.group === "A38");
    expect(controls.map((control) => control.id)).toEqual([
      "D-A38.notification-only",
      "D-A38.mixed-retains-array",
    ]);
    for (const control of controls) {
      const actual = await batchEnvelopeAuthorControl(control);
      expect(actual).toEqual({
        status: control.expected.status,
        body: control.expected.status === 204 ? "" : control.expected.body,
        dispatchCount: control.expected.dispatchCount,
        rpcCount: 0,
        registryCount: 0,
      });
    }
  });
  it("D-A39 genuine public version1 still authenticates with a full connection reference", async () => {
    const control = wsClassificationControls.find((row) => row.group === "A39");
    const actual = await wsClassificationControl(control);
    expect(ConnectionRefSchema.safeParse(actual.response.connection).success).toBe(true);
    expect(actual).toEqual({
      ...control.expected,
      response: {
        ...control.expected.response,
        effectiveBudgets: { ...M0_LIMITS },
        connection: actual.response.connection,
      },
    });
  });
  it("D-A40 authenticated tag-only and semantic bootstrap refusals retain full canonical readable errors", async () => {
    const controls = wsClassificationControls.filter((row) => row.group === "A40");
    expect(controls.map((row) => row.id)).toEqual([
      "D-A40.unsupported-version2",
      "D-A40.unsupported-version2-held",
      "D-A40.protocol-mismatch",
      "D-A40.capability-unavailable",
      "D-A40.profile-unsupported",
      "D-A40.encoding-unsupported",
    ]);
    for (const control of controls) {
      const actual = await wsClassificationControl(control);
      expect(actual).toEqual(control.expected);
    }
  });
  it("D-A41 unsupported tags cannot bypass original secret structure byte time or binary admission", async () => {
    const controls = wsClassificationControls.filter((row) => row.group === "A41");
    expect(controls.map((row) => row.id)).toEqual([
      "D-A41.wrong-secret",
      "D-A41.absent-secret",
      "D-A41.invalid-secret-grammar",
      "D-A41.wrong-type",
      "D-A41.missing-build",
      "D-A41.invalid-protocol",
      "D-A41.long-build",
      "D-A41.long-capability",
      "D-A41.invalid-profile-type",
      "D-A41.tag-string",
      "D-A41.tag-zero",
      "D-A41.tag-fraction",
      "D-A41.oversize",
      "D-A41.late-time",
      "D-A41.binary",
    ]);
    for (const control of controls) {
      const actual = await wsClassificationControl(control);
      expect(actual).toEqual(control.expected);
    }
  });
  it("D-A42 allowed browser responses expose exactly the three instance-binding headers", async () => {
    await withApp(async (local) => {
      const response = await local.app.inject({
        method: "POST",
        url: "/rpc",
        headers: { ...business, origin: options.allowedOrigins[0] },
        payload: utf8(statusCall),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(options.allowedOrigins[0]);
      expect(response.headers["access-control-expose-headers"]).toBe(
        "Cove-Protocol, Cove-Server-Id, Cove-Instance-Id",
      );
      expect(response.headers["cove-protocol"]).toBe("2");
      expect(response.headers["cove-server-id"]).toBe(identity.serverId);
      expect(response.headers["cove-instance-id"]).toBe(identity.relayInstanceId);
    });
  });
  it("D-A43 browser origin approval precedes authentication quota identity and parser refusals", async () => {
    await withApp(async (local) => {
      const origin = options.allowedOrigins[0];
      for (const [headers, payload, status] of [
        [{ ...business, authorization: "Bearer wrong", origin }, utf8(statusCall), 401],
        [{ ...business, "cove-instance-id": "stale-instance", origin }, utf8(statusCall), 409],
        [{ ...business, origin }, Buffer.alloc(65537), 413],
      ]) {
        const response = await local.app.inject({ method: "POST", url: "/rpc", headers, payload });
        expect(response.statusCode).toBe(status);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
      }
      const claims = Array.from({ length: 32 }, () => local.admission.claim("rpc"));
      try {
        expect(claims.every(Boolean)).toBe(true);
        const response = await local.app.inject({
          method: "POST",
          url: "/rpc",
          headers: { ...business, origin },
          payload: utf8(statusCall),
        });
        expect(response.statusCode).toBe(429);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
      } finally {
        for (const claim of claims) claim?.release();
      }
      for (const invalidOrigin of ["null", "http://127.0.0.1:32125", [origin, origin]]) {
        const response = await local.app.inject({
          method: "POST",
          url: "/rpc",
          headers: { ...business, origin: invalidOrigin },
          payload: utf8(statusCall),
        });
        expect(response.statusCode).toBe(invalidOrigin instanceof Array ? 400 : 403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["access-control-expose-headers"]).toBeUndefined();
      }
    });
  });
  it("D-A44 unexpected infrastructure exceptions stay bounded 500 with approved origin visibility", async () => {
    const local = createLocalApplication(options, { identity });
    local.app.addHook("preHandler", () => {
      throw new Error(`private fixture failure ${identity.secret}`);
    });
    try {
      const response = await local.app.inject({
        method: "POST",
        url: "/rpc",
        headers: { ...business, origin: options.allowedOrigins[0] },
        payload: utf8(statusCall),
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).toBe("");
      expect(response.headers["access-control-allow-origin"]).toBe(options.allowedOrigins[0]);
      expect(response.body).not.toContain(identity.secret);
      expect(local.admission.snapshot().rpc).toBe(0);
    } finally {
      await local.app.close();
      local.disposeCore();
    }
  });
  it("D-A45 worker close observes direct graceful exit without signaling and clears its deadline", async () => {
    await withApp(async (local) => {
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 123,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          throw new Error("Graceful child must not be signaled");
        },
        unref: () => child,
      });
      const timer = timerFixture();
      const worker = new WorkerProcess(
        local.core.runtime,
        {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          workerId: "graceful-close",
          workerIncarnationId: "owned-birth",
        },
        () => 0,
        () => child,
        timer,
      );
      try {
        worker.start();
        const closing = worker.close();
        expect(worker.close()).toBe(closing);
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        expect(await closing).toEqual({ status: "exited", code: 0, signal: null });
        expect(timer.jobs.size).toBe(0);
        expect(worker.snapshot().directlyOwnedLeaderExited).toBe(true);
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
  });
  it("D-A46 finite worker close preserves uncertainty after signals and late physical exit stays separate", async () => {
    await withApp(async (local) => {
      const child = new EventEmitter();
      const signals = [];
      let unreferenced = false;
      Object.assign(child, {
        pid: 124,
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (signal) => {
          signals.push(signal);
          return true;
        },
        unref: () => {
          unreferenced = true;
          return child;
        },
      });
      const timer = timerFixture();
      const worker = new WorkerProcess(
        local.core.runtime,
        {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          workerId: "unverifiable-close",
          workerIncarnationId: "owned-birth",
        },
        () => 0,
        () => child,
        timer,
      );
      try {
        worker.start();
        const closing = worker.close();
        let physicalClosed = false;
        void worker.closed.then(() => {
          physicalClosed = true;
        });
        timer.fire();
        expect(signals).toEqual(["SIGTERM"]);
        expect(worker.snapshot().directlyOwnedLeaderExited).toBe(false);
        timer.fire();
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(physicalClosed).toBe(false);
        timer.fire();
        expect(await closing).toEqual({ status: "unverifiable" });
        expect(unreferenced).toBe(true);
        expect(timer.jobs.size).toBe(0);
        expect(physicalClosed).toBe(false);
        expect(worker.snapshot().directlyOwnedLeaderExited).toBe(false);
        child.emit("exit", null, "SIGKILL");
        child.emit("close", null, "SIGKILL");
        expect(await worker.closed).toEqual({ status: "exited", code: null, signal: "SIGKILL" });
        expect(await worker.close()).toEqual({ status: "unverifiable" });
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
  });
  it("D-A47 HTTP admission envelopes retain existing auth ordering and distinguish actual mismatches", async () => {
    await withApp(async (local) => {
      const rows = [
        [{ ...auth, authorization: "Bearer wrong" }, utf8(bootstrap), 401, "UNAUTHENTICATED"],
        [{ ...auth, host: "localhost:32123" }, utf8(bootstrap), 403, "FORBIDDEN"],
        [
          { ...auth, "cove-protocol": "invalid", authorization: "Bearer wrong" },
          utf8(bootstrap),
          400,
          "BOOTSTRAP_UNSUPPORTED",
        ],
        [
          { ...auth, "cove-protocol": "1", authorization: "Bearer wrong" },
          utf8(bootstrap),
          401,
          "UNAUTHENTICATED",
        ],
        [
          { ...auth, "cove-protocol": "1", "cove-instance-id": "other-instance" },
          utf8(bootstrap),
          409,
          "PROTOCOL_MISMATCH",
        ],
        [
          { ...auth, "cove-instance-id": "other-instance" },
          utf8(bootstrap),
          409,
          "INSTANCE_MISMATCH",
        ],
        [auth, Buffer.from("{"), 400, "BOOTSTRAP_UNSUPPORTED"],
        [auth, Buffer.alloc(8193), 413, "INVALID_SIZE"],
      ];
      for (const [headers, payload, status, kind] of rows) {
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload,
        });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({
          type: "cove-bootstrap-error",
          kind,
          message: kind.replaceAll("_", " "),
          supportedVersions: { bootstrap: [1], protocol: [2] },
        });
        expect(BootstrapFailureSchema.safeParse(response.json()).success).toBe(true);
        expect(response.body).not.toMatch(
          /author-server|author-instance|other-instance|localhost|Bearer/,
        );
        expect(response.body).not.toContain(identity.secret);
        expect(local.core.runtime.registry.count).toBe(0);
        expect(local.admission.snapshot().rpc).toBe(0);
      }
      const admitted = await local.app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: Buffer.from("{"),
      });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json().error.code).toBe(-32700);
    });
  });
  it("D-A48 rejected preflight quota and pre-upgrade use stable envelopes without admitting business", async () => {
    await withApp(async (local) => {
      const denied = await local.app.inject({
        method: "OPTIONS",
        url: "/bootstrap",
        headers: {
          host: auth.host,
          origin: options.allowedOrigins[0],
          "access-control-request-method": "DELETE",
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().kind).toBe("FORBIDDEN");
      const httpClaims = Array.from({ length: 32 }, () => local.admission.claim("rpc"));
      try {
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers: auth,
          payload: utf8(bootstrap),
        });
        expect(response.statusCode).toBe(429);
        expect(response.json().kind).toBe("BUSY");
        expect(BootstrapFailureSchema.safeParse(response.json()).success).toBe(true);
      } finally {
        for (const claim of httpClaims) claim?.release();
      }
      const wsClaims = Array.from({ length: 8 }, () => local.admission.claim("unauthenticated"));
      try {
        const response = await local.app.inject({ method: "GET", url: "/terminal", headers: auth });
        expect(response.statusCode).toBe(429);
        expect(response.json().kind).toBe("BUSY");
        expect(BootstrapFailureSchema.safeParse(response.json()).success).toBe(true);
      } finally {
        for (const claim of wsClaims) claim?.release();
      }
      expect(local.core.runtime.registry.count).toBe(0);
      expect(local.admission.snapshot()).toEqual({
        unauthenticated: 0,
        authenticated: 0,
        rpc: 0,
        protocol: 2,
      });
    });
  });
});
