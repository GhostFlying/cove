import type { Terminal } from "@xterm/xterm";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";

interface PendingOperation {
  incarnation: number;
  timer: number;
  reject(error: DomainError): void;
}

export class XtermParseOperation {
  private pending: PendingOperation | undefined;

  get active(): boolean {
    return this.pending !== undefined;
  }

  write(
    terminal: Terminal,
    bytes: Uint8Array,
    incarnation: number,
    isCurrent: () => boolean,
    fail: (error: DomainError) => void,
  ): Promise<void> {
    if (this.pending) return Promise.reject(domainError("BUSY"));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: DomainError) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(operation.timer);
        if (this.pending === operation) this.pending = undefined;
        if (error) reject(error);
        else resolve();
      };
      const operation: PendingOperation = {
        incarnation,
        timer: globalThis.setTimeout(() => {
          const error = domainError("RECOVERY_EXPIRED");
          settle(error);
          fail(error);
        }, M0_LIMITS.recoveryDeadlineMs),
        reject: (error) => settle(error),
      };
      this.pending = operation;
      try {
        terminal.write(bytes, () => {
          if (this.pending !== operation || operation.incarnation !== incarnation || !isCurrent())
            return;
          settle();
        });
      } catch {
        const error = domainError("RECOVERY_UNAVAILABLE");
        settle(error);
        fail(error);
      }
    });
  }

  cancel(error = domainError("RESYNC_REQUIRED")): void {
    this.pending?.reject(error);
  }
}
