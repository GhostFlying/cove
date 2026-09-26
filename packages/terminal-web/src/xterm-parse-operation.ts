import type { Terminal } from "@xterm/xterm";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";

interface PendingOperation {
  incarnation: number;
  timer: number;
  reject(error: unknown): void;
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
    fail: (error: DomainError) => unknown,
  ): Promise<void> {
    if (this.pending) return Promise.reject(domainError("BUSY"));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(operation.timer);
        if (this.pending === operation) this.pending = undefined;
        if (error) reject(error);
        else resolve();
      };
      const failOperation = (error: DomainError) => {
        if (settled) return;
        // Detach before retiring the renderer. Retirement cancels any pending parse, and allowing
        // that cancellation to re-enter this operation would discard teardown errors or settle
        // the same write twice.
        settled = true;
        globalThis.clearTimeout(operation.timer);
        if (this.pending === operation) this.pending = undefined;
        let rejection: unknown = error;
        try {
          rejection = fail(error) ?? error;
        } catch (failure) {
          rejection = failure;
        }
        reject(rejection);
      };
      const operation: PendingOperation = {
        incarnation,
        timer: globalThis.setTimeout(() => {
          failOperation(domainError("RECOVERY_EXPIRED"));
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
        failOperation(domainError("RECOVERY_UNAVAILABLE"));
      }
    });
  }

  cancel(error = domainError("RESYNC_REQUIRED")): void {
    this.pending?.reject(error);
  }
}
