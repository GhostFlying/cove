import { expect, test } from "vitest";
import { withViewPage } from "./view-browser-runner.mjs";

const encode = (value) => Array.from(new TextEncoder().encode(value));
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };

test("V1-R1 continues raw UTF-8 CSI OSC and DCS tails after every interior cut", async () => {
  const results = await withViewPage(async (page) =>
    page.evaluate(async () => {
      const encoder = new TextEncoder();
      const sequences = [
        { value: "é", line: "Aé", cursorX: 2 },
        { value: "\x1b[31mRED", line: "ARED", cursorX: 4 },
        { value: "\x1b]0;title\x1b\\Z", line: "AZ", cursorX: 2 },
        { value: "\x1bPignored\x1b\\Q", line: "AQ", cursorX: 2 },
      ];
      const observed = [];
      for (const sequence of sequences) {
        const bytes = encoder.encode(sequence.value);
        for (let cut = 1; cut < Math.min(bytes.length, 8); cut++) {
          await window.coveView.reset();
          await window.coveView.baseline([[65, ...Array.from(bytes.slice(0, cut))]], cut);
          observed.push({
            sequence: sequence.value,
            cut,
            expected: { line: sequence.line, cursorX: sequence.cursorX },
            evidence: await window.coveView.output(Array.from(bytes.slice(cut))),
          });
        }
      }
      return observed;
    }),
  );
  expect(results.length).toBeGreaterThan(8);
  for (const item of results) {
    expect(item.evidence.rows[0], `${JSON.stringify(item.sequence)} cut ${item.cut}`).toBe(
      item.expected.line,
    );
    expect(item.evidence.logical, `${JSON.stringify(item.sequence)} cut ${item.cut}`).toMatchObject(
      {
        activeBuffer: "normal",
        cursorX: item.expected.cursorX,
        cursorY: 0,
      },
    );
    expect(item.evidence.logical.modes).toMatchObject({
      applicationCursorKeysMode: false,
      bracketedPasteMode: false,
    });
    expect(item.evidence.inputs).toEqual([]);
  }
});

test("V1-R2 restores normal plus active alternate and continues after switching back", async () => {
  const evidence = await withViewPage(async (page) =>
    page.evaluate(async (bytes) => {
      await window.coveView.reset();
      await window.coveView.baseline([bytes]);
      const alternate = window.coveView.evidence();
      const normal = await window.coveView.output(
        Array.from(new TextEncoder().encode("\x1b[?1049lCONT")),
      );
      return { alternate, normal };
    }, encode("normal-one\r\nnormal-two\x1b[?1049h\x1b[HALT")),
  );
  expect(evidence.alternate.logical.activeBuffer).toBe("alternate");
  expect(evidence.alternate.rows.join("")).toContain("ALT");
  expect(evidence.normal.logical.activeBuffer).toBe("normal");
  expect(evidence.normal.rows.join("")).toContain("normal");
  expect(evidence.normal.rows.join("")).toContain("CONT");
});

test("V1-R3 keeps incremental writes and replaces a non-pristine model for a new baseline", async () => {
  const evidence = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready(Array.from(new TextEncoder().encode("FIRST")));
      const incremented = await window.coveView.output(
        Array.from(new TextEncoder().encode("-LIVE")),
      );
      await window.coveView.baseline([Array.from(new TextEncoder().encode("SECOND"))]);
      const replacement = window.coveView.evidence();
      const visibility = await window.coveView.hiddenReplacement();
      await window.coveView.reset();
      const construction = await window.coveView.attemptReplacementConstructionFailure();
      return { incremented, replacement, visibility, construction };
    }),
  );
  expect(evidence.incremented.rows.join("")).toContain("FIRST-LIVE");
  expect(evidence.replacement.rows.join("")).toContain("SECOND");
  expect(evidence.replacement.rows.join("")).not.toContain("FIRST");
  expect(evidence.replacement.logical).toMatchObject({ cols: 40, rows: 10 });
  expect(evidence.visibility.before.hidden).toBe(true);
  expect(evidence.visibility.replaced.hidden).toBe(true);
  expect(evidence.visibility.replaced.rows[0]).toBe("NEW");
  expect(evidence.visibility.shown.hidden).toBe(false);
  expect(evidence.construction.kind).toBe("RECOVERY_UNAVAILABLE");
  expect(evidence.construction.after).toBe("RESYNC_REQUIRED");
  expect(evidence.construction.evidence.failures.map((error) => error.kind)).toEqual([
    "RECOVERY_UNAVAILABLE",
  ]);
  expect(evidence.construction.evidence.ownedRoots).toBe(0);
});

test("V1-R4 fences a held callback across disposal and replacement", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.holdNextParse();
      window.coveView.startHeldOutput(Array.from(new TextEncoder().encode("\x1b]777;hold\x07")));
      const before = window.coveView.heldStatus();
      await window.coveView.reset();
      const afterReplace = window.coveView.heldStatus();
      window.coveView.releaseParse();
      await Promise.resolve();
      return { before, afterReplace, evidence: window.coveView.evidence() };
    }),
  );
  expect(result.before).toBe("pending");
  expect(result.afterReplace).toBe("rejected");
  expect(result.evidence.inputs).toEqual([]);
  expect(result.evidence.logical).toMatchObject({ cols: 40, rows: 10 });
});

test("V1-R5 applies ordinary authoritative resize and rejects baseline-required or mismatched control", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(
      async ({ run }) => {
        await window.coveView.reset();
        await window.coveView.ready();
        const resized = await window.coveView.event({
          type: "resize",
          run,
          seq: 1,
          geometry: { cols: 30, rows: 8 },
          requiresBaseline: false,
        });
        let required;
        let control;
        try {
          await window.coveView.event({
            type: "resize",
            run,
            seq: 2,
            geometry: { cols: 50, rows: 12 },
            requiresBaseline: true,
          });
        } catch (error) {
          required = error.kind;
        }
        try {
          await window.coveView.event({
            type: "control",
            run,
            seq: 3,
            epoch: 1,
            holder: null,
            geometry: { cols: 31, rows: 8 },
          });
        } catch (error) {
          control = error.kind;
        }
        return { resized, required, control, final: window.coveView.evidence() };
      },
      { run },
    ),
  );
  expect(result.resized.logical).toMatchObject({ cols: 30, rows: 8 });
  expect(result.required).toBe("RESYNC_REQUIRED");
  expect(result.control).toBe("RESYNC_REQUIRED");
  expect(result.final.logical).toMatchObject({ cols: 30, rows: 8 });
});

test("V1-R6 enforces chunk count byte totals overlap and the full streaming maximum", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      const malformed = await window.coveView.attemptBegin({
        vtBytes: 2,
        tailBytes: 0,
        chunkCount: 1,
        currentGeometry: { cols: 39, rows: 10 },
      });
      await window.coveView.reset();
      const begin = await window.coveView.attemptBegin({ vtBytes: 1, tailBytes: 0, chunkCount: 1 });
      const over = await window.coveView.attemptChunk([65, 66]);
      const unfinished = await window.coveView.attemptFinish();
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.holdNextParse();
      window.coveView.startHeldOutput([27, 93, 55, 55, 55, 59, 120, 7]);
      const overlap = await window.coveView.attemptOutput([65]);
      window.coveView.releaseParse();
      await window.coveView.awaitHeld();
      const missing = await window.coveView.attemptEvent({
        type: "output",
        run: { serverId: "server", relayInstanceId: "relay", runId: "run" },
        seq: 2,
      });
      await window.coveView.reset();
      const maximum = await window.coveView.fullMaximumBaseline();
      return {
        malformed,
        begin,
        over,
        unfinished,
        overlap,
        missing,
        maximum,
      };
    }),
  );
  expect(result).toMatchObject({
    malformed: "RESYNC_REQUIRED",
    begin: "ok",
    over: "RESYNC_REQUIRED",
    unfinished: "RESYNC_REQUIRED",
    overlap: "BUSY",
    missing: "RESYNC_REQUIRED",
  });
  expect(result.maximum.markers).toEqual(Array.from({ length: 129 }, (_, index) => index));
  expect(result.maximum.evidence.allRows.join("\n")).toContain("MARKER-128");
  expect(result.maximum.evidence.logical).toMatchObject({
    activeBuffer: "normal",
    cols: 40,
    rows: 10,
  });
  expect(result.maximum.evidence.failures).toEqual([]);
});
