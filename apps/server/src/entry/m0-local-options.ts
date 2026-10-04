import { isAbsolute } from "node:path";

export type M0LocalOptions = {
  mode: "m0-local";
  host: "127.0.0.1" | "::1";
  port: number;
  rendezvousPath: string;
  allowedOrigins: readonly string[];
};

export function validateLocalOptions(input: M0LocalOptions): M0LocalOptions {
  if (
    input.mode !== "m0-local" ||
    !["127.0.0.1", "::1"].includes(input.host) ||
    !Number.isSafeInteger(input.port) ||
    input.port < 0 ||
    input.port > 65535 ||
    !isAbsolute(input.rendezvousPath) ||
    input.allowedOrigins.length > 16 ||
    input.allowedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return !["http:", "https:"].includes(url.protocol) || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error("Invalid explicit m0-local options");
  return { ...input, allowedOrigins: Object.freeze([...input.allowedOrigins]) };
}

export function parseLocalOptions(argv: readonly string[]): M0LocalOptions {
  const values = new Map<string, string>();
  const origins: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      !key ||
      !value ||
      !["--mode", "--host", "--port", "--rendezvous", "--origin"].includes(key) ||
      (key !== "--origin" && values.has(key))
    )
      throw new Error("Invalid local entry arguments");
    if (key === "--origin") origins.push(value);
    else values.set(key, value);
  }
  const port = values.get("--port");
  if (!port || !/^(0|[1-9][0-9]{0,4})$/.test(port)) throw new Error("Explicit local port required");
  return validateLocalOptions({
    mode: values.get("--mode") as "m0-local",
    host: values.get("--host") as M0LocalOptions["host"],
    port: Number(port),
    rendezvousPath: values.get("--rendezvous") ?? "",
    allowedOrigins: origins,
  });
}

export function localAuthority(host: M0LocalOptions["host"], port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid bound port");
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}
