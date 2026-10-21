import { isAbsolute, normalize, basename } from "node:path";
import { PortSchema, SshTargetSchema } from "@cove/protocol/auth";

export type ServiceManagerName = "systemd-user" | "launchd-agent";

export type M0LocalOptions = {
  mode: "m0-local";
  host: "127.0.0.1" | "::1";
  // The business port; 0 binds a free one.
  port: number;
  // Set when the executable was started without --port (m2 D3): the business port is then the
  // stored entry configuration's businessPort when one is configured, else `port` (0). An explicit
  // --port, 0 included, overrides the stored port; tests and `--port` users rely on that.
  portFromEntryConfig?: true;
  rendezvousPath: string;
  allowedOrigins: readonly string[];
  // Cove data directory (M1 D5). Without it the application runs without a store (unit tests);
  // the executable always resolves one (`--home`, COVE_HOME or ~/.cove).
  home?: string;
  // Startup overrides of the stored entry configuration (entry.get / entry.set, m2 T3), for
  // development and tests; an installed service passes neither:
  // - pairingPort: the loopback port of the pairing listener. Absent: the stored pairingPort, else
  //   the port the open invitations advertise, else any free port (auth/service.ts).
  // - sshTarget: the `[user@]host` invitations advertise for the SSH entry. Absent: the stored
  //   sshTarget, else none, and then no invitation can be created (ENTRY_UNAVAILABLE).
  pairingPort?: number;
  sshTarget?: string;
  // The service manager that started this server (`--service`, written into the service unit by
  // `cove server install`); absent for a foreground `cove server start`. It decides the manager
  // and start reason server.status reports (entry/service-state.ts).
  service?: ServiceManagerName;
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
    (input.portFromEntryConfig !== undefined && input.portFromEntryConfig !== true) ||
    (input.service !== undefined && !["systemd-user", "launchd-agent"].includes(input.service)) ||
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
        "--service",
      ].includes(key) ||
      (key !== "--origin" && values.has(key))
    )
      throw new Error("Invalid local entry arguments");
    if (key === "--origin") origins.push(value);
    else values.set(key, value);
  }
  // Without --port the stored business port applies (portFromEntryConfig), and a free one when
  // none is stored.
  const port = values.get("--port");
  if (port !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(port))
    throw new Error("Invalid local entry arguments");
  const pairingPort = values.get("--pairing-port");
  if (pairingPort !== undefined && !/^[1-9][0-9]{0,4}$/.test(pairingPort))
    throw new Error("Invalid local entry arguments");
  return validateLocalOptions({
    mode: values.get("--mode") as "m0-local",
    host: values.get("--host") as M0LocalOptions["host"],
    port: port === undefined ? 0 : Number(port),
    ...(port === undefined ? { portFromEntryConfig: true as const } : {}),
    rendezvousPath: values.get("--rendezvous") ?? "",
    allowedOrigins: origins,
    ...(values.has("--home") ? { home: values.get("--home")! } : {}),
    ...(pairingPort !== undefined ? { pairingPort: Number(pairingPort) } : {}),
    ...(values.has("--ssh-target") ? { sshTarget: values.get("--ssh-target")! } : {}),
    ...(values.has("--service") ? { service: values.get("--service") as ServiceManagerName } : {}),
  });
}

export function localAuthority(host: M0LocalOptions["host"], port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid bound port");
  return `${host === "::1" ? "[::1]" : host}:${port}`;
}
