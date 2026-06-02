# 2026-06-02 Spec Alignment Audit Plan

## Goal

Based on the current working-tree spec updates in `docs/superpowers/specs/syncskill-design.md` and `docs/superpowers/specs/CHANGELOG.md`, align implementation, tests, e2e coverage, docs, skill copy, and CLI help with the current design.

## Constraints

- Use the current working-tree spec documents as the source of truth for this task.
- Do not accidentally include unrelated working-tree changes in commits.
- Keep changes minimal and scoped to the current step.
- Create a git commit at the end of each user-requested step.

## Steps

1. Audit implementation against spec and fix missing/inconsistent behavior.
2. Refactor only where the current implementation is structurally awkward or duplicate logic is clearly reusable.
3. Audit and update unit/integration tests for current behavior and remove/update outdated tests.
4. Audit and update end-to-end coverage for current behavior and remove/update outdated e2e tests.
5. Update user-facing docs, `skills/syncskill/SKILL.md`, and CLI help to match the current spec and implementation.

## Validation

- Run `npm run build` for code changes.
- Run unit tests for implementation and test updates.
- Run targeted integration tests when behavior/help output changes.
- Run targeted e2e tests only for step 4.

## Commit Strategy

- Commit step 1 code changes separately.
- Commit step 2 refactor separately.
- Commit step 3 test updates separately.
- Commit step 4 e2e updates separately.
- Commit step 5 docs/help updates separately.
- Keep the plan doc out of unrelated commits; commit it separately if needed by repository workflow.
