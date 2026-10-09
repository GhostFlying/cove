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

- Write a short implementation plan before coding: objective, writable files,
  dependencies, validation and exclusions. Keep it in the Issue or PR description;
  do not add per-task plan/result files under `docs/tasks`.
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
  rationale; Issues/PRs retain plans, dependencies and acceptance; handoffs retain
  exact state and next actions. Start by reading `docs/handoff.md` and the
  applicable design documents instead of relying on conversation history. Update the
  handoff at ownership changes, blockers, integration and milestone review. Keep
  `docs/handoff.md` current-state only and at most 150 lines; link history in
  Issues/PRs, Git and controlled evidence rather than appending checkpoint dumps.

## Coordinate concurrent agents

- The coordinator may implement critical-path work directly; it is not limited
  to dispatching. Use helper agents only for genuinely independent work, with
  disjoint files. Plans are short and live in the PR or Issue, not in separate
  per-task plan/result documents.
- Each PR gets one full independent review from an agent that did not write it:
  codex `gpt-6.1-sol` xhigh by default. Local TraeX `gpt-5.6-sol` xhigh is a
  fallback when codex is unavailable, or an optional second reviewer for
  high-risk protocol/recovery changes. Reviewers report all findings in one
  batch; fixes get a single delta re-review.
- Route local TraeX through `warmpool run -- traex ...` with explicit
  `gpt-5.6-sol` and xhigh reasoning effort. Do not use the delegation plugin.
  Warm hits are an optimization: dispatch through warmpool even when warm=0.
  Do not modify/restart shared pool services. Use `ssh devbox` for Linux work.
- Start every review or helper task in a fresh session; do not reuse long-lived
  owner sessions across tasks.
- Record decisions, blockers and verification results in GitHub Issues/PRs.
  The PR and its CI run are the evidence; do not maintain separate sealed
  evidence directories for reproducible checks.
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
- The coordinator may merge without per-PR user confirmation after all required
  CI checks succeed and an independent review has no open findings.
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

- Apply Conventional Commits to future changes. Record existing nonconforming
  history as a deviation; do not rewrite retained commits for cosmetic repair or
  make that repair a new runtime acceptance prerequisite.

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

- Follow [engineering section 6.9](docs/engineering-plan.md)
  over conflicting historical process gates. Product contracts, acceptance and
  safety boundaries, independent roles, required CI and actual-main checks remain.
- Self-check one-off off-tree local harnesses/readers, then run them on isolated
  task-owned resources without independent source prereview or per-atom seals.
  Fix tool defects and rerun without separate review loops; retain raw failures,
  UNKNOWN, missing and unexecuted results. Repository/CI tools or tests and
  acceptance-semantic changes are PR deliverables and require review.
- Read-only or task-owned isolated runtime verification has no source-prereview
  dependency. There is no first-run-success requirement. Do not blindly replay
  uncertain external commands or terminal input; establish state and safe replay.
- Push a buildable task branch and open a draft PR early; run CI alongside local
  acceptance. CI is the merge gate; checks CI cannot run (real devices,
  devbox) are listed in the PR and must pass before merge.
- Do one complete independent PR review and batch all independently evaluable
  findings. Review corrections' delta and impact in the same PR context; broaden
  review only when affected contracts or new evidence warrant it. The author
  self-tests, CI is the independent test, and the reviewer must not be the author.
- Use reproducible PR/CI/raw logs with exact revision and environment; give
  irreplaceable results special custody. Archive complete superseded evidence,
  including failures/UNKNOWN, only after active dependencies are resolved; never
  keep success-only history or move active absolute-path dependencies. Do not
  publish sensitive raw private logs.
- Notify the user with cause, impact, options and a recommendation after three
  unresolved correction rounds on one gate, 24 hours without substantive active
  task source/PR/test progress, 48 hours without a main merge while work is ready,
  or recovery from automation interruption longer than two hours. Track alerts
  and notify again only for meaningful changes, not unchanged repeated status.
- Advance on completion/failure/dependency events; heartbeats are fallback checks.
  Use fresh implementation task/PR and independent review sessions, retaining the
  same PR context for fixes. Around 20 coordinator compactions or 48 hours signals
  a controlled handoff/restart with one coordinator and preserved active command
  and resource ownership; it never establishes that an old process exited.

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
