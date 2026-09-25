import { createRequire } from "node:module";

interface ProbeSerializeAddon {
  activate(terminal: unknown): void;
  dispose(): void;
  serialize(): string;
}

type ProbeAddonConstructor = new () => ProbeSerializeAddon;

export function loadSerializeAddon(): ProbeSerializeAddon {
  // Published serializer declarations import browser xterm types; keep that type leak out of Node.
  const imported: unknown = createRequire(import.meta.url)("@xterm/addon-serialize");
  if (typeof imported !== "object" || imported === null || !("SerializeAddon" in imported)) {
    throw new Error("Serializer module has no public SerializeAddon export");
  }
  const candidate = imported.SerializeAddon;
  if (typeof candidate !== "function") throw new Error("SerializeAddon export is not callable");
  const addon = new (candidate as ProbeAddonConstructor)();
  if (
    typeof addon.activate !== "function" ||
    typeof addon.serialize !== "function" ||
    typeof addon.dispose !== "function"
  ) {
    throw new Error("SerializeAddon public methods are unavailable");
  }
  return addon;
}
