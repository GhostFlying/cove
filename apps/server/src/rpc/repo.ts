import { RepoService } from "../domain/repos.js";
import { capabilityUnavailable, type LocalCore, type RpcHandler } from "./context.js";

// Repo domain module (repo.register, repo.list, repo.get, repo.update, repo.remove; M1 T2). The
// service is built from the composition's store and receipts once per core, so registering the
// domain needs no change to the shared context or the server entry. A composition without a
// store (unit tests) reports CAPABILITY_UNAVAILABLE for every repo method.
const services = new WeakMap<LocalCore, RepoService>();
const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

function service(core: LocalCore): RepoService | null {
  if (!core.store || !core.receipts) return null;
  let found = services.get(core);
  if (!found) {
    found = new RepoService({
      store: core.store,
      receipts: core.receipts,
      serverId: core.runtime.composition.serverId,
      encodeUtf8,
    });
    services.set(core, found);
  }
  return found;
}

export const handle: RpcHandler<"repo"> = (core, { method, params, principalId }) => {
  const repos = service(core);
  if (!repos) return capabilityUnavailable();
  switch (method) {
    case "repo.register":
      return repos.register(principalId, params as Parameters<RepoService["register"]>[1]);
    case "repo.list":
      return repos.list(params as Parameters<RepoService["list"]>[0]);
    case "repo.get":
      return repos.get(params.repoId as string);
    case "repo.update":
      return repos.update(principalId, params as Parameters<RepoService["update"]>[1]);
    case "repo.remove":
      return repos.remove(principalId, params as Parameters<RepoService["remove"]>[1]);
  }
};
