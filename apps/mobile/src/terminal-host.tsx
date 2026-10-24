import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { Client, TerminalController } from "@cove/client";
import type { RunRef } from "@cove/protocol/identity";
import { createTerminalViewBridgeHost } from "@cove/terminal-web/view-bridge";
import { terminalDocument } from "./terminal-document.generated";
import { observeTerminal, terminalPresentation } from "../dist/observation.js";

let incarnation = 0;

export function TerminalHost({
  client,
  run,
  onInputNotice,
}: {
  client: Client;
  run: RunRef;
  onInputNotice: (message: string) => void;
}) {
  const webview = useRef<WebView>(null);
  const controller = useRef<TerminalController | null>(null);
  const [status, setStatus] = useState("等待终端视图");
  const [canControl, setCanControl] = useState(false);
  const generation = useMemo(() => ++incarnation, []);
  const bridge = useMemo(
    () =>
      createTerminalViewBridgeHost({
        bridgeGeneration: generation,
        postMessage: (message) => {
          if (!webview.current) throw new Error("Terminal view unavailable");
          webview.current.injectJavaScript(
            `window.__coveReceive(${JSON.stringify(message)});true;`,
          );
        },
      }),
    [generation],
  );
  const html = useMemo(
    () => terminalDocument.replace("__COVE_NATIVE_GENERATION__", String(generation)),
    [generation],
  );

  useEffect(() => {
    let active = true;
    let stopWatching: (() => void) | undefined;
    void bridge.ready
      .then(async () => {
        if (!active) return;
        const result = client.openTerminal({
          run,
          viewId: `mobile-view-${generation}`,
          view: bridge,
          initialAppearance: { palette: [] },
        });
        if (!result.ok) {
          setStatus("终端当前不可核实");
          return;
        }
        controller.current = result.value;
        const owned = result.value;
        stopWatching = observeTerminal(
          owned,
          () => active && controller.current === owned,
          (state) => {
            setStatus(state.status);
            setCanControl(state.canControl);
          },
          onInputNotice,
        );
        result.value.setInputTarget(true, false);
        const attached = await result.value.attach();
        if (active && controller.current === owned) {
          const state = terminalPresentation(owned.snapshot());
          setStatus(attached.ok ? state.status : "终端当前不可核实");
          setCanControl(attached.ok && state.canControl);
        }
      })
      .catch(() => {
        if (active) setStatus("终端视图加载失败");
      });
    return () => {
      active = false;
      stopWatching?.();
      controller.current?.setInputTarget(false, false);
      controller.current?.dispose();
      controller.current = null;
      bridge.dispose();
    };
  }, [client, run, bridge, generation, onInputNotice]);

  return (
    <View style={{ flex: 1, minHeight: 200 }}>
      <Text>{status}</Text>
      <Button
        title="控制（再点终端输入）"
        disabled={!canControl}
        onPress={() => {
          const owned = controller.current;
          if (!owned) return;
          owned.setInputTarget(true, true);
          void owned.requestFocus().then((result) => {
            if (controller.current !== owned) return;
            const state = terminalPresentation(owned.snapshot());
            setStatus(result.ok ? state.status : "控制结果未核实");
            setCanControl(state.canControl);
          });
        }}
      />
      <WebView
        ref={webview}
        source={{ html, baseUrl: "https://cove.invalid/" }}
        style={{ flex: 1 }}
        originWhitelist={["*"]}
        javaScriptEnabled
        mixedContentMode="never"
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        onShouldStartLoadWithRequest={({ url }) =>
          url === "about:blank" || url === "https://cove.invalid/"
        }
        onMessage={({ nativeEvent }) => bridge.receiveMessage(nativeEvent.data)}
        onError={() => bridge.invalidate()}
      />
    </View>
  );
}
