import { useEffect, useRef, useState } from "react";
import type { TerminalSnapshot } from "@cove/client";
import type { RunRef } from "@cove/protocol/identity";
import { createTerminalViewBridgeEndpoint } from "@cove/terminal-web/view-bridge";
import { createXtermTerminalView, estimateXtermGrid } from "@cove/terminal-web/xterm-view";
import "@xterm/xterm/css/xterm.css";
import type { ViewDescriptor } from "../shared/api.js";

export function Terminal({ serverId, run }: { serverId: string; run: RunRef }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalSnapshot>();
  const [error, setError] = useState<string>();
  const [inputNotice, setInputNotice] = useState<string>();
  useEffect(() => {
    const element = container.current!;
    let disposed = false;
    let descriptor: ViewDescriptor | undefined;
    let endpoint: ReturnType<typeof createTerminalViewBridgeEndpoint> | undefined;
    let resize: ResizeObserver | undefined;
    let canMeasure = false;
    const view = createXtermTerminalView(element);
    // A pointer press is a separate deliberate control intent. DOM focus alone emits no
    // xterm input, while mount/reload must never acquire control automatically.
    const focus = (event: PointerEvent) => {
      if (!event.isTrusted || event.button !== 0 || !descriptor || !canMeasure) return;
      void window.cove
        .focusView(descriptor, view.measureGrid())
        .then((reply) => {
          if (!disposed && !reply.ok) setInputNotice(reply.error);
        })
        .catch(() => {
          if (!disposed) setInputNotice("Terminal control could not be verified");
        });
    };
    const blur = (event: FocusEvent) => {
      if (descriptor && !element.contains(event.relatedTarget as Node | null))
        void window.cove.blurView(descriptor);
    };
    element.addEventListener("pointerdown", focus);
    element.addEventListener("focusout", blur);
    const stopMessages = window.cove.onViewMessage((target, message) => {
      if (descriptor?.viewId === target.viewId && descriptor.generation === target.generation)
        endpoint?.receiveMessage(message);
    });
    const stopState = window.cove.onTerminalState((target, next) => {
      if (descriptor?.viewId === target.viewId && descriptor.generation === target.generation) {
        setState(next);
        const newlyReady = !canMeasure && next.phase === "ready";
        canMeasure = next.phase === "ready";
        if (newlyReady) endpoint?.publishGeometry(view.measureGrid());
      }
    });
    const stopInput = window.cove.onTerminalInput((target, notice) => {
      if (descriptor?.viewId !== target.viewId || descriptor.generation !== target.generation)
        return;
      if (notice.kind !== "input") {
        setInputNotice(
          "Input was rejected; inspect current connection and control before typing again.",
        );
        return;
      }
      const outcome = notice.outcome;
      const receipt = outcome.value;
      if (!outcome.ok || receipt?.unknownBytes || receipt?.notSentBytes)
        setInputNotice(
          `Input: ${receipt?.writtenBytes ?? 0} bytes written, ${receipt?.unknownBytes ?? 0} unknown, ${receipt?.notSentBytes ?? 0} not sent. Unknown input is never replayed.`,
        );
    });
    void (async () => {
      await document.fonts.ready;
      if (disposed) return;
      const measured = estimateXtermGrid(element);
      if (!measured)
        throw new Error("Terminal font geometry is not measurable yet; reopen this view");
      descriptor = await window.cove.openView(serverId, run);
      if (disposed) {
        await window.cove.closeView(descriptor);
        return;
      }
      endpoint = createTerminalViewBridgeEndpoint({
        bridgeGeneration: descriptor.generation,
        view,
        initialGeometry: measured,
        postMessage: (message) => {
          if (descriptor && !disposed) window.cove.viewMessage(descriptor, message);
        },
      });
      resize = new ResizeObserver(() => {
        // Before initialize, the view returns its logical fallback grid. Only the actual
        // measured estimator above may establish readiness; resize notices need a live backend.
        if (!disposed && canMeasure) endpoint?.publishGeometry(view.measureGrid());
      });
      resize.observe(element);
    })().catch((failure: unknown) => {
      if (!disposed)
        setError(failure instanceof Error ? failure.message : "Terminal view unavailable");
    });
    return () => {
      disposed = true;
      resize?.disconnect();
      element.removeEventListener("pointerdown", focus);
      element.removeEventListener("focusout", blur);
      stopMessages();
      stopState();
      stopInput();
      endpoint?.dispose();
      view.dispose();
      if (descriptor) void window.cove.closeView(descriptor);
    };
  }, [serverId, run.serverId, run.relayInstanceId, run.runId]);
  return (
    <section className="terminal-panel" aria-label="Terminal">
      <div className="terminal-status">
        <span>{state?.phase ?? "measuring"}</span>
        <span>Activity unknown</span>
        <span>
          {state
            ? `Run ${state.execution.status} · ${state.inputReady ? "Input ready" : "Observing / input unavailable"}`
            : "Awaiting server baseline"}
        </span>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {inputNotice ? (
        <p role="status">
          {inputNotice}
          <button onClick={() => setInputNotice(undefined)}>Dismiss</button>
        </p>
      ) : null}
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
