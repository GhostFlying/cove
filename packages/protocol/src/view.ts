import type { DomainError } from "./errors.js";
import type { Appearance, Geometry } from "./profile.js";
import type { BaselineDescriptor, TerminalEvent } from "./terminal.js";

export type InputIntent = {
  viewGeneration: number;
  source: "keyboard" | "paste" | "mouse";
  bytes: Uint8Array;
};
export type FocusIntent = {
  viewGeneration: number;
  focusSeq: number;
  focused: boolean;
  geometry: Geometry;
};
export type ViewInitialization = {
  profile: "pragmatic-logical-grid-v1";
  encoding: "vt-checkpoint-tail-v1";
  geometry: Geometry;
  appearance: Appearance;
  viewGeneration: number;
};

export interface TerminalView {
  initialize(input: ViewInitialization): Promise<void>;
  beginBaseline(descriptor: BaselineDescriptor): Promise<void>;
  writeBaselineChunk(bytes: Uint8Array): Promise<void>;
  finishBaseline(): Promise<void>;
  applyEvent(event: TerminalEvent, payload?: Uint8Array): Promise<void>;
  measureGrid(): Geometry;
  setAppearance(appearance: Appearance): void;
  setVisibility(visible: boolean): void;
  onInputIntent(listener: (intent: InputIntent) => void): { dispose(): void };
  onFocusIntent(listener: (intent: FocusIntent) => void): { dispose(): void };
  onFailure(listener: (error: DomainError) => void): { dispose(): void };
  dispose(): void;
}
