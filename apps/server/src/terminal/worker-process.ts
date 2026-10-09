import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRef } from "@cove/protocol/identity";
import { MAX_READ_BYTES } from "@cove/protocol/pipe";
import { WorkerPipeSession } from "./worker-pipe-session.js";
import type { LocalRuntime } from "./local-runtime.js";
import type { LocalTimer } from "./local-runtime-clock.js";

export type WorkerSpawn = (bin: string) => ChildProcessWithoutNullStreams;
const installedWorkerBin = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/.bin/cove-terminal-worker",
);
const spawnWorker: WorkerSpawn = (bin) =>
  spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
const closeTimers: LocalTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Only the directly spawned child supplies process-exit proof. Pipe loss is contact loss.
export class WorkerProcess {
  readonly session: WorkerPipeSession;
  readonly ready: Promise<void>;
  readonly closed: Promise<
    | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
    | { status: "unverifiable" }
  >;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private closedResolve!: (receipt: Awaited<WorkerProcess["closed"]>) => void;
  private readySettled = false;
  private started = false;
  private shutdownRequested = false;
  private firstError: "spawn" | "pipe" | "contact" | undefined;
  private writerClosed = false;
  private leaderExited = false;
  private closing: Promise<Awaited<WorkerProcess["closed"]>> | undefined;
  constructor(
    readonly runtime: LocalRuntime,
    worker: WorkerRef,
    now: () => number,
    private readonly createChild: WorkerSpawn = spawnWorker,
    private readonly closeTimer: LocalTimer = closeTimers,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A caller may inspect failed startup after the event; no unhandled-rejection leak.
    void this.ready.catch(() => {});
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    this.session = new WorkerPipeSession({
      worker,
      composition: runtime.composition,
      buildVersion: "0.0.0",
      now,
      timeoutMs: runtime.composition.budgets.recoveryDeadlineMs,
      identityLimit: 4096,
      codec: {
        encode: (text) => new TextEncoder().encode(text),
        decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      },
      transport: {
        write: (bytes, settled) => {
          const child = this.child;
          if (!child || this.writerClosed || child.stdin.destroyed)
            throw new Error("Worker writer unavailable");
          let owned = true;
          return child.stdin.write(bytes, (error) => {
            if (!owned) return;
            owned = false;
            settled(error ?? undefined);
          });
        },
      },
      contactLost: (ref) => {
        runtime.registry.contactLost(ref);
        this.fail("contact");
      },
    });
  }
  private fail(kind: NonNullable<WorkerProcess["firstError"]>): void {
    this.firstError ??= kind;
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject(new Error("Worker startup unavailable"));
    }
  }
  start(): void {
    if (this.started || this.shutdownRequested) throw new Error("Worker start already consumed");
    this.started = true;
    try {
      this.child = this.createChild(installedWorkerBin);
    } catch {
      this.fail("spawn");
      this.session.loseContact();
      this.closedResolve({ status: "unverifiable" });
      return;
    }
    const child = this.child;
    child.stderr.resume();
    child.on("error", () => {
      this.fail("spawn");
      this.session.loseContact();
    });
    child.stdin.on("error", () => {
      this.fail("pipe");
      this.session.loseContact();
    });
    child.stdin.once("close", () => {
      this.writerClosed = true;
      this.session.transportReleased();
    });
    child.stdin.on("drain", () => this.session.drain());
    child.stdout.on("error", () => {
      this.fail("pipe");
      this.session.loseContact();
    });
    child.stdout.on("data", (bytes: Buffer) => {
      if (this.session.closed) return;
      // Defensive: a paused Readable should not emit, but never reorder behind a backlog.
      if (this.ingress.length !== 0) {
        this.queueIngress(child, bytes);
        return;
      }
      const consumed = this.receiveSlice(bytes);
      if (consumed !== undefined && consumed < bytes.byteLength)
        this.queueIngress(child, bytes.subarray(consumed));
    });
    child.stdout.once("end", () => this.session.loseContact());
    child.once("exit", () => {
      this.leaderExited = true;
      this.session.loseContact();
    });
    child.once("close", (code, signal) => {
      this.session.loseContact();
      this.fail("contact");
      this.closedResolve(
        this.leaderExited ? { status: "exited", code, signal } : { status: "unverifiable" },
      );
    });
    if (!this.runtime.addWorker(this.session) || !this.session.start()) {
      this.fail("contact");
      this.session.loseContact();
      void this.close();
    }
  }
  // Ingress invariant: worker stdout bytes reach the session exactly once and in arrival
  // order. FrameDecoder.read stops after MAX_READ_FRAMES or MAX_READ_BYTES ("budget") so one
  // read cannot monopolise the event loop; whatever the session did not consume is still
  // owned here, not a protocol fault. That remainder is resubmitted on a later turn while
  // stdout stays paused, so the backlog never grows beyond the chunks already delivered and
  // the pipe's own backpressure reaches the worker. A genuine decode or validation fault
  // closes the session inside receive(), which drops the backlog.
  //
  // ingressBytes counts the backing stores actually kept alive, not the views into them: a
  // small remainder view can pin a much larger read buffer, so every retained remainder is
  // first copied into right-sized storage. The count only drops when an entry is released,
  // because a partially consumed entry still pins its whole copy.
  private readonly ingress: Uint8Array[] = [];
  private ingressBytes = 0;
  private ingressScheduled = false;

  // Returns the consumed byte count, or undefined once contact is lost.
  private receiveSlice(bytes: Uint8Array): number | undefined {
    // The session refuses backings larger than one read budget so it never retains a
    // hostile buffer; copy only the slice offered to this read.
    const slice =
      bytes.buffer.byteLength > MAX_READ_BYTES
        ? new Uint8Array(bytes.subarray(0, MAX_READ_BYTES))
        : bytes;
    let consumed: number;
    try {
      consumed = this.session.receive(slice);
    } catch {
      this.fail("pipe");
      this.session.loseContact();
      return undefined;
    }
    if (this.session.ready && !this.readySettled) {
      this.readySettled = true;
      this.readyResolve();
    }
    if (this.session.closed) return undefined;
    // An open session that made no progress on non-empty input can never drain it.
    if (consumed === 0 && slice.byteLength !== 0) {
      this.session.loseContact();
      return undefined;
    }
    return consumed;
  }

  private queueIngress(child: ChildProcessWithoutNullStreams, bytes: Uint8Array): void {
    // Check the cap before copying so an oversized remainder is never duplicated.
    if (this.ingressBytes + bytes.byteLength > this.runtime.composition.budgets.pipeQueuedBytes) {
      this.dropIngress(child);
      this.session.loseContact();
      return;
    }
    const owned = new Uint8Array(bytes);
    this.ingress.push(owned);
    this.ingressBytes += owned.buffer.byteLength;
    child.stdout.pause();
    if (this.ingressScheduled) return;
    this.ingressScheduled = true;
    setImmediate(() => this.pumpIngress(child));
  }

  // One budgeted read per turn; resume stdout only after the backlog is fully consumed.
  private pumpIngress(child: ChildProcessWithoutNullStreams): void {
    this.ingressScheduled = false;
    const head = this.ingress[0];
    if (!head || this.session.closed) {
      this.dropIngress(child);
      return;
    }
    const consumed = this.receiveSlice(head);
    if (consumed === undefined) {
      this.dropIngress(child);
      return;
    }
    if (consumed < head.byteLength) {
      this.ingress[0] = head.subarray(consumed);
    } else {
      this.ingress.shift();
      this.ingressBytes -= head.buffer.byteLength;
    }
    if (this.ingress.length !== 0) {
      this.ingressScheduled = true;
      setImmediate(() => this.pumpIngress(child));
      return;
    }
    child.stdout.resume();
  }

  // After contact loss nothing more is decoded; keep stdout flowing so the worker is never
  // blocked on a full pipe while it is being shut down.
  private dropIngress(child: ChildProcessWithoutNullStreams): void {
    this.ingress.length = 0;
    this.ingressBytes = 0;
    child.stdout.resume();
  }

  tick(): void {
    this.session.tick();
  }
  close(): Promise<Awaited<WorkerProcess["closed"]>> {
    if (!this.shutdownRequested) {
      this.shutdownRequested = true;
      this.session.loseContact();
      if (!this.started) {
        this.closedResolve({ status: "unverifiable" });
      } else if (this.child && !this.child.stdin.destroyed) {
        try {
          this.child.stdin.end();
        } catch {
          this.fail("pipe");
        }
      }
    }
    return (this.closing ??= new Promise((resolve) => {
      let settled = false;
      let handle: unknown;
      const finish = (receipt: Awaited<WorkerProcess["closed"]>): void => {
        if (settled) return;
        settled = true;
        if (handle !== undefined) this.closeTimer.clear(handle);
        resolve(receipt);
      };
      const signal = (value: NodeJS.Signals): void => {
        const child = this.child;
        // Use only the captured directly spawned child, never an arbitrary PID
        // or process group. A signal request is not exit or stream-close proof.
        if (!child || this.leaderExited || child.exitCode !== null || child.signalCode !== null)
          return;
        try {
          child.kill(value);
        } catch {
          // Keep waiting for observed closure; failure to signal proves no exit.
        }
      };
      void this.closed.then(finish);
      handle = this.closeTimer.set(() => {
        if (settled) return;
        signal("SIGTERM");
        handle = this.closeTimer.set(() => {
          if (settled) return;
          signal("SIGKILL");
          handle = this.closeTimer.set(() => {
            // Retire our own local transport handles so an unverified child
            // cannot keep the entry's event loop alive forever. This supplies
            // only stream retirement; the physical child-close observer and
            // direct exit observer remain the sole process evidence sources.
            this.child?.stdin.destroy();
            this.child?.stdout.destroy();
            this.child?.stderr.destroy();
            this.child?.unref();
            finish({ status: "unverifiable" });
          }, 1000);
        }, 2000);
      }, 5000);
    }));
  }
  snapshot() {
    return {
      started: this.started,
      pid: this.child?.pid ?? null,
      ready: this.session.ready,
      contact: this.session.closed ? "unverifiable" : "live",
      writerClosed: this.writerClosed,
      directlyOwnedLeaderExited: this.leaderExited,
      firstError: this.firstError ?? null,
      ingressRetainedBytes: this.ingressBytes,
    };
  }
}
