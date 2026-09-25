# Engineering bootstrap

- Owner: primary agent for the engineering bootstrap task; sole writer of root configuration and lockfile.
- Objective: initialize reproducible pnpm/TypeScript/lint/format/test/CI configuration using current stable releases, validate, and commit.
- Base revision: beb83a9.
- Checkout: /Users/luchengxuan/WORKSPACE/cove (primary checkout).
- Writable scope: root configuration, `.github/workflows/`, `tests/tooling/`, README, AGENTS.md, engineering documentation and this plan; formatting-only normalization of existing design documents for the root formatter baseline. Includes the existing uncommitted engineering design and agent instructions from this discussion.
- Contracts: accepted engineering plan sections 8–9; preserve benchmark evidence and isolated benchmark lockfiles.
- Exclusions: application/PTY/domain implementation, empty future packages, deployments, publishing/pushing, native/mobile build claims.

## Steps

1. Verify current stable upstream releases and peer compatibility; pin only dependencies used in this bootstrap.
2. Add workspace/ESM/strict TypeScript project-reference configuration, lint/format commands and Vitest configuration.
3. Add a build integration test using temporary dependent packages to verify compiled exports, project references and rejection of invalid consumers.
4. Add macOS/Linux CI with frozen installation and matching local checks. Preserve historical benchmark files from formatting/lint churn.
5. Run installation, checks and a frozen reinstall with the selected runtime; document actual evidence and limitations, then commit owned files.

## Version findings

Registry and Node release index checked on 2026-09-25. Node 26.10.0, pnpm 12.6.0, TypeScript 7.0.2, Vitest 5.0.2, Vite 8.3.1, Prettier 3.9.9, Oxlint 1.85.0, @types/node 26.6.2.

Latest typescript-eslint 8.70.1 declares TypeScript <6.1; use independent Oxlint syntax/rule linting plus the actual TypeScript compiler for types. Latest electron-vite 5.0.0 declares Vite <=7; Electron initialization must validate its own compatible toolchain when its application exists. Do not suppress peer validation or install unused application tooling here.

## Validation

Completed locally on 2026-09-25, macOS arm64, Node 26.10.0 and pnpm 12.6.0:

- Verified official Node archive checksum and exact installed tool versions.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm clean` followed by `pnpm check`: passed (Prettier, Oxlint, TypeScript build, 2 Vitest integration tests).
- Copied versioned/candidate files into an independent temporary directory with no node_modules or build artifacts; `CI=true pnpm install --frozen-lockfile` and `pnpm check` passed. Removed the temporary directory afterward.
- Checked existing design document changes were formatting-only; benchmark files and their historical lockfile were unchanged.
- `git diff --check`: passed.

GitHub Actions pins were resolved from the latest stable release tags, including dereferencing pnpm/action-setup's annotated tag. Workflow inputs were checked against the pinned action manifests. Remote GitHub CI has not run; no push was requested.

pnpm 12 recorded exact minimum-release-age exceptions for Vite 8.3.1 and Vitest 5.0.2 dependencies during the authorized latest-release installation; these are version-specific and committed with the lockfile.

The bootstrap tests validate engineering configuration, not Cove application behavior, Linux execution, Electron/mobile rendering, or native dependency support on Node 26. Native libraries and application-specific tooling remain for their actual implementation milestones.
