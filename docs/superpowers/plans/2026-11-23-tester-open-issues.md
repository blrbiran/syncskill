# syncskill Tester Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close syncskill tester issues #428–#430 with explicit conflict control, a safe skill-removal command, and complete backup-recovery JSON reporting.

**Architecture:** Extend the existing Commander CLI and `SyncEngineOptions` for #428; build #429 on existing link removal and skill directory/config helpers, with dry-run and destructive confirmation; keep #430's existing per-server response and expose both staging and backup results in JSON. Add CLI-level integration coverage alongside current transport tests.

**Tech Stack:** TypeScript, Commander, Vitest, existing syncskill transport/runtime fakes.

**Spec:** Tester report `../orca_archived_files/issue-20261023.md` issues 428–430; current contracts in `src/index.ts`, `src/core/sync_engine.ts`, `src/config/config-doctor.ts`.

## Global Constraints

- Preserve current push behavior when `--on-conflict` is omitted.
- `prune` stays dry-run unless `--apply` is present.
- Skill removal must never follow symlinks outside the managed skill directory; test only against isolated temp roots.
- Keep text output backward compatible except for newly exposed command help/output.
- Do not touch user-level syncskill configuration or real skill directories.

## Review Focus

- `push --on-conflict` must reach engine policy resolution while omitted flag remains byte-compatible.
- `skill remove` must unlink all configured agent targets and avoid deleting files in `--keep-files` mode.
- Destructive removal must refuse non-interactive invocation without its explicit destructive flag.
- `prune --recover-backups --json` must preserve both staging and backup outcomes for dry-run and apply.
- Recovery JSON must not imply a restore occurred during dry-run.

---

### Task 1: Push conflict policy

**Files:** `src/index.ts`; `tests/integration/transport.test.ts` or the existing CLI integration fixture.

- [ ] Add CLI assertions for `push --on-conflict skip` and invalid policy rejection.
- [ ] Confirm the new criterion fails because push does not accept/pass the option.
- [ ] Add `.option('--on-conflict <policy>', ..., parseOnConflict)` and pass `options.onConflict` to `pushToServers`.
- [ ] Run the focused integration test and build.

### Task 2: Backup recovery JSON

**Files:** `src/index.ts`; `tests/integration/transport.test.ts`.

- [ ] Add CLI tests for `prune --recover-backups --json` dry-run and `--apply`, asserting per-server `backups.recovered`, `backups.skipped`, and `applied` values.
- [ ] Confirm the dry-run JSON currently omits backups.
- [ ] Include `backups` in each server's JSON result only when requested; retain the existing staging fields.
- [ ] Run focused integration tests and build.

### Task 3: Skill removal

**Files:** `src/index.ts`, existing config/skill filesystem helper only if needed, CLI integration tests/help-output tests.

- [ ] Add tests for default removal deleting the managed skill tree, clearing `config.links[name]`, and removing agent links; test `--keep-files` preserves the tree; test dry-run changes nothing; test non-interactive destructive refusal absent `--yes-destructive`.
- [ ] Confirm the tests fail against current command table.
- [ ] Implement `skill remove <name> [--keep-files] [--dry-run] [--yes-destructive]` using existing link cleanup helpers and managed paths; refuse path traversal and symlink escape.
- [ ] When `link remove` removes the final target, delete the empty `links[name]` key; keep `link clear` behavior consistent.
- [ ] Run focused tests and build.

### Final verification

- [ ] Run `npm test` and `npm run build` from the syncskill repo; report exact counts and any skips.
- [ ] Review the diff for deletion boundaries and JSON shape stability.
