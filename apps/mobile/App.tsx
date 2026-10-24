import { useEffect, useRef, useState } from "react";
import { AppState, Button, Linking, SafeAreaView, Text, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { createClient, type Client } from "@cove/client";
import { createDefaultScheduler } from "@cove/client/web-ports";
import type { RunRef } from "@cove/protocol/identity";
import { openNativeNode } from "./modules/cove-tsnet";
import { NativePorts } from "./src/native-ports";
import { utf8 } from "./src/codec";
import { loadServer, type SavedServer, type SecureTokenStore } from "./src/credentials";
import { verifyServer, MOBILE_BUILD_VERSION } from "./src/entry";
import { pairServer } from "./src/pairing";
import { ForegroundOwnership } from "./src/lifecycle";
import { TerminalHost } from "./src/terminal-host";

const tokenKey = "cove.native.fixture.server";
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const store: SecureTokenStore = {
  read: () => SecureStore.getItemAsync(tokenKey, secureOptions),
  write: (raw) => SecureStore.setItemAsync(tokenKey, raw, secureOptions),
  remove: () => SecureStore.deleteItemAsync(tokenKey, secureOptions),
};
type Host = {
  node: Awaited<ReturnType<typeof openNativeNode>>;
  ports: NativePorts;
  client?: Client;
};

export default function App() {
  const ownership = useRef(new ForegroundOwnership()).current;
  const host = useRef<Host | null>(null);
  const actionActive = useRef(false);
  const selected = useRef<{ tabID: string; run: RunRef } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在加载原生节点");
  const [authURL, setAuthURL] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [invitation, setInvitation] = useState("");
  const [tabID, setTabID] = useState("");
  const [connected, setConnected] = useState<Client | null>(null);
  const [run, setRun] = useState<RunRef | null>(null);

  function stopHost(updateUI = true) {
    const owned = host.current;
    host.current = null;
    owned?.client?.dispose();
    owned?.ports.dispose();
    if (owned) void owned.node.close().catch(() => {});
    if (updateUI) {
      setConnected(null);
      setRun(null);
    }
  }

  async function connect(owned: Host, saved: SavedServer, generation: number) {
    const entry = owned.ports.entry(saved.peerID, saved.port);
    const identity = await verifyServer(entry.http, saved.serverId);
    if (!ownership.current(generation)) {
      entry.close();
      return;
    }
    const client = createClient({
      expectedServerId: saved.serverId,
      expectedRelayInstanceId: identity.relayInstanceId,
      buildVersion: MOBILE_BUILD_VERSION,
      credentials: () => ({ authorization: `Bearer ${saved.token}`, terminalSecret: saved.token }),
      codec: utf8,
      createOpaqueId: randomUUID,
      scheduler: createDefaultScheduler(),
      http: entry.http,
      terminal: entry.terminal,
    });
    owned.client = client;
    const outcome = await client.connect();
    if (!ownership.current(generation)) {
      client.dispose();
      return;
    }
    if (!outcome.ok) throw new Error("Server connection could not be verified");
    setConnected(client);
    setStatus("已验证 server 身份，HTTP / WebSocket 已连接");
    const selection = selected.current;
    if (selection) {
      const observed = await client.call("tab.get", { tabId: selection.tabID });
      if (!ownership.current(generation)) return;
      const latest = observed.ok ? observed.value.latestRun : null;
      if (
        latest?.verification === "live" &&
        latest.run.runId === selection.run.runId &&
        latest.run.relayInstanceId === selection.run.relayInstanceId
      )
        setRun(latest.run);
      else setStatus("所选终端当前未核实或已变化；不会自动转投新 run");
    }
  }

  async function startHost() {
    const generation = ownership.begin();
    stopHost();
    setLoading(true);
    setStatus("正在恢复原生节点");
    try {
      const node = await openNativeNode("cove-native-mobile");
      if (!ownership.current(generation)) {
        node.driver.stop();
        await node.close();
        return;
      }
      const owned: Host = { node, ports: new NativePorts(node.driver) };
      host.current = owned;
      const state = JSON.parse(node.status) as { state?: string; authURL?: string };
      setStatus(`原生节点：${state.state ?? "未知"}`);
      setAuthURL(state.authURL ?? "");
      if (state.state === "Running") {
        const saved = await loadServer(store);
        if (saved && ownership.current(generation)) await connect(owned, saved, generation);
      }
    } catch {
      if (ownership.current(generation)) setStatus("节点或连接未核实；可显式重新连接");
    } finally {
      if (ownership.current(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    void startHost();
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      ownership.setForeground(active);
      if (active) void startHost();
      else {
        stopHost();
        setLoading(false);
        setAuthKey("");
        setStatus("已暂停；远端终端继续运行");
      }
    });
    return () => {
      subscription.remove();
      ownership.setForeground(false);
      stopHost(false);
    };
    // Host ownership belongs to this mounted app, not render-time closures.
  }, []);

  function action(work: (current: () => boolean) => Promise<void>) {
    if (actionActive.current) return;
    actionActive.current = true;
    setBusy(true);
    const generation = ownership.begin();
    void work(() => ownership.current(generation))
      .catch(() => {
        if (ownership.current(generation)) setStatus("操作未完成或结果未知；不会自动重试");
      })
      .finally(() => {
        actionActive.current = false;
        setBusy(false);
      });
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "600" }}>Cove Native</Text>
      <Text accessibilityLabel="connection-status">{status}</Text>
      <TextInput
        accessibilityLabel="tailnet-auth-key"
        value={authKey}
        onChangeText={setAuthKey}
        placeholder="Tailnet auth key（留空使用登录链接）"
        editable={!busy && !loading}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={512}
      />
      <View style={{ flexDirection: "row" }}>
        <Button
          title="登录节点"
          disabled={busy || loading}
          onPress={() =>
            action(async (current) => {
              const owned = host.current;
              if (!owned) throw new Error("No native host");
              const key = authKey;
              setAuthKey("");
              const state = JSON.parse(await owned.node.login(key)) as {
                state?: string;
                authURL?: string;
              };
              if (!current()) return;
              setAuthURL(state.authURL ?? "");
              setStatus(`原生节点：${state.state ?? "未知"}；登录完成后重新连接`);
            })
          }
        />
        <Button
          title="重新连接"
          disabled={busy || loading}
          onPress={() => {
            void startHost();
          }}
        />
        <Button
          title="登出节点"
          disabled={busy || loading}
          onPress={() =>
            action(async (current) => {
              const owned = host.current;
              if (!owned) throw new Error("No native host");
              const result = JSON.parse(await owned.node.logout()) as {
                state?: string;
                remoteLogoutConfirmed?: boolean;
              };
              if (result.state !== "LoggedOut") throw new Error("Logout not confirmed");
              if (!current()) return;
              stopHost();
              setStatus(
                result.remoteLogoutConfirmed === false
                  ? "节点本地已登出；需核实 Tailnet 管理台登记"
                  : "节点已登出；Cove 配对凭据仍保留",
              );
            })
          }
        />
      </View>
      {authURL.startsWith("https://") && (
        <Button
          title="打开 Tailnet 登录"
          onPress={() => {
            void Linking.openURL(authURL);
          }}
        />
      )}
      <TextInput
        accessibilityLabel="pairing-invitation"
        value={invitation}
        onChangeText={setInvitation}
        placeholder="粘贴 Cove 邀请"
        editable={!busy && !loading}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={2048}
      />
      <View style={{ flexDirection: "row" }}>
        <Button
          title="配对"
          disabled={busy || loading}
          onPress={() =>
            action(async (current) => {
              const owned = host.current;
              if (!owned) throw new Error("No native host");
              const pasted = invitation;
              setInvitation("");
              await pairServer(owned.ports, pasted, "Cove Native", store);
              if (!current()) return;
              setStatus("配对已安全保存；重新连接后验证服务");
            })
          }
        />
        <Button
          title="忘记 Cove 服务"
          disabled={busy || loading}
          onPress={() =>
            action(async (current) => {
              await store.remove();
              if (!current()) return;
              selected.current = null;
              stopHost();
              setStatus("已忘记本机配对；未登出 Tailnet 或撤销远端设备");
            })
          }
        />
        <Button
          title="验证 RPC"
          disabled={busy || loading || !connected}
          onPress={() =>
            action(async (current) => {
              if (!connected) throw new Error("No verified client");
              const result = await connected.call("repo.list", { limit: 1 });
              if (!result.ok) throw new Error("RPC failed");
              if (!current()) return;
              setStatus("RPC 已通过当前已验证入口应答");
            })
          }
        />
      </View>
      <TextInput
        accessibilityLabel="terminal-tab-id"
        value={tabID}
        onChangeText={setTabID}
        placeholder="隔离测试 tab ID"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={128}
      />
      <Button
        title="打开已有终端"
        disabled={busy || loading || !connected}
        onPress={() =>
          action(async (current) => {
            if (!connected) throw new Error("No verified client");
            const result = await connected.call("tab.get", { tabId: tabID });
            if (!result.ok || result.value.latestRun?.verification !== "live")
              throw new Error("Run is not live");
            if (!current()) return;
            selected.current = { tabID, run: result.value.latestRun.run };
            setRun(result.value.latestRun.run);
          })
        }
      />
      {connected && run && (
        <TerminalHost key={`${run.runId}:${run.relayInstanceId}`} client={connected} run={run} />
      )}
    </SafeAreaView>
  );
}
