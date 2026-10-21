import { isAbsolute, normalize, basename } from "node:path";
import { PortSchema, SshTargetSchema } from "@cove/protocol/auth";

export type M0LocalOptions = {
  mode: "m0-local";
  host: "127.0.0.1" | "::1";
  port: number;
  rendezvousPath: string;
  allowedOrigins: readonly string[];
  // Cove data directory (M1 D5). Without it the application runs without a store (unit tests);
  // the executable always resolves one (`--home`, COVE_HOME or ~/.cove).
  home?: string;
  // Device pairing (m2 T1). These are startup flags until T3's entry configuration (entry.get /
  // entry.set) replaces them:
  // - pairingPort: the loopback port of the pairing listener. Absent: the port the open
  //   invitations advertise, or any free port when there is none (auth/service.ts).
  // - sshTarget: the `[user@]host` invitations advertise for the SSH entry. Absent: derived from
  //   the OS user and host name when that is a valid target (entry/main.ts).
  pairingPort?: number;
  sshTarget?: string;
};

export function validateLocalOptions(input: M0LocalOptions): M0LocalOptions {
  if (
    input.mode !== "m0-local" ||
    !["127.0.0.1", "::1"].includes(input.host) ||
    !Number.isSafeInteger(input.port) ||
    input.port < 0 ||
    input.port > 65535 ||
    !isAbsolute(input.rendezvousPath) ||
    normalize(input.rendezvousPath) !== input.rendezvousPath ||
    !basename(input.rendezvousPath) ||
    input.rendezvousPath.endsWith("/") ||
    (input.home !== undefined &&
      (!isAbsolute(input.home) ||
        normalize(input.home) !== input.home ||
        (input.home.length > 1 && input.home.endsWith("/")))) ||
    (input.pairingPort !== undefined &&
      (!PortSchema.safeParse(input.pairingPort).success || input.pairingPort === input.port)) ||
    (input.sshTarget !== undefined && !SshTargetSchema.safeParse(input.sshTarget).success) ||
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
      ![
        "--mode",
        "--host",
        "--port",
        "--rendezvous",
        "--origin",
        "--home",
        "--pairing-port",
        "--ssh-target",
      ].includes(key) ||
      (key !== "--origin" && values.has(key))
    )
      throw new Error("Invalid local entry arguments");
    if (key === "--origin") origins.push(value);
    else values.set(key, value);
  }
  const port = values.get("--port");
  if (!port || !/^(0|[1-9][0-9]{0,4})$/.test(port)) throw new Error("Explicit local port required");
  const pairingPort = values.get("--pairing-port");
  if (pairingPort !== undefined && !/^[1-9][0-9]{0,4}$/.test(pairingPort))
    throw new Error("Invalid local entry arguments");
  return validateLocalOptions({
    mode: values.get("--mode") as "m0-local",
    host: values.get("--host") as M0LocalOptions["host"],
    port: Number(port),
    rendezvousPath: values.get("--rendezvous") ?? "",
    allowedOrigins: origins,
    ...(values.has("--home") ? { home: values.get("--home")! } : {}),
    ...(pairingPort !== undefined ? { pairingPort: Number(pairingPort) } : {}),
    ...(values.has("--ssh-target") ? { sshTarget: values.get("--ssh-target")! } : {}),
  });
}

export function localAuthority(host: M0LocalOptions["host"], port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid bound port");
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}
