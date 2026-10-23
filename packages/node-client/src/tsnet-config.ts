import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

// The client's tsnet settings (m2 D14): `<home>/client/tsnet.json`, 0600 in 0700 directories,
// replaced atomically. It holds the dial daemon's idle timeout (default 10 minutes), which a
// daemon reads when it starts: a change applies from the next start, never to a running daemon.

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;

export type TsnetConfig = { readonly idleTimeoutSeconds: number };

function configPath(home: string): string {
  return join(home, "client", "tsnet.json");
}

function valid(seconds: unknown): seconds is number {
  return (
    Number.isSafeInteger(seconds) &&
    (seconds as number) >= 1 &&
    (seconds as number) <= MAX_IDLE_TIMEOUT_SECONDS
  );
}

// A duration as `--idle-timeout` takes it: whole seconds, minutes or hours (`90s`, `10m`, `2h`).
export function parseIdleTimeout(text: string): number | null {
  const match = /^([1-9][0-9]{0,5})([smh])$/.exec(text);
  if (!match) return null;
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"];
  return valid(seconds) ? seconds : null;
}

// The settings, with defaults for what is not set. An unreadable or invalid file is an error
// naming it, never silently replaced by defaults.
export async function readTsnetConfig(home: string): Promise<TsnetConfig> {
  const path = configPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS };
    throw error;
  }
  let value: Record<string, unknown> | null;
  try {
    value = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    value = null;
  }
  const seconds = value?.idleTimeoutSeconds;
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    Object.keys(value).sort().join() !== "idleTimeoutSeconds,version" ||
    !valid(seconds)
  )
    throw new Error(`the client tsnet settings file ${path} is invalid`);
  return { idleTimeoutSeconds: seconds };
}

async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`${path} is not a directory owned by this user`);
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

export async function writeTsnetConfig(home: string, config: TsnetConfig): Promise<void> {
  if (!valid(config.idleTimeoutSeconds)) throw new Error("invalid idle timeout");
  // A caller-selected parent is not Cove-owned merely because it contains our client subtree.
  // Request a private creation mode, without inspecting or chmodding an existing parent.
  await mkdir(home, { recursive: true, mode: 0o700 });
  await ownerOnlyDirectory(join(home, "client"));
  const path = configPath(home);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ version: 1, idleTimeoutSeconds: config.idleTimeoutSeconds }, null, 2)}\n`,
    );
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
