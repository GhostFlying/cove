# T1 retained-column continuation: bounded decision analysis

2026-09-26; owner `/root/m0_p1a_plan`, GPT-6 Astra high. Planning only: no probes, implementation, dependency edits or nested agents. Sources are committed Cove docs at `a9ea270270cd439a883b586f72090d0d04d70b5e`, T1 plan `55c59b1`, candidate `28e8c3d7bdfefd753897c187d00cab36996c2145`, immutable pinned vendor source, and read-only Orca Git objects. Reported executions below belong to the implementer; independent reproduction remains pending.

## Conclusion and decision boundary

Recommend the next small probe test **VT plus bounded receiver reconstruction geometry**, preserving source behavior. The reported 41-to-40 receiver reconstruction is promising evidence for one case, not a solution for arbitrary retained state. P1b is unfrozen and accepted design explicitly allows VT plus metadata: trying a receiver-only geometry schedule is an ordinary implementation experiment, not a new architecture or user approval gate.

The acceptance does not change: retain both buffers' necessary state and preserve same-suffix behavior at the authoritative grid. Temporary reconstruction geometry must never resize the source or PTY, emit authoritative size/control events, grant input, or expose a partly restored view. The receiver commits the installed baseline only after returning to the authoritative geometry, restoring registers/modes, applying the bounded tail and reaching the exact event boundary. Q1 must suppress every automatic reply during this process without discarding genuine user input.

A user decision is required if the fallback changes live resize/edit semantics, discards retained hidden cells, weakens required continuation, or abandons VT-plus-metadata for private snapshots/cell-grid wire data. A narrowly maintained read/export or receiver restoration patch that preserves those semantics can remain within the accepted adapter/patch experiment, with explicit maintenance evidence and coordinator ownership; it is not automatically an architecture change.

## Evidence and actual failure mechanism

Immutable root: `/var/folders/_1/sj9wh3913439fyzt6694p4hr0000gp/T/cove-m0-terminal-reference-ingi4ltc` from `/tmp/cove-m0-p1a-verification/terminal-reference-path.txt`. Pins: headless/browser 6.0.0, serialize 0.14.0. I compared mapped headless `sourcesContent` with browser source: `Buffer.ts`, `BufferLine.ts`, `BufferSet.ts`, and `InputHandler.ts` are byte-identical, so the following observations are not inferred only from browser code.

- `src/common/buffer/Buffer.ts:150–178,235–259,296–313`: growth resizes stored lines; cursor/saved-X are clamped and margins reset. Shrink trimming occurs inside `_isReflowEnabled`, which requires a scrollback-bearing buffer. Alternate lacks scrollback and can retain line storage wider than logical cols. This is live cell state, not merely spare allocation capacity.
- `BufferLine.ts:257–299`; `InputHandler.ts:1381–1417`: ICH/DCH shift using `line.length`, even though cursor positioning is restricted to the logical grid. Thus hidden cells can affect **same-grid** output. `BufferSet.ts:77–89,120–124` also shows that returning to normal clears alternate, and a public terminal resize applies to both buffers.
- Public `headless/typings/xterm-headless.d.ts:1039–1180` exposes line length, wrapped flag, cells, basic styles/colors, so off-grid cells can be read without mutating source. It does not expose complete saved cursor/charset/margins/tab/parser state or every extended attribute. Public buffer reads alone do not establish a complete checkpoint.
- `serialize/src/SerializeAddon.ts:32–55,432–446`: serialization uses physical `line.length` for intermediate rows but logical `terminal.cols` as the final row bound. It also generates VT for the current terminal geometry. The failure is not accurately described as “the serializer always reads only visible cells”: emitting retained text at the wrong receiver width can wrap/move it instead of reconstructing its stored location.
- Cove candidate `28e8c3d:packages/terminal-engine/probes/recovery-checkpoint.ts` emits one VT blob for current dimensions, with saved-state supplementation and private-read guards. It has no reconstruction geometry schedule. Neither appending more text nor changing only the serializer's final-column bound establishes equivalent retained state.

Reported reproducer: cols 41, rows 2; `ESC[?47h`, `B` repeated 40, `A`, `ESC[0m`; resize to 40×2. Alternate line retains length 41 and `A` at x=40. Fresh current-grid restoration loses its location; suffix `ESC[1;1H ESC[P` shifts source `A` into visible x=39 while receiver remains blank. A baseline supplied only after a later resize cannot fix this suffix.

Implementer follow-up: fresh receiver at 41, replay alternate content, then public resize to 40 preserves `A` and matches this DCH suffix. This is reported feasibility for the minimal case only. No independent proof, mixed widths, styles, history or both-buffer qualification is claimed.

## Options

### A. VT plus an explicit reconstruction geometry schedule — preferred next probe

Generate VT from a settled source using public retained-cell reads plus the already isolated read-only register boundary. The receiver interprets bounded geometry steps interleaved with VT, then ends at the logical size. Keep all fields local to the experiment; do not introduce a production schema yet. Future contract impact is install geometry distinct from authority geometry, ordered resize/write barriers, byte/step/maximum-dimension budgets, history coverage and atomic install completion. The content remains VT; engine names, private buffers and cell arrays do not enter the wire.

Benefit: the minimal case is representable without changing the source, adding a second live authority, or replaying unlimited history. Bounds can initially stay within T1's 120×40 grid, 1000 retained history lines, 8 MiB checkpoint and 64 KiB tail. Storage/reconstruction width must be bounded separately from current logical width; never silently clamp a retained width to make a test pass.

Limits requiring immediate probes:

1. **Mixed line lengths:** padding every row to one maximum width changes behavior even if the added cells are blank. A real 40-cell row with a sentinel at x=39 loses it after ICH at x=0; DCH then cannot bring it back. A padded 41-cell row can retain that sentinel at hidden x=40 and bring it back. This is a source-derived counterexample prediction, not an executed test. Mixed rows can arise when new rows are allocated after a shrink. One maximum width is not sufficient evidence.
2. **Both buffers and reflow:** a temporary 40→41→40 also transforms hidden normal history, wraps, cursor, saved X and margins. Reconstructing alternate and then switching back to repair normal clears alternate. Reconstructing normal first requires proving the later geometry schedule preserves it, including trimmed-history cases where reflow is not reversible. Do not assume widening and narrowing are inverse operations.
3. **Complete state:** sparse VT must distinguish null cells from literal spaces, preserve styles/wide and combined characters, wrap flags and saved/current registers, then replay parser tail last. A public-cell loop is not yet a serializer replacement. Existing partial-state gaps are still T1 blockers.

A more detailed bounded resize/VT schedule might create rows at their intended storage widths and replace rows via normal VT editing before final state restoration. That is a hypothesis to test, not permission to ship per-cell metadata or a claim all snapshots have such a schedule. Public-only snapshot generation cannot claim complete registers; retain justified guarded reads or propose an explicit export patch.

### B. Narrow maintained serialization/restoration patch — fallback if A cannot cover required states

A concrete source-side patch could expose a read-only recovery export including retained-line extents and otherwise unavailable registers, and make serializer traversal use an explicit reconstruction context instead of pretending current logical width describes all storage. It would emit VT plus neutral geometry metadata without resizing/mutating the live source. This addresses inaccessible state/serialization logic, not receiver representability by itself.

If public receiver operations cannot restore mixed widths and both buffers without destructive reflow, a receiver-only transactional restoration API could isolate target-buffer reconstruction geometry from the other buffer and postpone normal reflow until installation commits. Such a patch must have explicit generic restoration semantics, preserve ordinary live parsing/resize outside installation, and consume VT plus geometry rather than assign received private cell objects. This is a larger maintenance surface than a serializer fix; inspect exact Buffer/BufferSet/adapter surfaces before proposing it as “small”.

**A serializer-only patch cannot put arbitrary off-grid cells into a fresh fixed-40-column model with ordinary fixed-grid VT.** Changing traversal/clamping merely changes the emitted string. Receiver geometry or another defined receiver restoration action is required. Patching ICH/DCH to ignore retained cells, or shrinking them away, changes the source behavior and belongs to option C, not this preservation option.

Costs: pinned patches/generated bundles, shape/version guards, upstream upgrade revalidation, headless plus browser adapter parity and mixed-client capability testing. A browser/engine-specific implementation can serve a renderer-neutral contract only when semantics and conformance fixtures are independent of its private layout. Patch authorization is coordinated with the sole dependency writer; no patch is implemented by this analysis.

### C. Change live resize semantics to discard hidden columns — explicit behavior decision

A targeted engine change could trim non-reflowing lines on width shrink in `Buffer.resize`, using `BufferLine.resize` so cut combined/extended attributes are also removed. Then the hidden `A` is truly absent in the authoritative source and the minimal continuation no longer requires it. Patching editing to clamp to logical width is a distinct behavioral change and does not by itself remove future widen-state obligations.

This changes what an uninterrupted terminal does after shrink, including later DCH/ICH and widening. It cannot be adopted merely to make the current required fixture pass. It needs user acceptance of the changed authoritative semantics and corresponding client profile/compatibility behavior; no mandatory test is silently waived. Headless/browser implementations must agree, and old clients retaining columns can diverge. Cost includes scanning stored lines on shrink and regression tests for wide glyphs, alternate redraw and cursor/history behavior. Whether these semantics are preferable to the upstream quirk is a product/profile choice, not established by this analysis.

### D. Preserve a pre-shrink checkpoint plus an ordered resize/output journal

A checkpoint at 41 followed by the actual resize to 40 preserves the minimal case without inventing an inverse snapshot. A bounded journal of geometry and bytes is a useful comparison/control and possibly a fallback within the existing checkpoint-plus-tail experiment. It requires resize events as well as byte offsets and must suppress reconstruction replies.

It is not a general bounded solution if the source remains indefinitely in a state for which no new complete checkpoint can be generated: ordinary valid output eventually exceeds the journal cap. Continuous full raw-session recording or a second permanent mirror would expand the accepted design. Demonstrate a bounded checkpoint-refresh strategy before calling this option sufficient; `unavailable` cannot replace a required bounded case. Refreshing a current-grid baseline on every suffix, requesting a TUI redraw, or relying only on a future authoritative resize likewise does not repair the representability issue.

## Next probe and stop condition

Have the implementer and independent tester preserve the exact minimal failure and positive geometry control. Next add only:

1. Mixed alternate row lengths 40/41 (both row orders), sentinel ICH→DCH at fixed 40, then widen/shrink; compare stored lengths/cells and hand-authored visible sentinels.
2. Nontrivial hidden normal state: wrapped content and the 3-line history budget, distinct saved cursor/SGR/charset and margins; construct alternate using the proposed geometry schedule, then exit alternate and continue normal without any extra authority resize.
3. Wide/combined glyph and styled blank at retained edge, current/pending wrap, and fresh receiver reconstruction twice. Compare source before/after generation and reply counters; no source resize, mutation, sink output or internal destination object assignment.

Use existing T1 bounds and oracle; no new protocol schema, production adapter or generic schedule framework. If the simple schedule fails, record its smallest counterexample and determine whether a bounded VT schedule or explicit preservation patch can solve it. Do not repeatedly broaden the generator while calling each local pass complete. Present user options only when the remaining choice changes authoritative behavior/acceptance or introduces a material architecture tradeoff.

## Orca comparison and evidence limits

Inspected pinned stable Orca `5534462b50c660888487a2108700d4cf284270db` read-only: `src/main/daemon/headless-emulator.ts:230–280` calls public resize and snapshots logical cols/rows with serialized ANSI; `src/main/daemon/terminal-frame-restore-sequences.ts:89–96` explicitly relies on a serializer patch for an out-of-range pen-state extraction. The source portion of `config/patches/@xterm__addon-serialize@0.15.0-beta.300.patch` covers links, blank-cell/style/wide-wrap and current-state restoration. These are useful examples of isolated compatibility maintenance, but the inspected code is not evidence for an off-grid reconstruction schedule or a fix for this stable-6.0.0 same-grid case. It uses different beta pins and no Orca execution was performed.

No implementation/probe result is produced by this report. T1 remains blocked on required continuation until exact candidate behavior is independently demonstrated; P1b remains unfrozen.
