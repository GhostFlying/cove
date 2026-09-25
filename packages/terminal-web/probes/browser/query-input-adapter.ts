import type { Terminal } from "@xterm/xterm";

const supportedVersion = "6.0.0";
const attached = new WeakSet<Terminal>();

interface CoreServiceSurface {
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  triggerBinaryEvent(data: string): void;
  onUserInput(listener: () => void): { dispose(): void };
}

interface PrivateTerminalSurface {
  _core?: { coreService?: CoreServiceSurface };
}

export interface QueryAdapterObservation {
  kind: "user-data" | "automatic-data" | "binary";
  bytes: number[];
}

export function attachQueryInputAdapter(
  terminal: Terminal,
  packageVersion: string,
  observe: (value: QueryAdapterObservation) => void,
): { dispose(): void } {
  if (packageVersion !== supportedVersion)
    throw new Error(`Unsupported xterm version: ${packageVersion}`);
  if (attached.has(terminal)) throw new Error("Query input adapter is already attached");
  const core = (terminal as unknown as PrivateTerminalSurface)._core?.coreService;
  if (
    !core ||
    typeof core.triggerDataEvent !== "function" ||
    typeof core.triggerBinaryEvent !== "function" ||
    typeof core.onUserInput !== "function"
  )
    throw new Error("Unsupported xterm core input surface");
  const originalData = core.triggerDataEvent;
  const originalBinary = core.triggerBinaryEvent;
  let disposed = false;
  let userSignalCount = 0;
  const userSignal = core.onUserInput(() => {
    userSignalCount++;
  });
  if (!userSignal || typeof userSignal.dispose !== "function")
    throw new Error("Unsupported xterm user-input signal disposal");

  // Classify at the core emission boundary: parser pauses cannot turn a later DOM action into a reply.
  const dataWrapper = function (
    this: CoreServiceSurface,
    data: string,
    wasUserInput = false,
  ): void {
    if (disposed) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    observe({ kind: wasUserInput ? "user-data" : "automatic-data", bytes });
    if (wasUserInput) {
      const priorSignals = userSignalCount;
      originalData.call(this, data, true);
      if (userSignalCount <= priorSignals)
        throw new Error("xterm user-input signal was not emitted");
    }
  };
  const binaryWrapper = function (this: CoreServiceSurface, data: string): void {
    if (disposed) return;
    const bytes = Array.from(data, (character) => character.charCodeAt(0));
    if (bytes.some((byte) => byte > 255)) throw new Error("xterm binary input escaped byte range");
    observe({ kind: "binary", bytes });
    originalBinary.call(this, data);
  };
  core.triggerDataEvent = dataWrapper;
  core.triggerBinaryEvent = binaryWrapper;
  attached.add(terminal);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (core.triggerDataEvent === dataWrapper) core.triggerDataEvent = originalData;
      if (core.triggerBinaryEvent === binaryWrapper) core.triggerBinaryEvent = originalBinary;
      userSignal.dispose();
      attached.delete(terminal);
    },
  };
}
