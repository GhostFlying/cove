import type { HttpPort, TransferDisposition } from "@cove/client";
import {
  BOOTSTRAP_VERSION,
  BootstrapIdentitySchema,
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
  constructor(readonly disposition: TransferDisposition) {
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
            if (response.status !== 200) throw new Error("Native server refused request");
            resolve(JSON.parse(utf8.decodeFatal(response.body)));
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
  const response = await postJSON(http, "/bootstrap", bootstrapRequest(), 8192);
  const identity = BootstrapIdentitySchema.safeParse(response);
  if (
    !identity.success ||
    identity.data.serverId !== expectedServerId ||
    identity.data.protocolVersion !== PROTOCOL_VERSION
  )
    throw new Error("Cove server identity or protocol did not match; no credential was sent");
  return identity.data;
}
