import { z } from "zod";
import { SequenceSchema } from "./identity.js";

export const PROFILE = "pragmatic-logical-grid-v1" as const;
export const BASELINE_ENCODING = "vt-checkpoint-tail-v1" as const;
export const ProfileSchema = z.literal(PROFILE);
export const BaselineEncodingSchema = z.literal(BASELINE_ENCODING);
export const GeometrySchema = z.object({
  cols: z.number().int().min(2).max(120),
  rows: z.number().int().min(2).max(40),
});
export type Geometry = z.infer<typeof GeometrySchema>;

export const Rgb16Schema = z.string().regex(/^[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}$/);
export const PaletteEntrySchema = z.object({
  index: z.number().int().min(0).max(255),
  rgb: Rgb16Schema,
});
export const AppearanceSchema = z.object({
  foreground: Rgb16Schema.optional(),
  background: Rgb16Schema.optional(),
  palette: z.array(PaletteEntrySchema).max(256),
});
export type Appearance = z.infer<typeof AppearanceSchema>;

export function validateAppearance(input: unknown): Appearance | null {
  const parsed = AppearanceSchema.safeParse(input);
  if (!parsed.success) return null;
  const indices = parsed.data.palette.map((entry) => entry.index);
  return new Set(indices).size === indices.length ? parsed.data : null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  foreground: "ffff/ffff/ffff",
  background: "0000/0000/0000",
  palette: [{ index: 1, rgb: "cccc/0000/0000" }],
};

export const QueryCapabilitySchema = z.object({
  ids: z.array(z.string().max(32)).max(32),
  knownPaletteIndices: z.array(z.number().int().min(0).max(255)).max(256),
  appearanceEpoch: SequenceSchema,
});

// Only selectors with both Q1 suppression and T1 headless-reply evidence are advertised.
export const QUERY_SUPPORT = Object.freeze([
  { id: "dsr-status", selector: "CSI 5 n", source: "engine", fixture: "dsr-status" },
  { id: "cpr", selector: "CSI 6 n", source: "engine", fixture: "cpr" },
  { id: "dec-cpr", selector: "CSI ? 6 n", source: "engine", fixture: "dec-cpr" },
  { id: "da-primary", selector: "CSI c", source: "engine", fixture: "da-primary" },
  { id: "da-secondary", selector: "CSI > c", source: "engine", fixture: "da-secondary" },
  { id: "mode-report", selector: "CSI ? 2004 $ p", source: "engine", fixture: "mode-report" },
  { id: "color-fg", selector: "OSC 10 ; ?", source: "appearance", fixture: "color-fg" },
  { id: "color-bg", selector: "OSC 11 ; ?", source: "appearance", fixture: "color-bg" },
  {
    id: "color-palette",
    selector: "OSC 4 ; 1 ; ?",
    source: "appearance",
    fixture: "color-palette",
  },
] as const);

export const ResultClassificationSchema = z.enum([
  "required",
  "diagnostic",
  "integration-obligation",
]);
export const RecoveryCoverageSchema = z.object({
  normal: z.object({
    historyLines: z.number().int().min(0).max(1000),
    includedHistoryLines: z.number().int().min(0).max(1000),
    trimmedBefore: z.boolean(),
    resizeContext: z.enum(["complete", "requires-baseline"]),
  }),
  alternate: z.object({
    included: z.literal(true),
    resizeContext: z.enum(["complete", "requires-baseline"]),
  }),
});
export type RecoveryCoverage = z.infer<typeof RecoveryCoverageSchema>;
