import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Button, Linking, SafeAreaView, ScrollView, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import { openNativeNode } from "./modules/cove-tsnet";
import { MobileHost } from "./dist/mobile-host.js";
import { actionMessage } from "./dist/action-error.js";
import { parentRoute, type Route } from "./dist/navigation.js";
import { openLocalStore } from "./src/sqlite-store";
import { TerminalHost } from "./src/terminal-host";
import {
  Servers,
  ServerScreen,
  TaskScreen,
  DevicesScreen,
  OperationsScreen,
  styles,
  type Act,
} from "./src/screens";

const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
function Workbench({ host }: { host: MobileHost }) {
  const state = useSyncExternalStore(host.subscribe, host.snapshot);
  const [route, setRoute] = useState<Route>({ screen: "servers" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inAction = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const act: Act = useCallback((body) => {
    if (inAction.current) return;
    inAction.current = true;
    setBusy(true);
    setError("");
    void body()
      .catch((failure: unknown) => {
        if (mounted.current) setError(actionMessage(failure));
      })
      .finally(() => {
        inAction.current = false;
        if (mounted.current) setBusy(false);
      });
  }, []);
  useEffect(() => {
    const active = () => act(() => host.foreground());
    if (AppState.currentState === "active") active();
    const subscription = AppState.addEventListener("change", (value) => {
      if (value === "active") {
        // Lifecycle work cannot wait for an unrelated user action. Host generations fence both.
        void host.foreground().catch((failure: unknown) => {
          if (mounted.current) setError(actionMessage(failure));
        });
      } else {
        host.background();
        setNotice("");
      }
    });
    return () => {
      subscription.remove();
      host.background();
    };
  }, [host, act]);
  const profile =
    route.screen !== "servers" ? state.profiles.find((p) => p.id === route.profileId) : undefined;
  const props = profile
    ? { host, state, profile, snapshot: state.sessions[profile.id], act, busy, navigate: setRoute }
    : undefined;
  const terminal = route.screen === "terminal" && props;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f4f6f9" }}>
      {route.screen !== "servers" ? (
        <Button
          title="Back"
          onPress={() => {
            setNotice("");
            setRoute(parentRoute(route));
          }}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {busy ? <Text style={styles.note}>Working…</Text> : null}
      {!state.foreground ? (
        <Text style={styles.note}>Phone network paused. Remote run state is unverified.</Text>
      ) : null}
      {state.authURL ? (
        <Button
          title="Open Tailnet login"
          onPress={() => act(() => Linking.openURL(state.authURL))}
        />
      ) : null}
      {terminal ? (
        <View style={{ flex: 1, padding: 10, gap: 6 }}>
          <Text style={styles.title}>
            {props.profile.label} · {route.tabId}
          </Text>
          <Text>{notice}</Text>
          {props.snapshot?.status === "current" && state.foreground ? (
            <TerminalHost
              key={`${route.profileId}-${route.run.relayInstanceId}-${route.run.runId}-${props.snapshot.generation}`}
              client={host.session(route.profileId)}
              run={route.run}
              onInputNotice={setNotice}
            />
          ) : (
            <>
              <Text>
                Selected run is not currently verified. No input or control request will be
                replayed.
              </Text>
              <Button
                title="Reconnect selected server"
                disabled={busy}
                onPress={() => act(() => host.connect(route.profileId))}
              />
            </>
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {route.screen === "servers" || !props ? (
            <Servers host={host} state={state} act={act} busy={busy} navigate={setRoute} />
          ) : route.screen === "server" ? (
            <ServerScreen key={props.profile.id} {...props} />
          ) : route.screen === "task" ? (
            <TaskScreen
              key={`${props.profile.id}-${route.taskId}`}
              {...props}
              taskId={route.taskId}
            />
          ) : route.screen === "operations" ? (
            <OperationsScreen {...props} />
          ) : route.screen === "devices" ? (
            <DevicesScreen {...props} />
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
export default function App() {
  const [host, setHost] = useState<MobileHost | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let owned: MobileHost | undefined;
    let close: (() => Promise<void>) | undefined;
    void openLocalStore()
      .then(async (opened) => {
        close = opened.close;
        owned = new MobileHost({
          store: opened.store,
          // Optional compile-time fixture bootstrap; it is never a production connection field.
          // An enrolled test node must use the same bound selection after process restart.
          openNode: () =>
            openNativeNode("cove-mobile", process.env.EXPO_PUBLIC_COVE_TEST_CONTROL_URL ?? ""),
          secure: (key) => ({
            read: () => SecureStore.getItemAsync(key, secureOptions),
            write: (value) => SecureStore.setItemAsync(key, value, secureOptions),
            remove: () => SecureStore.deleteItemAsync(key, secureOptions),
          }),
          uuid: randomUUID,
          digest: (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
        });
        await owned.initialize();
        if (active) setHost(owned);
        else {
          owned.background();
          await opened.close();
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(actionMessage(failure));
      });
    return () => {
      active = false;
      owned?.background();
      if (owned) void close?.().catch(() => {});
    };
  }, []);
  if (!host)
    return (
      <SafeAreaView style={styles.page}>
        <Text style={styles.heading}>Cove</Text>
        <Text>{error || "Opening private app storage…"}</Text>
      </SafeAreaView>
    );
  return <Workbench host={host} />;
}
