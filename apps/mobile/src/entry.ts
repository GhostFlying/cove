import { ConnectionError } from "./action-error.js";
import type { HttpPort, TransferDisposition } from "@cove/client";
import {
  BOOTSTRAP_VERSION,
  BootstrapIdentitySchema,
  BootstrapFailureSchema,
  type BootstrapFailure,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type BootstrapIdentity,
} from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { utf8 } from "./codec.js";

export const MOBILE_BUILD_VERSION = "0.0.0+mobile-native";

export function bootstrapRequest() {
  return {
    type: "cove-bootstrap",
    bootstrapVersion: BOOTSTRAP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: MOBILE_BUILD_VERSION,
    capabilities: [...REQUIRED_CAPABILITIES],
    profiles: [PROFILE],
    encodings: [BASELINE_ENCODING],
  };
}

export class NativeRequestFailure extends Error {
  constructor(
    readonly disposition: TransferDisposition,
    readonly bootstrapKind?: BootstrapFailure["kind"],
  ) {
    super("Native request failed; an uncertain operation must not be replayed");
  }
}

export function postJSON(
  http: HttpPort,
  path: string,
  value: unknown,
  maximum: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle: ReturnType<HttpPort["post"]> | undefined;
    let invoked = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new NativeRequestFailure(handle?.cancel() ?? "unknown"));
    }, 10_000);
    const fail = (disposition: TransferDisposition) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NativeRequestFailure(disposition));
    };
    try {
      const request = {
        path,
        headers: { "Content-Type": "application/json" },
        body: utf8.encode(JSON.stringify(value)),
        maxResponseBytes: maximum,
      };
      invoked = true;
      handle = http.post(request, {
        onDisposition: () => {},
        onFailure: ({ disposition }) => fail(disposition),
        onResponse: (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            const value: unknown = JSON.parse(utf8.decodeFatal(response.body));
            if (response.status !== 200) {
              const failure = BootstrapFailureSchema.safeParse(value);
              reject(
                new NativeRequestFailure(
                  "handed-off",
                  failure.success ? failure.data.kind : undefined,
                ),
              );
              return;
            }
            resolve(value);
          } catch {
            reject(new NativeRequestFailure("handed-off"));
          }
        },
      });
    } catch {
      fail(invoked ? "unknown" : "not-sent");
    }
  });
}

// The Go entry already checked the connection's stable peer. This separate
// identity step prevents credentials reaching a different Cove installation on
// that peer, and discovers the new instance binding after a server restart.
export async function verifyServer(
  http: HttpPort,
  expectedServerId: string,
): Promise<BootstrapIdentity> {
  let response: unknown;
  try {
    response = await postJSON(http, "/bootstrap", bootstrapRequest(), 8192);
  } catch (error) {
    const kind = error instanceof NativeRequestFailure ? error.bootstrapKind : undefined;
    if (
      kind === "PROTOCOL_MISMATCH" ||
      kind === "BOOTSTRAP_UNSUPPORTED" ||
      kind === "PROFILE_UNSUPPORTED" ||
      kind === "CAPABILITY_UNAVAILABLE"
    )
      throw new ConnectionError(
        { stage: "protocol", category: "protocol-mismatch" },
        error instanceof NativeRequestFailure ? error.disposition : "unknown",
      );
    throw new ConnectionError(
      { stage: "entry", category: "peer-transport-unverified" },
      error instanceof NativeRequestFailure ? error.disposition : "unknown",
    );
  }
  const identity = BootstrapIdentitySchema.safeParse(response);
  if (!identity.success)
    throw new ConnectionError({ stage: "identity", category: "invalid-response" });
  if (identity.data.serverId !== expectedServerId)
    throw new ConnectionError({ stage: "identity", category: "server-mismatch" });
  if (identity.data.protocolVersion !== PROTOCOL_VERSION)
    throw new ConnectionError({ stage: "protocol", category: "protocol-mismatch" });
  return identity.data;
}
