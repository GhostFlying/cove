import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, test } from "vitest";
import { createClient } from "@cove/client";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  MAX_METADATA_BYTES,
} from "@cove/protocol/terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const identity = { serverId: "server-1", relayInstanceId: "instance-1" };
const run = { ...identity, runId: "run-1" };
const geometry = { cols: 80, rows: 24 };

function bootstrap(terminal, budgets = {}, capabilities = M0_CAPABILITIES) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...identity,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "server-build",
    capabilities: [...capabilities],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: { ...M0_LIMITS, ...budgets },
    ...(terminal ? { connection: { connectionId: "connection-1", generation: 1 } } : {}),
  };
}

function frame(kind, metadata, payload = new Uint8Array()) {
  const encoded = encodeTerminalFrame(kind, encoder.encode(JSON.stringify(metadata)), payload);
  if (!encoded.ok) throw new Error("invalid fixture frame");
  return encoded.value;
}

function command(bytes) {
  const parser = createTerminalDecoder();
  const read = parser.read(bytes);
  expect(read.frames).toHaveLength(1);
  expect(parser.finish().ok).toBe(true);
  return JSON.parse(decoder.decode(read.frames[0].metadata));
}

function clock() {
  let now = 0;
  const timers = new Set();
  return {
    nowMs: () => now,
    setTimer(delay, callback) {
      const timer = { at: now + delay, callback };
      timers.add(timer);
      return { dispose: () => timers.delete(timer) };
    },
    yieldTurn: async () => {},
    advance(ms) {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now && timers.delete(timer)) timer.callback();
    },
    get active() {
      return timers.size;
    },
  };
}

async function harness({
  budgets = {},
  capabilities = M0_CAPABILITIES,
  onSend,
  createOpaqueId,
  scheduler = clock(),
} = {}) {
  const commands = [];
  const attempts = [];
  let nextId = 0;
  let client;
  client = createClient({
    expectedServerId: identity.serverId,
    expectedRelayInstanceId: identity.relayInstanceId,
    buildVersion: "client-build",
    credentials: () => ({ authorization: "Bearer fixture", terminalSecret: "a".repeat(43) }),
    codec: {
      encode: (text) => encoder.encode(text),
      decodeFatal: (bytes) => decoder.decode(bytes),
    },
    createOpaqueId: () => {
      const id = ++nextId;
      return createOpaqueId ? createOpaqueId(client, id) : `request-${id}`;
    },
    scheduler,
    http: {
      post(_request, callbacks) {
        queueMicrotask(() =>
          callbacks.onResponse({
            status: 200,
            headers: {},
            body: encoder.encode(JSON.stringify(bootstrap(false, budgets, capabilities))),
          }),
        );
        return { cancel: () => "not-sent" };
      },
    },
    terminal: {
      open(callbacks) {
        const attempt = {
          callbacks,
          commands: [],
          emit(kind, metadata, payload) {
            callbacks.onBinary(frame(kind, metadata, payload));
          },
          result(sent, status, version) {
            this.emit(2, {
              type: "preview-result",
              requestId: sent.requestId,
              run: sent.run,
              status,
              version,
            });
          },
          transfer(previewId, version, bytes, targetRun = run) {
            this.emit(3, {
              type: "preview-start",
              run: targetRun,
              previewId,
              version,
              atSeq: 7,
              geometry,
              generatedAtMs: 123,
              vtBytes: bytes.byteLength,
              chunkCount: 1,
            });
            this.emit(
              3,
              { type: "preview-chunk", run: targetRun, previewId, version, ordinal: 0 },
              bytes,
            );
            this.emit(3, {
              type: "preview-end",
              run: targetRun,
              previewId,
              version,
              atSeq: 7,
              totalBytes: bytes.byteLength,
            });
          },
        };
        attempts.push(attempt);
        callbacks.onOpen({
          send(message) {
            if (typeof message === "string") {
              callbacks.onText(
                encoder.encode(JSON.stringify(bootstrap(true, budgets, capabilities))),
              );
              return "handed-off";
            }
            const sent = command(message);
            commands.push(sent);
            attempt.commands.push(sent);
            return onSend?.(sent, attempt, client) ?? "handed-off";
          },
          close() {},
          dispose() {},
        });
        return { cancel: () => "not-sent" };
      },
    },
  });
  expect((await client.connect()).ok).toBe(true);
  return {
    client,
    commands,
    attempts,
    scheduler,
    get peer() {
      return attempts.at(-1);
    },
  };
}

describe("client preview transaction", () => {
  test.each(["result-first", "events-first"])(
    "joins one opaque transfer in %s order without a live controller",
    async (order) => {
      const h = await harness();
      const promise = h.client.getPreview(run);
      const sent = h.commands.at(-1);
      const backing = new Uint8Array(1024 * 1024);
      backing.set([0xff, 0x00, 0x1b, 0x5b], 100);
      const bytes = backing.subarray(100, 104);
      if (order === "result-first") h.peer.result(sent, "transfer", 8);
      h.peer.transfer("preview-1", 8, bytes);
      if (order === "events-first") h.peer.result(sent, "transfer", 8);
      const outcome = await promise;
      backing.fill(0);
      expect(outcome).toMatchObject({
        ok: true,
        status: "transfer",
        version: 8,
        atSeq: 7,
        geometry,
        generatedAtMs: 123,
      });
      expect([...outcome.bytes]).toEqual([0xff, 0x00, 0x1b, 0x5b]);
      expect(h.commands).toHaveLength(1);
      expect(h.scheduler.active).toBe(0);
      h.client.dispose();
    },
  );

  test("result-first public request retains its logical lane slot until transfer completion", async () => {
    const h = await harness();
    const pending = h.client.getPreview(run);
    h.peer.result(h.commands.at(-1), "transfer", 1);
    // Counter observation is white-box; request and result use the public compiled path.
    expect(h.client.terminalLane.pendingCount).toBe(1);
    h.peer.transfer("held", 1, new Uint8Array([1]));
    expect(await pending).toMatchObject({ ok: true, status: "transfer" });
    expect(h.client.terminalLane.pendingCount).toBe(0);
    expect(h.scheduler.active).toBe(0);
    h.client.dispose();
  });

  test("result-first held slot retires once on deadline and on client disposal", async () => {
    const expired = await harness();
    const first = expired.client.getPreview(run);
    expired.peer.result(expired.commands.at(-1), "transfer", 1);
    expect(expired.client.terminalLane.pendingCount).toBe(1);
    expired.scheduler.advance(5_000);
    expect(await first).toMatchObject({ ok: false, error: { reason: "timeout" } });
    expect(expired.client.terminalLane.pendingCount).toBe(0);
    expect(expired.scheduler.active).toBe(0);
    expired.client.dispose();

    const disposed = await harness();
    const second = disposed.client.getPreview(run);
    disposed.peer.result(disposed.commands.at(-1), "transfer", 1);
    expect(disposed.client.terminalLane.pendingCount).toBe(1);
    disposed.client.dispose();
    expect(await second).toMatchObject({ ok: false, error: { reason: "disposed" } });
    expect(disposed.client.terminalLane.pendingCount).toBe(0);
    expect(disposed.scheduler.active).toBe(0);
  });

  test("accepts unchanged only for the matching supplied version", async () => {
    const h = await harness();
    const promise = h.client.getPreview(run, 5);
    h.peer.result(h.commands.at(-1), "unchanged", 5);
    expect(await promise).toEqual({ ok: true, status: "unchanged", version: 5 });
    const invalid = h.client.getPreview(run);
    h.peer.result(h.commands.at(-1), "unchanged", 5);
    expect(await invalid).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(h.client.snapshot().status).toBe("connected");
    h.client.dispose();
  });

  test("validates run and version before send and bounds same-run admission", async () => {
    const h = await harness();
    expect(await h.client.getPreview({ ...run, serverId: "other" })).toMatchObject({ ok: false });
    expect(await h.client.getPreview(run, Number.MAX_SAFE_INTEGER + 1)).toMatchObject({
      ok: false,
    });
    const first = h.client.getPreview(run);
    expect(await h.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    expect(h.commands).toHaveLength(1);
    h.peer.result(h.commands[0], "transfer", 2);
    h.peer.transfer("preview-2", 2, new Uint8Array([42]));
    expect((await first).ok).toBe(true);
    h.client.dispose();

    const noPreview = await harness({
      capabilities: M0_CAPABILITIES.filter((value) => value !== "terminal-preview-v1"),
    });
    expect(await noPreview.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    expect(noPreview.commands).toHaveLength(0);
    noPreview.client.dispose();
  });

  test("distinct run requests join by full run and mismatched versions quarantine only one run", async () => {
    const h = await harness();
    const other = { ...run, runId: "run-2" };
    const first = h.client.getPreview(run);
    const second = h.client.getPreview(other);
    const [firstCommand, secondCommand] = h.commands;
    h.peer.transfer("first", 2, new Uint8Array([1]));
    h.peer.result(firstCommand, "transfer", 3);
    expect(await first).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    h.peer.transfer("second", 4, new Uint8Array([2]), other);
    h.peer.result(secondCommand, "transfer", 4);
    expect(await second).toMatchObject({ ok: true, status: "transfer", version: 4 });
    expect(h.client.snapshot().status).toBe("connected");
    expect(await h.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    h.client.dispose();
  });

  test("interleaved same-connection runs each retain their own transfer", async () => {
    const h = await harness();
    const other = { ...run, runId: "run-2" };
    const first = h.client.getPreview(run);
    const second = h.client.getPreview(other);
    const [firstCommand, secondCommand] = h.commands;
    h.peer.result(secondCommand, "transfer", 2);
    h.peer.emit(3, {
      type: "preview-start",
      run,
      previewId: "first",
      version: 1,
      atSeq: 7,
      geometry,
      generatedAtMs: 123,
      vtBytes: 1,
      chunkCount: 1,
    });
    h.peer.transfer("second", 2, new Uint8Array([2]), other);
    h.peer.emit(
      3,
      { type: "preview-chunk", run, previewId: "first", version: 1, ordinal: 0 },
      new Uint8Array([1]),
    );
    h.peer.emit(3, {
      type: "preview-end",
      run,
      previewId: "first",
      version: 1,
      atSeq: 7,
      totalBytes: 1,
    });
    h.peer.result(firstCommand, "transfer", 1);
    expect([...((await first).bytes ?? [])]).toEqual([1]);
    expect([...((await second).bytes ?? [])]).toEqual([2]);
    expect(h.client.terminalLane.pendingCount).toBe(0);
    h.client.dispose();
  });

  test("rejects chunk before start and duplicate chunk without retiring the live connection", async () => {
    const h = await harness();
    const first = h.client.getPreview(run);
    h.peer.emit(
      3,
      { type: "preview-chunk", run, previewId: "orphan", version: 1, ordinal: 0 },
      new Uint8Array([1]),
    );
    expect(await first).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(h.client.snapshot().status).toBe("connected");
    expect(h.scheduler.active).toBe(0);
    h.client.dispose();

    const another = await harness();
    const second = another.client.getPreview(run);
    another.peer.emit(3, {
      type: "preview-start",
      run,
      previewId: "duplicate",
      version: 1,
      atSeq: 0,
      geometry,
      generatedAtMs: 1,
      vtBytes: 1,
      chunkCount: 1,
    });
    const chunk = { type: "preview-chunk", run, previewId: "duplicate", version: 1, ordinal: 0 };
    another.peer.emit(3, chunk, new Uint8Array([1]));
    another.peer.emit(3, chunk, new Uint8Array([1]));
    expect(await second).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(another.client.snapshot().status).toBe("connected");
    another.client.dispose();
  });

  test("wrong preview ID and end sequence fail only the identified active run", async () => {
    for (const mismatch of ["preview-id", "end-sequence"]) {
      const h = await harness();
      const pending = h.client.getPreview(run);
      h.peer.emit(3, {
        type: "preview-start",
        run,
        previewId: "selected",
        version: 1,
        atSeq: 7,
        geometry,
        generatedAtMs: 1,
        vtBytes: 1,
        chunkCount: 1,
      });
      h.peer.emit(
        3,
        {
          type: "preview-chunk",
          run,
          previewId: mismatch === "preview-id" ? "other" : "selected",
          version: 1,
          ordinal: 0,
        },
        new Uint8Array([1]),
      );
      if (mismatch === "end-sequence")
        h.peer.emit(3, {
          type: "preview-end",
          run,
          previewId: "selected",
          version: 1,
          atSeq: 8,
          totalBytes: 1,
        });
      expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
      expect(h.client.snapshot().status).toBe("connected");
      h.client.dispose();
    }
  });

  test("never-issued preview result invalidates the connection; wrong correlated run also invalidates", async () => {
    const h = await harness();
    const pending = h.client.getPreview(run);
    h.peer.emit(2, {
      type: "preview-result",
      requestId: "unknown-request",
      run,
      status: "transfer",
      version: 1,
    });
    expect(h.client.snapshot().status).toBe("incompatible");
    expect(await pending).toMatchObject({ ok: false, error: { reason: "transport" } });
    h.client.dispose();

    const wrongRun = await harness();
    const other = wrongRun.client.getPreview(run);
    wrongRun.peer.emit(2, {
      type: "preview-result",
      requestId: wrongRun.commands.at(-1).requestId,
      run: { ...run, runId: "other" },
      status: "transfer",
      version: 1,
    });
    expect(wrongRun.client.snapshot().status).toBe("incompatible");
    expect(await other).toMatchObject({ ok: false, error: { reason: "transport" } });
    wrongRun.client.dispose();
  });

  test("completed preview request IDs retire locally while a new unknown ID invalidates", async () => {
    const h = await harness();
    const pending = h.client.getPreview(run, 1);
    const sent = h.commands.at(-1);
    h.peer.result(sent, "unchanged", 1);
    expect(await pending).toMatchObject({ ok: true, status: "unchanged" });
    h.peer.result(sent, "unchanged", 1);
    expect(h.client.snapshot().status).toBe("connected");
    h.peer.emit(2, {
      type: "preview-result",
      requestId: "never-issued",
      run,
      status: "transfer",
      version: 2,
    });
    expect(h.client.snapshot().status).toBe("incompatible");
    h.client.dispose();
  });

  test("a rejected preview error retires its request ID but an unissued error invalidates", async () => {
    const h = await harness();
    const pending = h.client.getPreview(run);
    const sent = h.commands.at(-1);
    const rejected = {
      type: "error",
      requestId: sent.requestId,
      run,
      commandType: "preview",
      error: domainError("RUN_NOT_FOUND"),
    };
    h.peer.emit(4, rejected);
    expect(await pending).toMatchObject({ ok: false, uncertain: false });
    h.peer.emit(4, rejected);
    expect(h.client.snapshot().status).toBe("connected");
    h.peer.emit(4, { ...rejected, requestId: "never-issued-error" });
    expect(h.client.snapshot().status).toBe("incompatible");
    h.client.dispose();
  });

  test("duplicate result after result-first transfer fails only its active preview", async () => {
    const h = await harness();
    const pending = h.client.getPreview(run);
    const sent = h.commands.at(-1);
    h.peer.result(sent, "transfer", 1);
    expect(h.client.terminalLane.pendingCount).toBe(1);
    h.peer.result(sent, "transfer", 1);
    expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(h.client.terminalLane.pendingCount).toBe(0);
    expect(h.client.snapshot().status).toBe("connected");
    h.client.dispose();
  });

  test("keeps an unseen timed-out transfer quarantined until explicit reconnect", async () => {
    const h = await harness();
    const first = h.client.getPreview(run);
    h.scheduler.advance(5_000);
    expect(await first).toMatchObject({ ok: false, error: { reason: "timeout" } });
    expect(await h.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    expect(h.commands).toHaveLength(1);
    const old = h.peer;
    expect((await h.client.reconnect()).ok).toBe(true);
    const next = h.client.getPreview(run);
    old.transfer("late-old", 3, new Uint8Array([1]));
    expect(h.commands).toHaveLength(2);
    h.peer.transfer("fresh", 4, new Uint8Array([2]));
    h.peer.result(h.commands.at(-1), "transfer", 4);
    expect(await next).toMatchObject({ ok: true, status: "transfer", version: 4 });
    h.client.dispose();
  });

  test("256 distinct ambiguous runs consume the entire connection fence budget", async () => {
    const h = await harness({ onSend: () => "unknown" });
    for (let index = 0; index < 256; index++) {
      const distinct = { ...run, runId: `ambiguous-${index}` };
      expect(await h.client.getPreview(distinct)).toMatchObject({ ok: false, uncertain: true });
    }
    expect(await h.client.getPreview({ ...run, runId: "ambiguous-256" })).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    expect(h.commands).toHaveLength(256);
    expect(h.scheduler.active).toBe(0);
    h.client.dispose();
  });

  test("quarantine subsumes older retired IDs for the same run", async () => {
    const h = await harness();
    const first = h.client.getPreview(run);
    h.peer.transfer("old-complete", 1, new Uint8Array([1]));
    h.peer.result(h.commands.at(-1), "transfer", 1);
    expect((await first).ok).toBe(true);
    expect(h.client.terminalPreview.retiredCount).toBe(1);
    const second = h.client.getPreview(run);
    h.scheduler.advance(5_000);
    expect(await second).toMatchObject({ ok: false, error: { reason: "timeout" } });
    // The run fence subsumes event IDs; the old request ID still proves a late result.
    expect(h.client.terminalPreview.retiredCount).toBe(1);
    expect(h.client.terminalPreview.quarantined.size).toBe(1);
    h.peer.transfer("old-complete", 1, new Uint8Array([1]));
    h.peer.result(h.commands[0], "transfer", 1);
    expect(h.client.snapshot().status).toBe("connected");
    h.client.dispose();
  });

  test("unsolicited and wrong-run preview events invalidate the connected attempt", async () => {
    const eventBytes = new Uint8Array([1]);
    const unsolicited = await harness();
    unsolicited.peer.transfer("unsolicited", 1, eventBytes);
    expect(unsolicited.client.snapshot().status).toBe("incompatible");
    unsolicited.client.dispose();

    const wrongRun = await harness();
    const pending = wrongRun.client.getPreview(run);
    wrongRun.peer.transfer("wrong-run", 1, eventBytes, { ...run, runId: "other-run" });
    expect(wrongRun.client.snapshot().status).toBe("incompatible");
    expect(await pending).toMatchObject({ ok: false, error: { reason: "transport" } });
    wrongRun.client.dispose();
  });

  test("late known retired or quarantined identities stay local", async () => {
    const completed = await harness();
    const pending = completed.client.getPreview(run);
    completed.peer.transfer("completed", 1, new Uint8Array([1]));
    completed.peer.result(completed.commands.at(-1), "transfer", 1);
    expect((await pending).ok).toBe(true);
    completed.peer.transfer("completed", 1, new Uint8Array([1]));
    expect(completed.client.snapshot().status).toBe("connected");
    completed.client.dispose();

    const ambiguous = await harness({ onSend: () => "unknown" });
    expect(await ambiguous.client.getPreview(run)).toMatchObject({ ok: false, uncertain: true });
    ambiguous.peer.transfer("late-unknown", 1, new Uint8Array([1]));
    expect(ambiguous.client.snapshot().status).toBe("connected");
    ambiguous.client.dispose();
  });

  test("retirement ledger refuses its 257th transfer identity without eviction", async () => {
    const h = await harness();
    for (let index = 0; index < 256; index++) {
      const pending = h.client.getPreview(run);
      h.peer.transfer(`preview-${index}`, index + 1, new Uint8Array([index]));
      h.peer.result(h.commands.at(-1), "transfer", index + 1);
      expect((await pending).ok).toBe(true);
    }
    expect(await h.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    expect(h.commands).toHaveLength(256);
    expect(h.scheduler.active).toBe(0);
    h.client.dispose();
  });

  test("opaque ID supplier reentry cannot issue a second preview for the same run", async () => {
    let armed = false;
    let nested;
    const h = await harness({
      createOpaqueId(client, id) {
        if (armed) {
          armed = false;
          nested = client.getPreview(run);
        }
        return `request-${id}`;
      },
    });
    armed = true;
    const outer = h.client.getPreview(run);
    expect(await nested).toMatchObject({ ok: false, error: { reason: "capacity" } });
    expect(h.commands).toHaveLength(1);
    h.peer.transfer("outer", 1, new Uint8Array([1]));
    h.peer.result(h.commands[0], "transfer", 1);
    expect((await outer).ok).toBe(true);
    expect(h.client.terminalPreview.provisional.size).toBe(0);
    h.client.dispose();
  });

  test("provisional fence blocks distinct-run ID reentry at the 256th entry", async () => {
    let armed = false;
    let nested;
    const h = await harness({
      onSend: () => "unknown",
      createOpaqueId(client, id) {
        if (armed) {
          armed = false;
          nested = client.getPreview({ ...run, runId: "nested-257" });
        }
        return `request-${id}`;
      },
    });
    for (let index = 0; index < 255; index++) {
      expect(await h.client.getPreview({ ...run, runId: `fenced-${index}` })).toMatchObject({
        ok: false,
        uncertain: true,
      });
    }
    armed = true;
    const outer = h.client.getPreview({ ...run, runId: "outer-256" });
    expect(await nested).toMatchObject({ ok: false, error: { reason: "capacity" } });
    expect(await outer).toMatchObject({ ok: false, uncertain: true });
    expect(h.commands).toHaveLength(256);
    expect(new Set(h.commands.map((value) => value.requestId)).size).toBe(256);
    expect(h.client.terminalPreview.provisional.size).toBe(0);
    expect(h.client.terminalPreview.quarantined.size).toBe(256);
    h.client.dispose();
  });

  test("rejected and throwing IDs release provisional ownership; connection change fences send", async () => {
    let mode = "invalid";
    const h = await harness({
      createOpaqueId(client, id) {
        if (mode === "invalid") return "";
        if (mode === "throw") throw new Error("supplier failed");
        if (mode === "dispose") client.dispose();
        return `request-${id}`;
      },
    });
    for (const rejected of ["invalid", "throw"]) {
      mode = rejected;
      expect(await h.client.getPreview(run)).toMatchObject({
        ok: false,
        error: { reason: "capacity" },
      });
      expect(h.client.terminalPreview.provisional.size).toBe(0);
    }
    mode = "valid";
    const pending = h.client.getPreview(run, 1);
    h.peer.result(h.commands.at(-1), "unchanged", 1);
    expect((await pending).ok).toBe(true);
    mode = "dispose";
    expect(await h.client.getPreview({ ...run, runId: "on-dispose" })).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    expect(h.commands).toHaveLength(1);
    expect(h.client.terminalPreview.provisional.size).toBe(0);
    expect(h.client.terminalPreview.retiredCount).toBe(0);
  });

  test("accepts the exact 64KiB payload and rejects an effective cap excess", async () => {
    const h = await harness();
    const bytes = new Uint8Array(M0_LIMITS.previewBytesPerRun).fill(65);
    const first = h.client.getPreview(run);
    h.peer.transfer("maximum", 1, bytes);
    h.peer.result(h.commands.at(-1), "transfer", 1);
    expect((await first).bytes.byteLength).toBe(M0_LIMITS.previewBytesPerRun);
    h.client.dispose();

    const lower = await harness({ budgets: { previewBytesPerRun: 1 } });
    const second = lower.client.getPreview(run);
    lower.peer.transfer("over-lower-cap", 1, new Uint8Array([1, 2]));
    expect(await second).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(lower.client.snapshot().status).toBe("connected");
    lower.client.dispose();
  });

  test("white-box ingress lease and current decoder reservation block preview retention", async () => {
    const h = await harness();
    const start = {
      type: "preview-start",
      run,
      previewId: "aggregate",
      version: 1,
      atSeq: 0,
      geometry,
      generatedAtMs: 1,
      vtBytes: M0_LIMITS.previewBytesPerRun,
      chunkCount: 1,
    };
    const frameLease = frame(3, start).byteLength * 3 + MAX_METADATA_BYTES * 3;
    const cap = M0_LIMITS.outboundConnectionBytes + M0_LIMITS.reservedControlBytes;
    const simulatedBlockedParse = cap - frameLease - M0_LIMITS.previewBytesPerRun + 1;
    // This controlled lease projects blocked parser debt; it is not a public blocked view.
    expect(h.client.terminalLane.reserveIngress(simulatedBlockedParse)).toBe(true);
    const pending = h.client.getPreview(run);
    h.peer.emit(3, start);
    expect(await pending).toMatchObject({ ok: false, error: { reason: "capacity" } });
    h.client.terminalLane.releaseIngress(simulatedBlockedParse);
    expect(h.client.snapshot().status).toBe("connected");
    h.client.dispose();
  });

  test("settles inline delivery and clears ownership on close and late frames", async () => {
    const h = await harness({
      onSend(sent, peer) {
        peer.transfer("inline", 2, new Uint8Array([5]));
        peer.result(sent, "transfer", 2);
      },
    });
    expect(await h.client.getPreview(run)).toMatchObject({ ok: true, status: "transfer" });
    h.peer.transfer("inline", 2, new Uint8Array([5]));
    expect(h.scheduler.active).toBe(0);
    h.client.dispose();
    expect(h.scheduler.active).toBe(0);
    expect(await h.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "disposed" },
    });
  });

  test("definitely unsent refusal frees admission; connection loss settles one pending transfer", async () => {
    let refuse = true;
    const h = await harness({ onSend: () => (refuse ? "not-sent" : "handed-off") });
    expect(await h.client.getPreview(run)).toMatchObject({ ok: false, uncertain: false });
    refuse = false;
    const pending = h.client.getPreview(run);
    h.peer.emit(3, {
      type: "preview-start",
      run,
      previewId: "pending-close",
      version: 1,
      atSeq: 0,
      geometry,
      generatedAtMs: 1,
      vtBytes: 1,
      chunkCount: 1,
    });
    h.peer.callbacks.onClose();
    expect(await pending).toMatchObject({ ok: false, error: { reason: "transport" } });
    expect(h.scheduler.active).toBe(0);
    expect(h.client.snapshot().status).toBe("unverifiable");
    h.client.dispose();
  });

  test("unknown send is quarantined while synchronous timer expiry never sends", async () => {
    const unknown = await harness({
      onSend() {
        throw new Error("adapter lost the send disposition");
      },
    });
    expect(await unknown.client.getPreview(run)).toMatchObject({ ok: false, uncertain: true });
    expect(await unknown.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    unknown.client.dispose();

    const scheduler = clock();
    const unsent = await harness({ scheduler });
    scheduler.setTimer = (_delay, callback) => {
      callback();
      return { dispose() {} };
    };
    expect(await unsent.client.getPreview(run)).toMatchObject({
      ok: false,
      error: { reason: "timeout" },
      uncertain: false,
    });
    expect(unsent.commands).toHaveLength(0);
    unsent.client.dispose();
  });

  test("timer disposal reentry cannot restore a settled preview or client", async () => {
    const scheduler = clock();
    const h = await harness({ scheduler });
    const original = scheduler.setTimer;
    let reentered = false;
    scheduler.setTimer = (delay, callback) => {
      const handle = original(delay, callback);
      return {
        dispose() {
          handle.dispose();
          if (!reentered) {
            reentered = true;
            h.client.dispose();
          }
        },
      };
    };
    const pending = h.client.getPreview(run);
    h.peer.transfer("reentry", 1, new Uint8Array([1]));
    h.peer.result(h.commands.at(-1), "transfer", 1);
    expect(await pending).toMatchObject({ ok: true, status: "transfer" });
    expect(reentered).toBe(true);
    expect(h.client.snapshot().status).toBe("disposed");
    expect(scheduler.active).toBe(0);
  });

  test("disposing an idle view while preview is pending does not stop or steal the run", async () => {
    const h = await harness();
    const view = {
      initialize: async () => {},
      beginBaseline: async () => {},
      writeBaselineChunk: async () => {},
      finishBaseline: async () => {},
      applyEvent: async () => {},
      measureGrid: () => geometry,
      setAppearance: () => {},
      setVisibility: () => {},
      onInputIntent: () => ({ dispose() {} }),
      onFocusIntent: () => ({ dispose() {} }),
      onFailure: () => ({ dispose() {} }),
      dispose: () => {},
    };
    const opened = h.client.openTerminal({
      run,
      viewId: "view-idle",
      view,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(opened.ok).toBe(true);
    const pending = h.client.getPreview(run);
    opened.value.dispose();
    h.peer.transfer("after-view-disposal", 1, new Uint8Array([9]));
    h.peer.result(h.commands.at(-1), "transfer", 1);
    expect(await pending).toMatchObject({ ok: true, status: "transfer" });
    expect(h.commands.map((value) => value.type)).toEqual(["preview"]);
    expect(h.client.snapshot().status).toBe("connected");
    h.client.dispose();
  });
});
