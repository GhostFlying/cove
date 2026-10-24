import { requireNativeModule } from "expo-modules-core";
import type { NativeDriver } from "../../src/native-ports";

interface CoveTsnetModule {
  open(hostname: string, controlURL: string): Promise<{ generation: number; status: string }>;
  status(generation: number): Promise<string>;
  login(generation: number, authKey: string): Promise<string>;
  logout(generation: number): Promise<string>;
  close(generation: number): Promise<void>;
  openEntry(generation: number, peerID: string, port: number): number;
  closeEntry(generation: number, entry: number): void;
  post(
    generation: number,
    entry: number,
    id: number,
    path: string,
    headers: string,
    body: string,
    limit: number,
  ): boolean;
  openSocket(generation: number, entry: number, id: number, path: string): boolean;
  send(
    generation: number,
    id: number,
    binary: boolean,
    body: string,
  ): ReturnType<NativeDriver["send"]>;
  cancel(generation: number, id: number): ReturnType<NativeDriver["cancel"]>;
  release(generation: number, id: number): void;
  nextEvent(generation: number, timeoutMilliseconds: number): Promise<string>;
  stop(generation: number): void;
}

const native = requireNativeModule<CoveTsnetModule>("CoveTsnet");

export async function openNativeNode(hostname: string, controlURL = "") {
  const opened = await native.open(hostname, controlURL);
  const generation = opened.generation;
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid native generation");
  // Every call, including a delayed async pull, is bound to this incarnation.
  // Old JS completions cannot close/cancel a newer foreground node.
  const driver: NativeDriver = {
    openEntry: (peerID, port) => native.openEntry(generation, peerID, port),
    closeEntry: (entry) => native.closeEntry(generation, entry),
    post: (...args) => native.post(generation, ...args),
    openSocket: (...args) => native.openSocket(generation, ...args),
    send: (...args) => native.send(generation, ...args),
    cancel: (id) => native.cancel(generation, id),
    release: (id) => native.release(generation, id),
    nextEvent: (timeout) => native.nextEvent(generation, timeout),
    stop: () => native.stop(generation),
  };
  return {
    status: opened.status,
    driver,
    refresh: () => native.status(generation),
    login: (key: string) => native.login(generation, key),
    logout: () => native.logout(generation),
    close: () => native.close(generation),
  };
}
