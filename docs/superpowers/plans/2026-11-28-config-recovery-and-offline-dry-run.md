# Config Recovery and Offline Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep status, scan, and update usable when config diagnosis reports blocking problems, and make push/pull/sync dry-run plans without any SSH calls.

**Architecture:** Make `autoDiagnoseConfig` report health instead of exiting. The CLI pre-action hook will allow recovery commands, known read-only commands, and dry-runs through while keeping unhealthy writes blocked. Dry-run sync planning will derive the last-known remote state from the local manifest and receiver backup, omit live remote listings, and warn when no local receiver backup exists.

**Tech Stack:** TypeScript, Commander, Vitest.

**Spec:** `docs/superpowers/specs/syncskill-design.md` §§3.0.1, 3.1, 10.5; archived issues #533 and #555 in `/Users/biran/code/skills/orca/orca_archived_files/issue-20261023.md`.

## Global Constraints

- A dry-run does not modify local or remote state and issues no SSH/rsync calls.
- `status`, `scan`, and `update` remain available when diagnosis returns `canProceed: false`; read-only commands and any dry-run also remain available, while writes retain the config-error gate.
- `autoDiagnoseConfig` is a library helper and does not terminate the process.
- Dry-run output distinguishes a last-known-state plan from a live remote inspection.
- Tests use temporary homes and fake transport only.

## Review Focus

- A dangling link makes `canProceed` false; `status --json` still returns one valid JSON record and text status is non-empty.
- A write command such as `push` remains blocked for the same unhealthy config.
- The dry-run of push, pull, and sync makes zero runtime calls, including remote skill listing.
- A known remote hash in the local manifest still informs dry-run direction; unknown remote state is not represented as current fact.
- Without a receiver backup, push dry-run states that its preview is not constrained by the remote link matrix and may differ on first push.

---

### Task 1: Config recovery preflight

**Files:** `src/config/config-doctor.ts`, `src/index.ts`, `tests/integration/doctor-cli.test.ts` or a focused existing CLI integration test, `docs/superpowers/specs/syncskill-design.md`.

- [x] Add CLI regression coverage for a dangling-link config: `status --json` succeeds with exactly one parseable JSON record, text `status` has non-empty stdout, `scan`, `scan --dry-run`, and `update` actions complete, `link list --json` remains readable, and `push` remains blocked.
- [x] Change `autoDiagnoseConfig` to return `{ healthy: boolean; canProceed: boolean }` after writing its existing summary to stderr; remove `process.exit` from the helper.
- [x] Have the pre-action hook allow `status`, `scan`, `update`, all read-only commands, and any dry-run after failed diagnosis; block writes at the CLI layer with config exit code 3.
- [x] Align spec §10.5 with the recovery command allowlist and result contract; run the focused CLI suite and build.

**Scope note:** The current CLI does not emit JSON result records for `scan` or `update`; this patch verifies those action paths in text mode and preserves existing JSON contracts for `status` and `link list`.

### Task 2: Offline dry-run planning

**Files:** `src/core/sync_engine.ts`, `tests/integration/sync-engine.test.ts`, `docs/superpowers/specs/syncskill-design.md`.

- [x] Add fake-runtime tests proving push, pull, and sync dry-run complete with zero runtime calls; include a missing-backup warning assertion and a cached-remote-hash plan assertion.
- [x] Build read-only manifest state from local `remote_hash` values instead of calling `fetchRemoteManifest`.
- [x] For push dry-run, derive the known remote skill set from local state and avoid `listRemoteSkills`; keep real push and pull transport behavior unchanged.
- [x] Emit an explicit warning when the local receiver backup is absent: the preview is not constrained by the remote link matrix and first push may push fewer skills.
- [x] Update spec §3.0.1 to state that dry-run makes no transport requests and plans from locally cached state; run focused tests and build.

### Final verification

- [x] Run `npm run build`, `npm run test:unit` (581 tests), and the targeted integration set (78 tests).
- [ ] Review the full diff for preflight blocking behavior, zero-transport dry-run behavior, and accidental write paths.
