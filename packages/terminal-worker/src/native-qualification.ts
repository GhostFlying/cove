import * as pty from "node-pty";

export interface NativeQualificationPty {
  readonly pid: number;
  writeBytes(bytes: Uint8Array): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  failure(): Error | null;
  disposeListeners(): void;
}

// Qualification only: node-pty 1.1.0 exposes no native-write drain or queue bound.
export function spawnNativeQualificationPty(
  executable: string,
  args: string[],
  cwd: string,
  onBytes: (bytes: Buffer) => void,
  onExit: (exit: { exitCode: number; signal?: number }) => void,
  spawnPty: typeof pty.spawn = pty.spawn,
): NativeQualificationPty {
  const terminal = spawnPty(executable, args, {
    cols: 80,
    rows: 24,
    cwd,
    env: process.env,
    encoding: null,
    handleFlowControl: false,
  });
  let fault: Error | null = null;
  let disposed = false;
  const data = terminal.onData((value) => {
    if (fault || disposed) return;
    if (!Buffer.isBuffer(value)) {
      fault = new Error("Pinned node-pty did not deliver raw Buffer data");
      return;
    }
    try {
      onBytes(Buffer.from(value));
    } catch (error) {
      fault = error instanceof Error ? error : new Error(String(error));
    }
  });
  const exit = terminal.onExit(onExit);
  return {
    pid: terminal.pid,
    writeBytes(bytes) {
      terminal.write(Buffer.from(bytes));
    },
    pause() {
      terminal.pause();
    },
    resume() {
      terminal.resume();
    },
    kill(signal) {
      terminal.kill(signal);
    },
    failure() {
      return fault;
    },
    disposeListeners() {
      if (disposed) return;
      disposed = true;
      data.dispose();
      exit.dispose();
    },
  };
}
