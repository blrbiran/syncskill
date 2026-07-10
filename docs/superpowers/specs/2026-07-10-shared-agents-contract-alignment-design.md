# Shared `agents` Contract Alignment Design

Date: 2026-07-10
Status: Draft for review

## Goal

Align the user-visible contract for the shared local target `agents` after the recent implementation fixes, without expanding into unrelated docs or behavior cleanup.

This design covers three questions:

1. Whether any additional tests are still needed for the shared `agents` behavior.
2. Whether `docs/superpowers/specs/syncskill-design.md` needs updates to match the current implementation.
3. How to minimally update user-facing docs, the bundled `syncskill` skill doc, and CLI help so they no longer contradict the current shared-target behavior.

## Scope

In scope:

- Shared local target `agents` as a first-class local link target.
- `syncskill install` default local link behavior where `config.links[*]` may include `"agents"`.
- `syncskill link build` materialization and stale cleanup behavior for `~/.agents/skills/`.
- `syncskill link list` / `link ls` realized-status behavior for shared links.
- `syncskill link edit`, `link remove`, `link clear`, and `unlink` behavior as it relates to `agents`.
- Shared-vs-private agent semantics where they affect user-visible explanation.

Out of scope:

- Unrelated install/link wording drift not caused by shared `agents` behavior.
- Remote/server/receiver documentation cleanup.
- Structural rewrites of docs.
- New features or command-surface changes.

## Current Behavior To Treat As Canonical

The current implementation now treats `agents` as a real local target in the local link/materialization layer:

- `agents` represents the shared directory `~/.agents/skills/`.
- `agents` does not need to appear in `config.agents` to be usable as a local link target.
- `syncskill install` may write `"agents"` into `config.links[skill]` and materialize a symlink into `~/.agents/skills/<skill>`.
- `syncskill link build` creates, summarizes, and stale-cleans shared links under `~/.agents/skills/`.
- `syncskill link list` reports the realized state for shared links.
- `syncskill link remove <skill> agents` is a valid local operation.
- `private_agents` still means those agents require their own dedicated per-agent links in addition to or instead of shared-dir behavior, depending on the configured targets.

## Testing Decision

### Principle

Only add tests that directly protect the shared `agents` contract. Do not add extra coverage for neighboring install/link behavior unless the shared-target change made it necessary.

### Audit Rule

Before adding more tests, verify whether coverage already exists for:

- Shared-link materialization to `~/.agents/skills/`.
- Shared-link JSON/result summaries.
- Shared stale-link cleanup.
- Shared target visibility in `link list` / `link ls`.
- Shared target handling in `link remove` / `unlinkSkillFromAgent`.
- Shared target visibility in the local matrix/UI path.

### Expected Outcome

- If these behaviors are already covered by targeted unit/integration tests, do not add more behavior tests.
- If docs/help wording changes alter public contract text, update the existing docs/help regression coverage rather than adding duplicate test layers.

## Required Main Spec Updates

Update `docs/superpowers/specs/syncskill-design.md` only where the current main spec still implies the old behavior.

### Required clarifications

1. In install/link sections, state explicitly that `agents` is a first-class shared local target that resolves to `~/.agents/skills/`.
2. Clarify that `agents` is not merely a value filtered through `config.agents`; local materialization and realized-status paths understand it directly.
3. Update stale-link reconciliation text so it covers the shared directory in addition to per-agent directories.
4. Update `link list` / `link ls` semantics so realized shared links are included in the displayed matrix.
5. Update link-management semantics so `link edit` / `link remove` / related local link operations can refer to `agents` as a valid target.
6. Keep the distinction between:
   - `agents` = shared local target at `~/.agents/skills/`
   - `private_agents` = agents that require dedicated per-agent links
   - `config.agents` = explicit local agent directory mappings for named private/non-shared agents

## Required User-Facing Doc Updates

Update only the places where the shared-target fix changes what a user would reasonably expect.

### `docs/config-guide.md`

Adjust:

- `agents`, `private_agents`, and `links` field descriptions.
- Any example or prose implying that `"agents"` must be declared under `config.agents`.
- Any example that should now show shared + private target combinations more clearly.

### `docs/design-guide.md`

Adjust:

- Shared-vs-private local target explanation.
- Any design rationale text that still treats `agents` as a derived placeholder instead of a user-visible target.

### `docs/usage-guide.md`

Adjust:

- `install` examples and link examples involving default targets.
- `link list`, `link remove`, and `link build` examples where shared links should appear.

### `docs/README.md` and root `README.md`

Adjust:

- Introductory install/link explanations where shared-link defaults are described.
- Any quickstart examples that now produce `agents` in visible output.

### `skills/syncskill/SKILL.md`

Adjust:

- AI-agent guidance for `link set` + `link build` where shared target semantics matter.
- Any explanation of local target names so `agents` is described consistently with the CLI.

## CLI Help Policy

Review help for:

- root help
- `install --help`
- `link --help`
- `link list --help`
- `link remove --help`

Only change help text if the current wording contradicts the shared-target behavior. Avoid speculative wording improvements unrelated to this fix.

## Implementation Shape

1. Audit existing shared-target tests.
2. Add only missing shared-target coverage.
3. Update the main spec sections in `syncskill-design.md`.
4. Update the user-facing docs listed above.
5. Update bundled skill docs.
6. Update CLI help only where shared-target wording is wrong or incomplete.
7. Run targeted contract verification.

## Verification

Required verification for this work:

- `npm run build`
- Targeted shared-`agents` regression suites for link/install/config UI behavior
- `tests/unit/docs.test.ts` if docs text changes
- `tests/integration/help-output.test.ts` if CLI help text changes

## Acceptance Criteria

This work is complete when all of the following are true:

1. Shared `agents` behavior is already covered by focused tests, or any missing direct coverage has been added.
2. `docs/superpowers/specs/syncskill-design.md` no longer implies the pre-fix shared-target behavior.
3. The listed docs no longer contradict the current implementation of shared local links.
4. The bundled `syncskill` skill doc uses the same shared-target vocabulary as the CLI and main docs.
5. CLI help does not mislead users about whether `agents` is a valid local target.
6. Verification passes.
