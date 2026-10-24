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
    const view = createXtermTerminalView(element);
    const stopMessages = window.cove.onViewMessage((target, message) => {
      if (descriptor?.viewId === target.viewId && descriptor.generation === target.generation)
        endpoint?.receiveMessage(message);
    });
    const stopState = window.cove.onTerminalState((target, next) => {
      if (descriptor?.viewId === target.viewId && descriptor.generation === target.generation)
        setState(next);
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
        if (!disposed) endpoint?.publishGeometry(view.measureGrid());
      });
      resize.observe(element);
    })().catch((failure: unknown) => {
      if (!disposed)
        setError(failure instanceof Error ? failure.message : "Terminal view unavailable");
    });
    return () => {
      disposed = true;
      resize?.disconnect();
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
