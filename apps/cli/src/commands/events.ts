import { LOCAL_PATHS } from "@cove/protocol/bootstrap";
import {
  BUSINESS_LIMITS,
  BusinessCursorSchema,
  BusinessKindSchema,
  normalizedBusinessKinds,
  type BusinessCursor,
  type BusinessFrame,
  type BusinessKind,
} from "@cove/protocol/business-events";
import { cliBuildVersion } from "../session.js";
import { flag, flagValues, takeFlags, UsageError, withSession, type Arguments } from "./_common.js";
import { readBusinessEvents } from "./_events.js";

export const standalone = true;
export const usage = `  events --json [--since CURSOR_JSON] [--kind KIND]...
    Snapshot pages and live business changes as NDJSON; --since resumes the same kind filter.
    Kinds: repo, task, tab, run, operation, config, runtime. Default: all, including archived tasks.
    Reset is printed and exits 3; reconnect without --since for a new complete snapshot.
    Disconnect/error exits 1; no automatic reconnect or mutation replay. Ctrl-C stops the stream.`;

function sinceFlag(args: Arguments): BusinessCursor | undefined {
  const text = flag(args, "--since");
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError("--since needs a complete business cursor JSON object");
  }
  const parsed = BusinessCursorSchema.safeParse(value);
  if (!parsed.success) throw new UsageError("--since needs a complete business cursor JSON object");
  return parsed.data;
}

export async function run(args: Arguments): Promise<number> {
  takeFlags(args, ["--json", "--since", "--kind"], ["--kind"]);
  if (args.words.length !== 1 || args.command || !args.flags.has("--json"))
    throw new UsageError("events needs --json and takes no positional arguments");
  const since = sinceFlag(args);
  const selected: BusinessKind[] = [];
  for (const kind of flagValues(args, "--kind")) {
    const parsed = BusinessKindSchema.safeParse(kind);
    if (!parsed.success)
      throw new UsageError("--kind is repo, task, tab, run, operation, config or runtime");
    selected.push(parsed.data);
  }
  const filter = selected.length ? { kinds: normalizedBusinessKinds({ kinds: selected }) } : {};
  return withSession(args, async (session) => {
    const abort = new AbortController();
    let stopped: number | undefined;
    const stop = (code: number) => {
      stopped ??= code;
      abort.abort();
      // A cancelled CLI must not wait forever for a pipe consumer that stopped reading. The
      // stream has no mutation to finish; an incomplete NDJSON snapshot is explicitly unusable.
      if (!process.stdout.isTTY) process.stdout.destroy();
    };
    const interrupt = () => stop(130);
    const terminate = () => stop(143);
    const outputError = () => stop(1);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    process.stdout.on("error", outputError);
    const frame = (value: BusinessFrame) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          done(new Error("Business event output timed out"));
          stop(1);
        }, BUSINESS_LIMITS.progressTimeoutMs);
        const done = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(new Error("Business event output unavailable"));
          else resolve();
        };
        try {
          process.stdout.write(`${JSON.stringify(value)}\n`, done);
        } catch {
          done(new Error("Business event output unavailable"));
        }
      });
    try {
      const code = await readBusinessEvents({
        target: session.record,
        buildVersion: cliBuildVersion(),
        credentials: session.credentials,
        port: session.socketPort(LOCAL_PATHS.events),
        request: { type: "subscribe", filter, ...(since ? { since } : {}) },
        signal: abort.signal,
        frame,
      });
      return stopped ?? code;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      process.stdout.removeListener("error", outputError);
    }
  });
}
