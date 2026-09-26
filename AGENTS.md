# Cove contributor instructions

This is the repository-owned source for Cove-specific agent instructions. Follow
applicable user/global instructions as well. Do not copy or edit generated global
agent files to change Cove rules.

## Read the relevant decisions

- [Product and scope](docs/design.md)
- [Server architecture](docs/server-architecture.md)
- [Protocol and compatibility](docs/relay-protocol.md)
- [Terminal architecture](docs/terminal-architecture.md)
- [Engineering and multi-agent workflow](docs/engineering-plan.md)

Distinguish accepted decisions from proposals and unverified implementations.
The coordination rules in engineering section 6 and the monorepo, pnpm workspace,
and build/test choices in sections 8–9 are confirmed; other proposals are not automatically selected. Do not reopen accepted
decisions without concrete evidence or a user request.

## Plan and scope work

- Write an implementation plan before coding. Record the task owner, objective,
  base revision, checkout path, writable files, contract dependencies, validation
  and exclusions. Use a task-specific file rather than a shared append-only plan.
- Work in the assigned checkout. Read local changes before editing; never use a
  similarly named checkout or another agent's absolute path as your own workspace.
- Keep changes within the task. Coordinate an expanded file scope with the task
  coordinator; ordinary implementation choices do not require repeated user approval.
- Do not scaffold deferred features or introduce a generic framework solely for
  potential future use. Add packages only for real dependency or deployment boundaries.
- During planning and decision analysis, inspect the relevant Orca implementation
  where a counterpart exists. Record the source revision, paths and behavior,
  then evaluate strengths, defects and fit against Cove's accepted design. Orca
  is comparative evidence, not authority; do not copy it without justification.
- Treat this as long-running work: design documents retain accepted decisions and
  rationale; task plans retain dependencies and acceptance; handoffs retain exact
  state and next actions. Start by reading `docs/handoff.md` and the applicable
  design/task documents instead of relying on conversation history. Update the
  handoff at ownership changes, blockers, integration and milestone review.

## Coordinate concurrent agents

- The coordinator schedules against a reviewed milestone dependency graph and
  tracks ownership, dependencies and gates only; delegate
  documentation, integration, GitHub operations and conflict resolution to an
  explicitly assigned non-plan owner. GPT-6 Astra high writes plans only.
  For interactive non-plan work, allocate native GPT-6 Sol high or GPT-6 Luna
  max by difficulty; native review uses a separate GPT-6 Sol high. Prefer local
  TraeX GPT-5.6 Sol xhigh for self-contained non-plan work, including review.
  Implementation, testing and review authors must remain independent.
- Route local TraeX through `warmpool run -- traex ...` with explicit
  `gpt-5.6-sol` and xhigh reasoning effort.
  Do not use the delegation plugin. Warm hits are an optimization, not an
  admission requirement: dispatch through warmpool even when warm=0 or no warm
  session is selected; execution may queue briefly or start immediately. Record
  routing and actual warm hits separately. Do not silently substitute
  models or modify/restart shared pool services. Use `ssh devbox` for Linux work.
- Limit active task agents and task worktrees to five each, including external
  CLI/remote workers and test/review checkouts; obey lower runtime limits too.
  Assign primary-checkout writes to one owner. Count nested dispatch centrally;
  an agent may not start more workers without a coordinator allocation.
- Record plans, dependency changes, conflicts, decisions and handoffs in task
  documents and GitHub Issues/PRs. Record roles, models, effort, task identities,
  dependency versions, PR head/base, verification evidence and blockers.
- Escalate product/architecture/scope/acceptance decisions through the coordinator
  to the user with options and impact. Continue unrelated ready tasks. Milestone
  entry and transitions require explicit user review and permission; completing
  one milestone never authorizes starting the next.
- Parallel write tasks should have separate branches/worktrees and explicit file
  ownership. This rule does not require creating a worktree for a read-only or
  standalone task. Same-directory collaboration requires disjoint write scopes.
- Designate one writer per shared contract, root configuration, lockfile, database
  migration ordering, common registration/export entry point, and root AGENTS.md
  change. Agree on contract changes before consumers implement incompatible variants.
- Do not treat a task-plan file as an atomic lock. Resolve overlapping ownership
  through the coordinator; a stale plan is not permission to overwrite another task.
- Never revert, clean, reset, stash or overwrite other contributors' work to make
  your task pass. Inspect unexpected changes and preserve them.
- Stage only your owned changes. Do not commit another task's unfinished work or
  rewrite its commits. Follow the user's Git identity; do not add agent co-authors.
- Hand off the exact revision/change set, interface changes, checks actually run,
  results and remaining limitations. A task must not require another checkout's
  uncommitted files to build or pass.
- Verify the integrated result after combining dependent changes; passing each
  branch separately is not evidence that the combined version works.

## Commit and integrate changes

- Use atomic Conventional Commits: one coherent change per commit, independently
  understandable and reversible, with necessary tests/docs included. Keep each
  intermediate commit buildable; do not bundle unrelated edits or split by file
  when doing so creates broken intermediate states. Do not rely on later squash.
- Commit subjects and optional detailed bodies explain what changed and why,
  including durable constraints and tradeoffs. Put execution-specific test runs,
  timings and pass/fail reports in PR/task evidence, not commit messages.
- Use `p/luchengxuan/<milestone>-<issue>-<topic>` branches. Main is protected and
  linear: only GitHub rebase & merge, never squash, merge commits, direct pushes,
  force pushes or deletion. The empty-repository bootstrap is already complete.
- An assigned integration owner may merge without per-PR user confirmation after
  independent testing, independent review and all required CI checks succeed.
  Missing, skipped, cancelled or pending evidence does not satisfy this gate.
  This authority does not grant deployments, releases or milestone transitions.
- Review findings go back to the implementer. If a reviewer implements a fix,
  assign a new independent reviewer. Conflict-resolution changes need new
  verification/review; never carry forward stale conclusions after code changes.
- Check head/base and evidence immediately before merging, merge serially, and
  record the original-to-rebased commit mapping. Reassess evidence when the base
  changes and check final main CI before releasing dependent work.
- An agent review using the PR author's GitHub identity is not a second account's
  GitHub approval. Record the independent report with its SHA; do not fabricate
  approvals or bypass repository protection to simulate them.

## Explain non-obvious code

- Add necessary comments explaining why an approach is used, including invariants,
  compatibility constraints and surprising edge cases. Keep them accurate as the
  code changes rather than narrating each obvious statement.
- Explain complex state machines, ordering/concurrency, recovery and failure
  handling in enough detail to make the reasoning reviewable. Link deeper design
  documents where useful, while retaining essential invariants beside the code.

## Install and check workspace packages

- Use pnpm workspace and workspace:* for internal package dependencies. Keep one
  application lockfile; retain existing isolated benchmark lockfiles as evidence.
  Do not add Turborepo/Nx to the initial setup without revisiting that decision.
- Use frozen installs for routine development and CI. Dependency changes belong
  to the designated writer, including manifest and lockfile updates. Use the
  exact Node/pnpm versions in `.node-version` and `package.json`; update pins together.
- Each worktree owns its node_modules, build outputs, test state and development
  ports. Reusing pnpm's package store is fine; linking worktrees to the same mutable
  installation or build directory is not.
- Start with package-scoped checks and include affected consumers for contract
  changes. Coordinate expensive native builds, integration tests and benchmarks.
- Keep server native artifacts separate from Electron/mobile artifacts and target
  the actual Node ABI, OS and architecture. Do not mutate another task's install
  during a native rebuild.
- Build server/CLI/worker and pure TypeScript packages with tsc and Project
  References. Consume internal packages through exports and built artifacts;
  do not bypass package boundaries with cross-package src imports or aliases.
- Use one owner for overlapping build/watch outputs in a worktree. Separate
  worktrees must not share dist or tsbuildinfo files.
- Use electron-vite for Electron, Vite for the terminal WebView entry, Metro for
  RN and the Go toolchain for tsnet. RN/Expo and release packaging remain open.
- Use Vitest for core logic and server/worker integration. Include tests that
  launch compiled artifacts; a source-only test run does not validate delivery.
  Use Playwright for browser/Electron checks and validate its Electron support
  against the chosen version. RN component/device test tooling remains separate.

- Run `pnpm check` for root tooling changes. Oxlint handles lint rules, Prettier
  handles formatting, and TypeScript handles type checking. Preserve benchmark
  evidence from automatic formatting and keep application tests separate from
  the tooling integration project. See [development setup](docs/development.md).

## Preserve architecture

- The execution server owns Git/filesystem/PTY facts. Loss of contact is not proof
  that a process exited. Do not silently repeat uncertain commands or terminal input.
- CLI is a first-class operator. Every new server capability and setting must have
  a CLI path using the same domain operation as clients. Bootstrap/service setup
  is an explicit local boundary, not a bypass for ordinary business writes.
- Client/protocol code must not import server native dependencies. Desktop UI and
  mobile are clients of the standalone server, not its required process host.
- Each PTY has one authoritative server terminal model in its worker. Runtime
  caches snapshots, not a second complete headless model. Runtime/worker use the
  unified pipe protocol; preserve per-run ordering and bounded queues.
- The server model alone answers terminal queries. Client live parsing and replay
  must not write automatic replies back to the PTY or discard genuine user input.
- Wire data remains VT plus explicit metadata. Do not expose an engine's private
  state as the protocol. Preserve the accepted recovery, resize and history limits.
- Protocol version is independent of application release. Validate compatible
  mixed versions and explicit mismatch behavior; do not silently replace a live server.
- No first-release PTY keeper, terminal snapshot/scrollback persistence, scheduler,
  chat, Web App, Shepherd integration or agent-final-status hook implementation.
  Do not use those deferred features as prerequisites for the initial workflows.

## Validate and report

- Run checks appropriate to the change, including affected contracts and error
  boundaries. Do not add tests that merely restate a trivial implementation.
- Test irreversible/external operations in isolated repositories, databases and
  task-owned processes. Do not disrupt an existing service or active user terminal
  to validate a change. Clean up only resources created by the current task.
- Record the revision, OS/architecture, workload and measurements for remote or
  performance checks. Parser probes and emulator results do not establish real
  agent throughput or mobile hardware performance.
- Preserve errors and uncertainty in public operation results. Never substitute
  cached state for proof of current liveness or claim a requested test was executed.
- Do not log credentials or real terminal contents by default. Keep test fixtures
  reproducible and free of private session data.
- Update affected design/usage documentation with behavior changes. Report what
  changed, what was checked and what remains unverified.

Add nested AGENTS.md files only for real domain-specific constraints. Keep task
assignments out of this file. Convert enforceable rules into CI checks as tooling
is selected; documentation alone is not an enforcement mechanism.
