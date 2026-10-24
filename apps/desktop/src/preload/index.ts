import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopApi } from "../shared/api.js";

const command = (name: string, ...args: unknown[]) => ipcRenderer.invoke(IPC.command, name, args);
const listen = <Args extends unknown[]>(channel: string, callback: (...args: Args) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
    callback(...(args as Args));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const api: DesktopApi = {
  snapshot: () => command("snapshot"),
  onState: (listener) => listen(IPC.state, listener),
  pair: (input) => command("pair", input),
  pairLocal: (input) => command("pairLocal", input),
  connect: (serverId, via) => command("connect", serverId, via),
  disconnect: (serverId) => command("disconnect", serverId),
  forget: (serverId) => command("forget", serverId),
  call: (serverId, method, params) => command("call", serverId, method, params),
  queryOperation: (serverId, operationId) => command("queryOperation", serverId, operationId),
  acknowledgeOperation: (serverId, operationId) =>
    command("acknowledgeOperation", serverId, operationId),
  networkStatus: () => command("networkStatus"),
  networkLogin: () => command("networkLogin"),
  openLink: (url) => command("openLink", url),
  openView: (serverId, run) => command("openView", serverId, run),
  closeView: (descriptor) => command("closeView", descriptor),
  viewMessage: (descriptor, message) => ipcRenderer.send(IPC.view, descriptor, message),
  onViewMessage: (callback) => listen(IPC.view, callback),
  onTerminalState: (callback) => listen(IPC.terminal, callback),
  onTerminalInput: (callback) => listen(IPC.input, callback),
};
contextBridge.exposeInMainWorld("cove", Object.freeze(api));
