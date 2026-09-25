# J: online final-print witness options

2026-09-26; Astra-high read-only analysis by `/root/m0_p1a_plan`. Inspected committed candidate `fb8f8243434993556f2be5bd83f17b966c6c8569`, plan `3368457af4ad765399dcf713cbf5b24ffa466fe9`, and the immutable headless 6.0.0 source already identified in the T1 plans. No uncommitted G code, tests, implementation or agent dispatch. This file is the only output.

## Finding and recommendation

J proves that **supplied** witnesses can reconstruct its authored cases; it does not yet derive a witness online. Prefer a small current-state-derived, renderer-neutral witness for cases where its placement and effect can be established. The existing private reader is sufficient to check current state but does not contain general last-print provenance. Do not try to reconstruct all print history from that snapshot or implement a second parser.

If concrete online cases cannot classify the final print without guessing, the next fallback is a narrow optional **authoritative-headless print observation hook**, not a receiver state setter or a general restoration API. It can establish provenance and avoid duplicating the engine's charset/wrap/insert decisions. It cannot by itself solve a content preimage or repair coordinates invalidated by resize. Choose/implement that fallback only after the read-derived experiment identifies precisely which missing observation is needed; this report does not authorize a patch or direct ongoing G work.

## Exact evidence

- `fb8f824:probes/recovery-checkpoint.ts:184–243` accepts bytes, startX/startY, cellWidth and `erase/delete/none` from the caller. It validates bytes/position but does not establish their relation to the source. It restores registers, performs authored positioning/preimage editing, then emits the witness last.
- `recovery-join.test.mjs` derives only the ASCII position from the current cursor; its eight general cases supply the glyph/location/preimage literally. Source results report 20 actual fresh ASCII checkpoints, peak tail 32,784 bytes, peak baseline 711 bytes, immediate suffix cases and UTF-8 cuts. These are author-reported/committed assertions, not tests performed by this planner.
- `xterm-recovery-state.ts` reads current parser/decoder state, the join scalar, pen/charset, cursor/saved registers, tabs and margins. It does not retain original final-print input, effective target after wrap, whether a glyph was rejected, or the geometry generation in which a location was valid.
- Pinned `InputHandler.ts:214,512–665` receives decoded print spans, performs charset mapping and Unicode-width/join decisions, wraps/scrolls, inserts or rejects wide printing, and stores the final join state. `EscapeSequenceParser.ts:650–692` clears it on EXECUTE/completed CSI. `UnicodeV6.ts:132–145` encodes width/join rather than retaining the original codepoint; REP reads the cell behind the current cursor. Public cell text is therefore useful, but the original final glyph and current preceding cell are not interchangeable in every history.

## What an online witness actually needs

A witness is an equivalent reconstruction operation, not necessarily a byte-for-byte copy of the original final input. Keep two concerns separate:

| Concern         | Minimum information for a non-guessing candidate                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding         | Active normal/alternate buffer, settled parser/decoder boundary, ordered source event/byte boundary, geometry generation and current logical size. Never retain an unqualified row number across resize/scroll/buffer change.                                                                             |
| Printed content | For a placed/joined glyph: current retained cluster text/width/style via public cells, plus enough information to encode it under the restored charset. For a rejected glyph: a bounded original or equivalent mapped scalar and the actual rejection condition; no visible cell necessarily contains it. |
| Effect/location | Actual effective target/cursor and outcome: placed, joined, or rejected-wide. Distinguish insertion from overwrite and pending-wrap/scroll effects. This determines whether the tested erase/delete/none preimage is applicable; it does not make that preimage universally valid.                        |
| Validation      | Current pen/charset/modes/margins and read-only join observation, plus comparison of the resulting cells/cursor and immediate suffix behavior in the experiment. A nonzero join scalar alone does not select a correct witness.                                                                           |

Do not copy rows, whole buffers or parser objects into a witness. Read the complete cluster at a settled boundary; keep at most one bounded witness descriptor and a geometry/event generation. Data is local experimental state; the receiver continues to consume VT and approved neutral installation operations only.

### Existing reads: useful first option, not complete provenance

For the proven ASCII/ordinary wide cases, current cursor, width, public cell text, IRM and join state can propose a canonical witness. Under supported B/DEC charsets, test canonical rendered text against the actual restored mapping; do not assume every future charset is invertible or that the fixture's original `q` must be recovered from its rendered box glyph. A bounded source scalar can remove that ambiguity where needed.

A rejected width-two print at the last column with wrap disabled is different: the engine updates join information while leaving no new glyph cell. Current conditions can suggest an equivalent rejected-wide witness, but the rule must be proven against competing histories, not inferred from nonzero width alone. Likewise, after resize the current cursor may be clamped while join state remains nonzero: the former print location is stale, and current-cell inspection may support a different canonical witness or reveal no candidate under the tested recipe. Neither snapshot reads nor a remembered old coordinate establishes a valid current-grid preimage.

Thus **guarded reads plus a few explicitly proved current-state recipes may suffice for the accepted pinned profile**, but the existing reader is not a general witness derivation algorithm. Report unresolved states without claiming recovery is impossible. Do not accept routine unavailable output merely because a simple recipe cannot classify it.

### Narrow print observer: finite fallback surface

If provenance is the actual missing piece, observe decisions inside the existing print path rather than re-implementing charset, UTF-8 parsing and wrap/IRM logic outside it. An optional summary of the final effective print can contain:

- original decoded scalar and mapped scalar when necessary;
- actual placed/joined/rejected-wide outcome, target and post-print cursor, active buffer and size;
- current width/join classification and the identity of the settled update to which the summary belongs.

Use the actual engine branch outcomes, including both early `continue` paths for combining and rejected-wide printing; reading only before/after a whole mixed print span does not reveal those decisions. Across chunks, the affected public cell supplies the full retained cluster; a summary must not retain the reused Uint32Array parse buffer. Emit/retain a compact final summary per print span if feasible, with no callback per cell and no copied full span. On checkpoint capture, rebind it to current state and reject stale geometry; preserve the existing bounded journal if replaying a known geometry event is needed.

Finite maintenance surfaces: `InputHandler.print` decision sites, an optional read-only observer contract/lifecycle, the authoritative headless adapter, pinned source/build/hash guards, and conformance/overhead tests. Parser control-reset and application resize/buffer-event invalidation must be covered; do not clone the parser transition table. An instrumentation observer must never alter cursor/cells/modes, synthesize output, answer queries or throw into authoritative parsing. Observation failure invalidates only recovery evidence and remains visible.

This is a maintained package change if no supported public print hook exists. Do not disguise monkey-patching `print`/parser handlers as a free public API. It is narrower than a Buffer/BufferSet restoration transaction, but still touches a hot path: benchmark enabled overhead and test batch-vs-chunk equivalence before claiming low cost. Because it observes the authoritative model only, it does not inherently require changing browser printing semantics; upgrade conformance must nevertheless prove the resulting VT still restores browser receivers. A hook is an observation aid, not a solution to G or a generic inverse-terminal solver.

## Witness budget: the 67-byte cluster is ordinary

The candidate's 64-byte witness cap is an experimental sublimit, not an accepted terminal capability. A retained 67-byte cluster that easily fits the 8 MiB checkpoint cannot be declared unsupported/pathological solely because it exceeds that sublimit.

Prefer charging the encoded complete cluster to the existing checkpoint budget, rather than creating a second arbitrary tiny capability limit. At a settled capture, preflight UTF-8 byte length with a bounded scan before allocating the output; bound witness plus baseline plus temporary overlap, not each allocation independently. Do not repeatedly concatenate/copy a growing combining cluster on every codepoint: retain scalar/provenance metadata and read the already-held immutable cell text when taking a checkpoint. Its eventual encoding is counted explicitly; retained source-model storage is a separate budget already owned by T1.

This removes the artificial 64/67 boundary, not every possible budget problem. A cluster alone can grow beyond a finite checkpoint budget; that requires explicit bounded failure/accounting under the overall retained-state policy, not a universal compact-witness claim. A smaller equivalent seed could be explored only if it preserves exact cluster content and suffix behavior; copying the complete ordinary cluster is the simpler first treatment. Raising the raw-tail cap does not fix absent online checkpoint derivation.

## Bounded evidence needed next, and decision boundary

When a separate online-witness task is allocated, remove fixture-authored glyph/position/preimage inputs from its acceptance path. Use the same 20-refresh workload and finite J cases, adding the 67-byte cluster and a print→resize→checkpoint case. Compare whole-span/byte-split input, B/DEC mapping, IRM, wrap-disabled rejected-wide, join across chunks and immediate REP/combining before any query that would reset join state. Fixtures supply source bytes and expected outcomes only. Record which witness rule fired and prove source immutability and bounded retained metadata/encoding.

Freeze a failed rule with the smallest counterexample and missing observation. Do not add speculative observer fields or branch rules until that evidence names their purpose. Independent reconstruction of every candidate remains test evidence, not permission to maintain a permanent second live model in production.

Read-derived rules, honest budget accounting and isolated read instrumentation experiments remain ordinary implementation work under the unfrozen profile. A maintained hot-path observer requires an explicit scoped patch/ownership decision and measured cost; if its real maintenance burden conflicts materially with the user's goal to avoid forks, present that concrete tradeoff before committing to it. Changing source printing/resize semantics, discarding retained content, private-state wire transport or weakening required recovery needs the user's decision. None is implied by this recommendation, and ongoing G work remains untouched.
