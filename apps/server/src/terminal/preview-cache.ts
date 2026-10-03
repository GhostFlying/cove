import { sameRunRef, sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { RunStatus } from "@cove/protocol/pipe";
import type { Geometry } from "@cove/protocol/profile";
import { RPC_METHODS, type RunRecord } from "@cove/protocol/rpc";
import type { RuntimePreviewCache } from "@cove/protocol/runtime";
import type { LocalRuntime } from "./local-runtime.js";
import type { ByteReservation } from "./runtime-retained-bytes.js";

export type PreviewPicture = RuntimePreviewCache & {
  worker: WorkerRef;
  atSeq: number;
  geometry: Geometry;
};
export type OwnedPreviewBytes = { vt: Uint8Array; backing: ByteReservation };
type Entry = { picture: PreviewPicture; backing: ByteReservation; metadata: ByteReservation };
export type PreviewReader = { readonly picture: PreviewPicture; release(): void };

export class PreviewCache {
  private readonly entries = new Map<string, Entry>();
  private committedBytes = 0;
  private closed = false;
  constructor(readonly runtime: LocalRuntime) {}

  private entry(run: RunRef): Entry | undefined {
    const entry = this.entries.get(run.runId);
    const current = this.runtime.registry.get(run);
    return entry &&
      current &&
      sameRunRef(entry.picture.run, run) &&
      sameWorkerRef(entry.picture.worker, current.worker)
      ? entry
      : undefined;
  }

  commit(picture: Omit<PreviewPicture, "vt">, owned: OwnedPreviewBytes): boolean {
    const budgets = this.runtime.composition.budgets;
    const current = this.runtime.registry.get(picture.run);
    const old = this.entries.get(picture.run.runId);
    if (
      this.closed ||
      !current ||
      !sameWorkerRef(current.worker, picture.worker) ||
      owned.vt.byteLength < 1 ||
      owned.vt.byteLength > budgets.previewBytesPerRun ||
      (!old && this.entries.size >= budgets.maxRuns) ||
      this.committedBytes - (old?.picture.vt.byteLength ?? 0) + owned.vt.byteLength >
        budgets.previewGlobalBytes
    )
      return false;
    const metadata = this.runtime.composition.bytes.reserve(4096);
    if (!metadata) return false;
    const next: Entry = {
      picture: { ...structuredClone(picture), vt: owned.vt },
      backing: owned.backing,
      metadata,
    };
    this.entries.set(picture.run.runId, next);
    this.committedBytes += owned.vt.byteLength - (old?.picture.vt.byteLength ?? 0);
    old?.backing.release();
    old?.metadata.release();
    return true;
  }

  acquire(run: RunRef): PreviewReader | null {
    const entry = this.entry(run);
    if (this.closed || !entry) return null;
    const metadata = this.runtime.composition.bytes.reserve(4096);
    if (!metadata) return null;
    const backing = this.runtime.composition.bytes.retainBacking(entry.picture.vt);
    if (!backing) {
      metadata.release();
      return null;
    }
    const { vt, ...fields } = entry.picture;
    let held = true;
    return {
      picture: { ...structuredClone(fields), vt },
      release: () => {
        if (!held) return;
        held = false;
        backing.release();
        metadata.release();
      },
    };
  }

  matches(run: RunRef, worker: WorkerRef, status: RunStatus): boolean {
    const entry = this.entry(run);
    const observed = this.runtime.registry.get(run)?.status;
    return (
      !!entry &&
      !!observed &&
      observed.status !== "unverifiable" &&
      !(observed.status === "exited" && status.status !== "exited") &&
      observed.parsedSeq === status.parsedSeq &&
      observed.geometry.cols === status.geometry.cols &&
      observed.geometry.rows === status.geometry.rows &&
      sameWorkerRef(entry.picture.worker, worker) &&
      status.status !== "unverifiable" &&
      status.parsedSeq !== null &&
      entry.picture.version === status.parsedSeq &&
      entry.picture.atSeq === status.parsedSeq &&
      entry.picture.geometry.cols === status.geometry.cols &&
      entry.picture.geometry.rows === status.geometry.rows
    );
  }

  checked(run: RunRef, status: RunStatus, checkedAtMs: number): boolean {
    const entry = this.entry(run);
    if (!entry || !this.matches(run, entry.picture.worker, status)) return false;
    entry.picture = {
      ...entry.picture,
      checkedAtMs,
      stale: false,
      status: structuredClone(status),
    };
    return true;
  }

  stale(run: RunRef): void {
    const entry = this.entry(run);
    if (entry) entry.picture = { ...entry.picture, stale: true };
  }

  getRecord(run: RunRef): RunRecord | null {
    const current = this.runtime.registry.get(run);
    if (!current) return null;
    const picture = this.entry(run)?.picture;
    return {
      run: { ...run },
      status: current.status.status,
      geometry: current.status.geometry,
      controlEpoch: current.status.controlEpoch,
      controlHolder: current.status.controlHolder,
      preview: {
        version: picture?.version ?? null,
        generatedAtMs: picture?.generatedAtMs ?? null,
        checkedAtMs: picture?.checkedAtMs ?? null,
        stale:
          !picture ||
          picture.stale ||
          current.status.status === "unverifiable" ||
          (current.status.parsedSeq !== null && current.status.parsedSeq > picture.atSeq) ||
          current.status.geometry.cols !== picture.geometry.cols ||
          current.status.geometry.rows !== picture.geometry.rows,
        byteLength: picture?.vt.byteLength ?? 0,
      },
    };
  }

  list(input: { limit: number; afterRunId?: string }): {
    runs: RunRecord[];
    nextAfterRunId?: string;
  } {
    const parsed = RPC_METHODS["terminal.list"].params.safeParse(input);
    if (!parsed.success || input.limit > this.runtime.composition.budgets.listPage)
      throw new Error("Invalid preview page");
    const statuses = [...this.runtime.registry.list()].sort((a, b) =>
      a.run.runId.localeCompare(b.run.runId),
    );
    const selected = statuses.filter(
      (status) => !input.afterRunId || status.run.runId.localeCompare(input.afterRunId) > 0,
    );
    const page = selected.slice(0, input.limit);
    const runs = page.map((status) => this.getRecord(status.run)!);
    return {
      runs,
      ...(selected.length > page.length ? { nextAfterRunId: page.at(-1)!.run.runId } : {}),
    };
  }

  snapshot() {
    return { entries: this.entries.size, committedBytes: this.committedBytes, closed: this.closed };
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.backing.release();
      entry.metadata.release();
    }
    this.entries.clear();
    this.committedBytes = 0;
  }
}
