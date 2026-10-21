import { parseCredential } from "@cove/protocol/bootstrap";
import type { ClientCredentials, CredentialSupplier } from "./transport-ports.js";

// Injected credential provider (m2 T0). The host of a client (the CLI, later Desktop and
// Mobile) owns where a credential lives: the local owner secret in the server's rendezvous file,
// a device token in the CLI's 0600 credential file or a system keychain. The client never stores
// one; it asks the provider again for every connection attempt and every RPC, so a rotated token
// is used from the next request on, and a provider that cannot answer (or answers with something
// malformed) fails that request locally before anything is sent.
//
// `serverId` is the server the client is bound to, which a provider keeping several servers'
// tokens looks the credential up by. Checking that the channel really reaches that server before
// a token is released is the entry's job (pre-auth identity, m2 T1/T2), not the provider's.
export type ClientCredential =
  | { readonly kind: "local-secret"; readonly secret: string }
  | { readonly kind: "device-token"; readonly token: string };
export interface CredentialRequest {
  readonly serverId: string;
}
export type CredentialProvider = (
  request: CredentialRequest,
) => ClientCredential | Promise<ClientCredential>;

// The wire form of a credential: the same string as `Authorization: Bearer <credential>` and as
// the terminal WebSocket's first-frame secret (protocol bootstrap.ts). Null when the value is not
// a well-formed credential of the kind it claims to be.
export function credentialHeaders(credential: ClientCredential): ClientCredentials | null {
  const value =
    credential?.kind === "local-secret"
      ? credential.secret
      : credential?.kind === "device-token"
        ? credential.token
        : undefined;
  const parsed = parseCredential(value);
  if (!parsed || parsed.kind !== credential.kind) return null;
  return Object.freeze({ authorization: `Bearer ${value}`, terminalSecret: value! });
}

// Adapts a provider to the client's `credentials` option. A malformed credential rejects, which
// the client reports as a local `credential` error; the value is never part of that error.
export function credentialSupplier(
  provider: CredentialProvider,
  serverId: string,
): CredentialSupplier {
  const request: CredentialRequest = Object.freeze({ serverId });
  return async () => {
    const headers = credentialHeaders(await provider(request));
    if (!headers) throw new Error("The credential provider returned a malformed credential");
    return headers;
  };
}
