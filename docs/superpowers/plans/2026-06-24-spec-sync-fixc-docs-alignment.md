# 2026-06-24 Spec Sync, Fix-C, and Docs Alignment

## Goal

Align the current implementation, tests, help surface, and user-facing docs with the latest `docs/superpowers/specs/syncskill-design.md` changes, while only implementing spec items that are consistent with verified code semantics.

## Scope

1. Implement the real missing behavior from v2.9.1 Fix-C: when `push` uses an existing receiver backup, merge newly declared `config.links` intent into the per-server backup before building/pushing receiver config.
2. Add regression coverage for that merge behavior.
3. Review the latest spec diff against current code and treat clearly conflicting/older wording as spec drift to be reflected back into docs rather than forcing code away from verified behavior.
4. Update user-facing docs/help surfaces (`README.md`, `docs/*.md`, `skills/syncskill/SKILL.md`, help-facing tests) to match current verified behavior.

## Confirmed Findings Before Changes

- `src/core/sync_engine.ts` currently loads an existing receiver backup and directly builds/pushes receiver config from it; there is no merge step from `config.links` into `backup.links` before `applyRemoteLinks()`.
- `src/linker.ts` still exposes realized-state wording and `unconfigured` status; the latest spec diff tries to collapse that distinction, but current code and tests intentionally preserve it.
- `src/source.ts` still uses split discovery semantics (`discoverAllSkills()` = top-level local managed skills + source-derived skills; source install helpers also still have narrower discovery paths in some helpers). The latest spec diff’s “uniform recursive SKILL.md discovery” is not the current verified implementation.
- `tests/integration/install-cli.test.ts` still encodes execute-phase `skill-selection` for local directory installs; current code also does this. The latest spec diff narrows execute-phase unresolved to git only, which is not true today.

## Implementation Plan

1. Add a pure helper that merges eligible `config.links` entries into an existing receiver backup without overriding explicit per-server backup state.
2. Call that helper in the push path before `buildReceiverConfigPayload()` / `applyRemoteLinks()` and persist the backup only when it changed.
3. Add focused tests for the merge behavior and verify no override occurs for existing per-server entries.
4. Update docs/help to describe the current verified contracts:
   - `link list` shows realized status and still distinguishes `missing` vs `unconfigured`
   - install plan/apply works for external installs, and execute-phase `skill-selection` is still used beyond git in current implementation
   - receiver backup is the per-server sync input, with push filling missing included links from `config.links`
5. Keep obvious code/spec conflicts documented as drift instead of forcing broader implementation churn in this milestone.

## Validation

- `npm run build`
- targeted vitest for receiver-backup merge, help output, docs assertions, install/link contract coverage

## Acceptance Criteria

- `push` no longer silently drops newly configured links just because an older receiver backup already exists.
- Added tests fail without the merge and pass with it.
- User-facing docs/help reflect the verified implementation contract, not stale wording.
- This milestone does not broaden into unrelated source-discovery or link-status redesign work.
