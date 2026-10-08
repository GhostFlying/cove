import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRef } from "@cove/protocol/identity";
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
      try {
        const consumed = this.session.receive(bytes);
        if (consumed !== bytes.byteLength && !this.session.closed) this.session.loseContact();
        if (this.session.ready && !this.readySettled) {
          this.readySettled = true;
          this.readyResolve();
        }
      } catch {
        this.fail("pipe");
        this.session.loseContact();
      }
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
    };
  }
}
