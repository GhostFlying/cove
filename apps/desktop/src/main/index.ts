import { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { IPC, type ViewDescriptor } from "../shared/api.js";
import { DesktopHost } from "./host.js";
import { DesktopStorage } from "./storage.js";

declare const __COVE_BUILD__: string;

// An explicit development/test profile owns its own files and Keychain service. Ordinary
// startup uses Cove's stable app name; it never imports the CLI's device credential files.
const profile = process.env.COVE_DESKTOP_PROFILE;
if (profile && !/^[a-zA-Z0-9-]{1,80}$/.test(profile)) throw new Error("Invalid Desktop profile");
app.setName(profile ? `Cove-${profile}` : "Cove");
if (process.env.COVE_DESKTOP_DATA_DIR) app.setPath("userData", process.env.COVE_DESKTOP_DATA_DIR);

let host: DesktopHost | undefined;
let window: BrowserWindow | undefined;
// Electron waits for the main ESM module to finish before emitting ready. Waiting for
// ready at module scope would therefore prevent both startup and test attachment.
void app
  .whenReady()
  .then(async () => {
    if (process.platform !== "darwin")
      throw new Error(
        "Cove Desktop currently targets macOS; Linux remains an execution-server platform",
      );

    const dataDirectory = app.getPath("userData");
    const storage = new DesktopStorage(dataDirectory, {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: async (value) => (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
    });
    window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 940,
      minHeight: 640,
      title: "Cove",
      backgroundColor: "#f5f6f8",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    host = new DesktopHost(
      storage,
      process.env.COVE_HOME || join(homedir(), ".cove"),
      __COVE_BUILD__,
      (event, ...args) => {
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.send(
          event === "state"
            ? IPC.state
            : event === "view"
              ? IPC.view
              : event === "input"
                ? IPC.input
                : IPC.terminal,
          ...args,
        );
      },
    );
    const desktop = host;
    const openLink = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:")
        throw new Error("Only explicit HTTPS login links can be opened");
      await shell.openExternal(parsed.href);
      return { ok: true };
    };
    const commands: Record<string, (...args: never[]) => unknown> = {
      snapshot: () => desktop.snapshot(),
      pair: desktop.pair,
      pairLocal: desktop.pairLocal,
      connect: desktop.connect,
      disconnect: desktop.disconnect,
      forget: desktop.forget,
      call: desktop.call,
      queryOperation: desktop.queryOperation,
      acknowledgeOperation: desktop.acknowledgeOperation,
      networkStatus: desktop.networkStatus,
      networkLogin: desktop.networkLogin,
      openLink,
      openView: (serverId, run) => desktop.openView(serverId, run),
      closeView: (descriptor) => desktop.closeView(descriptor),
    };
    ipcMain.handle(IPC.command, async (event, command: string, args: unknown[]) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Unknown Desktop frame");
      if (
        !Object.hasOwn(commands, command) ||
        !Array.isArray(args) ||
        JSON.stringify(args).length > 1024 * 1024
      )
        throw new Error("Invalid Desktop command");
      return await commands[command]!(...(args as never[]));
    });
    ipcMain.on(IPC.view, (event, descriptor: ViewDescriptor, message: string) => {
      if (
        event.sender === window?.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        descriptor &&
        typeof descriptor.viewId === "string"
      )
        desktop.viewMessage(descriptor, message);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => desktop.releaseViews());
    window.webContents.on("did-start-loading", () => desktop.releaseViews());
    window.on("blur", () => desktop.setForeground(false));
    window.on("focus", () => desktop.setForeground(true));
    window.on("hide", () => {
      desktop.setWindowVisible(false);
      desktop.setForeground(false);
    });
    window.on("show", () => desktop.setWindowVisible(true));
    app.on("before-quit", () => desktop.dispose());
    app.on("window-all-closed", () => app.quit());
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "toggleDevTools" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    desktop.setWindowVisible(window.isVisible());
    desktop.setForeground(window.isFocused() && window.isVisible());
    void desktop.initialize();
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  })
  .catch((error: unknown) => {
    console.error(error);
    host?.dispose();
    app.exit(1);
  });
