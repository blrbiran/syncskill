# 2026-06-20 External Install Plan-Execute Alignment

## Goal

Bring `syncskill install <url-or-path>` onto the same plan/apply contract as `install self`, so the command surface, JSON introspection, spec, and tests all describe the same behavior.

## Why Full Alignment Instead of Narrowing the Spec

- The spec defines both `install self` and `install <url-or-path>` as two-phase `plan` / `execute` commands.
- Root CLI introspection already advertises `install` as a command with `plan_schema` and `resolutions_schema`.
- Current code only routes `install self` through `withPlanExecute()`, while external installs still execute directly.
- Keeping that split would preserve a user-visible contract mismatch for both humans and AI agents.

## Confirmed Drift

- `src/index.ts` only calls `withPlanExecute()` for the self-install branch.
- `buildInstallPlan()` and `executeInstallPlan()` currently model only `install self`.
- External installs still jump straight into `installFromSource()` and mutate config/filesystem immediately.
- Interactive skill selection for external installs currently happens inside the direct execution callback after materialization.
- Integration coverage for `--plan` / `--apply` exists for `install self`, but not for external install variants.

## Alignment Decisions

1. `install` with a target always enters the shared plan runner.
2. `install self` stays the simple install flavor, but it uses the same top-level orchestration as external install.
3. External install gets explicit planner and executor functions; the CLI should stop calling `installFromSource()` directly.
4. Public unresolved kind remains `skill-selection`; planner emits `resolve_phase: "execute"` whenever candidate discovery depends on materialization.
5. Plain local directories may resolve skill candidates during plan when cheap and deterministic; git and archive-backed installs may keep execute-phase candidate discovery.
6. `--apply` with unresolved execute-phase items must require `--resolutions`; only the direct interactive path may collect execute-time answers.
7. Existing install semantics stay intact: same-repo reconciliation, restore-from-ignore, `config.sources[*].path` contract, auto-linking, and `-y` selecting all installable non-duplicate skills.
8. If the current spec wording is narrower than the chosen execution model, update the spec in the same task rather than leaving silent drift.

## Scope

1. Route all install variants through shared plan/apply orchestration.
2. Introduce an external-install planner that produces stable actions, unresolved items, and warnings.
3. Introduce an executor that consumes plan actions instead of raw CLI input.
4. Preserve current source/install semantics while making them explicit in plan output and apply-time execution.
5. Align spec, help/introspection, and tests with the new contract.

## Non-Goals

- Do **not** redesign source ownership or same-repo merge semantics beyond what is needed to make them planner/executor-friendly.
- Do **not** change the meaning of `config.sources[*].path`.
- Do **not** add new public install flags.
- Do **not** broaden this task into `update`, `scan`, or sync-command architecture changes.
- Do **not** rewrite the entire source subsystem when a smaller extraction/refactor is enough.

## Proposed Implementation Plan

### 1. Unify the Install Command Entry Path

Targets: `src/index.ts`, `src/cli/plan-execute.ts`

- Remove the current split where only `install self` uses `withPlanExecute()`.
- Treat `install self` and `install <url-or-path>` as two flavors of the same install orchestration.
- Keep the no-argument behavior unchanged (`help` / JSON hint).
- Keep `install self` reserved-keyword behavior and `W_INSTALL_SELF_AMBIGUOUS` unchanged.

Result: the CLI contract becomes truthful — any targeted install can be planned and applied.

### 2. Split External Install into Explicit Planner / Executor Layers

Targets: `src/index.ts`, `src/install.ts`, `src/source.ts`

Introduce dedicated functions along the same lines as the self-install path, for example:

- `buildExternalInstallPlan(homeDir, urlOrPath, options)`
- `executeExternalInstallPlan(homeDir, plan, resolutions, runtimeOptions)`

The planner should:

- normalize CLI input (`--name`, `--path`, `--skill-subdir`, `--type`, `--branch`)
- detect source kind and derive the normalized `SourceDefinition`
- inspect current config/local state without mutating it
- detect existing-source cases:
  - brand-new source
  - same-repo match
  - restore-from-ignore
- determine whether candidate skills can be enumerated in plan phase or must be deferred to execute phase
- emit warnings for non-fatal conditions
- produce stable actions and unresolved items

The executor should:

- consume plan actions as the source of truth
- only perform mutations described by the plan
- request/consume resolutions when execute-phase candidate discovery is needed
- persist config/source state, install/activate skills, and create links
- emit result data with `plan_ref` where applicable when running through `--apply`

### 3. Make Plan Actions Explicit but Coarse-Grained

Targets: `src/cli/plan.ts`, `src/index.ts`, `src/install.ts`

Keep action vocabulary stable and coarse enough for agent consumption. Prefer a small set of install-specific ops rather than mirroring every helper call.

Recommended action shapes:

- `install-self`
- `register-source`
- `materialize-source`
- `activate-skill`
- `link-skill`
- `merge-source-scope` or equivalent single op for same-repo scope reconciliation

Guidelines:

- actions should describe user-visible effects, not internal helper choreography
- unresolved items should describe decision points, not transport details
- avoid inventing multiple overlapping unresolved kinds when `skill-selection` is enough

### 4. Normalize Execute-Phase Skill Selection

Targets: `src/index.ts`, `src/install.ts`, `src/source.ts`, `src/cli/resolution.ts`

Current behavior already performs selection after materialization. The aligned version should formalize that behavior.

Recommended contract:

- If planner can determine installable skills read-only and cheaply, it may emit plan-phase `skill-selection` candidates.
- If planner cannot do so without materialization, it emits `unresolved.kind = "skill-selection"` with `resolve_phase = "execute"`.
- Direct interactive execution may prompt only for these execute-phase items.
- `--apply` must never prompt; missing resolutions should produce `E_UNRESOLVED`.
- `--no-interactive` without `-y` or resolutions should continue to fail with `E_NEEDS_INPUT`.
- `-y` continues to mean “install all installable non-duplicate skills” for external installs.

Spec follow-through:

- If implementation keeps execute-phase selection for archive-backed or other materialized sources, update the spec wording that currently frames git as the only active example.
- If we want the spec to stay narrower, then planner work must include enough read-only discovery to make that true in practice.

### 5. Refactor Existing Mutation Helpers Under the Executor

Targets: `src/install.ts`, `src/source.ts`

Do not delete working semantics; extract them behind clearer boundaries.

Expected helper boundaries:

- pure or mostly-read-only source normalization/probing
- materialize-and-discover step
- same-repo scope reconciliation step
- ignore-list persistence step
- installed-skill activation step
- link creation step

The old `installFromSource()` can either:

- become a thin compatibility wrapper over planner + executor internals, or
- be retired once the CLI no longer uses it directly.

Either way, the final control flow should be planner/executor-first.

### 6. Align Result Payloads and Introspection

Targets: `src/index.ts`, tests for CLI introspection/help/output

- Keep `install` introspection advertising `plan_schema` / `resolutions_schema`.
- Make that introspection truthful for external installs.
- Ensure `result.summary.data` includes plan-backed references for relevant actions on apply-driven execution.
- Keep direct execution output human-friendly and consistent with existing install messaging.

### 7. Update Spec and Docs in the Same Milestone

Targets: `docs/superpowers/specs/syncskill-design.md`, any affected user-facing docs/help assertions

Update the install sections so they describe the actual final contract, including:

- shared plan/apply entry for self + external install
- exact meaning of `skill-selection` unresolved items
- when execute-phase resolution is allowed
- `--apply` / `--resolutions` behavior for external installs
- result payload expectations where `plan_ref` is relevant

## Test Plan

### Unit

1. `tests/unit/cli-plan*.test.ts`
   - planner/executor plumbing for external install joins the existing plan framework
   - unresolved execute-phase handling remains valid

2. `tests/unit/install.test.ts`
   - plan builder for new source, same-repo match, and restore-from-ignore shapes
   - executor reuses existing install semantics without direct CLI coupling

3. `tests/unit/source*.test.ts`
   - read-only probing helpers vs mutating execution helpers stay separated
   - source normalization and candidate discovery decisions are covered

### Integration

1. `tests/integration/install-cli.test.ts`
   - `--plan install <local-dir>` outputs a real install plan
   - `--apply <plan>` executes external local-directory install successfully
   - `--plan` / `--apply` for local archive sources work as designed
   - execute-phase unresolved + `--apply` without resolutions returns `E_UNRESOLVED`
   - `--no-interactive` unresolved path returns `E_NEEDS_INPUT`
   - same-repo install still reconciles scope/path/ignore behavior under the new orchestration

2. `tests/integration/cli-introspection.test.ts` / help-output tests
   - install introspection/help remains aligned with real command behavior

### End-to-End

Use only targeted user-visible coverage, not broad matrix expansion.

Recommended additions:

1. `tests/end2end/cases/install/install-local-source-derived.test.ts`
   - exercise `--plan` + `--apply` for a local source-derived install

2. `tests/end2end/cases/install/install-local-archive.test.ts`
   - exercise external archive install through the plan/apply contract if the harness can supply deterministic input

## Validation

- `npm run build`
- `vitest run tests/unit/cli-plan*.test.ts tests/unit/install.test.ts tests/unit/source*.test.ts`
- `vitest run tests/integration/install-cli.test.ts tests/integration/cli-introspection.test.ts tests/integration/help-output.test.ts`
- targeted end-to-end install cases only if the implementation milestone explicitly includes them

## Implementation Order

1. Route all install targets through `withPlanExecute()`.
2. Add external install planner with minimal stable action shapes.
3. Add external install executor that wraps existing mutation semantics.
4. Formalize execute-phase `skill-selection` resolution handling.
5. Update result payloads and introspection assertions.
6. Update spec/docs.
7. Add targeted tests in unit → integration → end-to-end order.

## Acceptance Criteria

- `install self` and `install <url-or-path>` both honor the same top-level `--plan` / `--apply` contract.
- External install no longer bypasses planner/executor orchestration.
- Interactive selection is formalized as plan/execution unresolved handling, not ad-hoc CLI-only branching.
- Introspection/help/spec/tests all describe the same behavior.
- Existing external install semantics (same-repo merge, ignore restore, auto-linking, path contract) remain intact after the refactor.
