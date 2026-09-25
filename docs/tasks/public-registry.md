# Public registry lockfile repair

- Owner: public registry task in the assigned Cove worktree.
- Objective: make frozen installs fetch from the public npm registry on clean macOS and Linux runners while retaining the existing exact dependency graph and supply chain checks.
- Base revision: `9be4021dff2c10a059dd943dd3dac512483e15b4`.
- Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/public-registry` on `p/luchengxuan/fix-public-registry`.
- Writable files: project registry configuration (`pnpm-workspace.yaml` or `.npmrc`), root `pnpm-lock.yaml`, this plan, and only a small usage clarification in `docs/development.md` if needed.
- Contract dependencies: pnpm 12.6.0 with Node 26.10.0; preserve the two lockfile YAML documents, exact direct versions, integrity values, package and snapshot graph, strict engine/peer settings, release-age policy, frozen install, and independent benchmark lockfiles.
- Validation: inspect pnpm 12 registry precedence; compare both lockfile documents before and after; verify public metadata and tarball access; perform a clean frozen install with isolated user config, cache, store, and no preexisting `node_modules`, using committed project configuration; run `pnpm check` and ensure the lockfile remains unchanged.
- Exclusions: no dependency upgrades, policy weakening, benchmark changes, shared machine configuration changes, service deployment, merge, or GitHub settings changes.

## Implementation

pnpm 12 wrote the project registry setting to `.npmrc`; this setting takes precedence over the developer's private user registry. With the public registry active, pnpm rejected the prior lockfile's 104 private mirror tarball URLs during supply-chain verification. Rebuild the root lockfile with pnpm's `install --lockfile-only` after preserving the original for comparison. The resulting lockfile retains both YAML documents and all package keys, version selections, integrity hashes, importers, snapshots, and other package metadata; pnpm omits the 104 private tarball fields and resolves them from the project registry at install time.

For verification, use Node 26.10.0 and pnpm 12.6.0 with independent user config, cache, and store directories. Start without `node_modules`, run `CI=true pnpm install --frozen-lockfile` without a registry command-line override, then run `pnpm check`. Confirm the root lockfile is unchanged and contains no private registry URLs. The benchmark lockfiles are outside this task.
