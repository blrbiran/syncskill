# SDD ledger — plan: docs/superpowers/plans/2026-10-03-profile-inject-version.md

Owner: Claude Code session `16ab00f2` (controller, launched from the Orca repo), 2026-10-03. Spec:
`docs/superpowers/specs/2026-10-03-profile-inject-version-design.md`. Base: syncskill main at subject
`docs(plan): task-by-task implementation of profiles, inject and recorded source commits`.
Human: work directly on main; proceed without asking; report at the end.

## Pre-flight scan

| rows | produces / consumes | finding |
|---|---|---|
| T1 ↔ T4 | T1 `SyncSkillConfig.profiles`, `PROFILE_NAME_PATTERN` → T4 profile commands | consistent |
| T2 ↔ T3 | T2 `SourceState.resolved_commit` → T3 lock `resolved_commit` via `loadSourceState` | consistent |
| T3 ↔ T4 | T3 `injectSkills`, `InjectError`, `normalizeSkillList`, exported `resolveConfiguredSkillSourceDir` → T4 | consistent |
| T4 ↔ T5 | T4 command names `profile`, `inject`, flags → T5 help/docs assertions | consistent |
| T1 self | test asserts sort+unique+string filter; code does the same | consistent |
| T2 self | integration flags for `install`/`update` may differ from the real CLI; plan allows adapting args, not assertions | ok |
| T3 self | unit test covers pure functions only; behaviour covered by T4 integration | ok |
| T4 self | test 1 relies on `config set` (exists, src/index.ts `configCommand.command('set [key] [value]')`) | ok |
| T5 self | docs assertions depend on T4 names | ok |

Ruling: keep this ledger after the final review instead of deleting the workspace — Orca/syncskill keep SDD ledgers as evidence (this directory already holds other plans' ledgers); force-add it to git at the end — cost if wrong: one extra tracked file.

## Task 1
Task 1: implementer DONE_WITH_CONCERNS, commit 999c311 (base 5add866).
Ruling: accept the three `profiles: {}` additions to expected literals in tests/unit/config.test.ts — they are the mechanical consequence of the spec's "always present" default, not a loosened assertion — cost if wrong: none beyond a reviewer note.
Ruling: leave the pre-existing `tsc --noEmit -p tsconfig.json` errors over tests (implementer measured 177 on base, 176 after) out of scope; the gate is `npm run build` (src only), which is clean — cost if wrong: test-type errors keep hiding typos in tests; registered for the handoff.
Task 1: review spec ✅ quality Approved. ⚠️ items resolved by controller: SAFE_SKILL_NAME is /^[a-zA-Z0-9_-]+$/ (read src/core/transport.ts:37 this session); gate evidence in task-1-report.md.
Task 1: minor (deferred): pattern test does not compare PROFILE_NAME_PATTERN with SAFE_SKILL_NAME (drift unnoticed).
Task 1: minor (deferred): normalizeProfiles one-liner is dense (brief's code).
Task 1: complete (commits 5add866..999c311, review clean)

## Task 2
Task 2: implementer DONE, commit d051ebb (base 999c311). It updated 15 existing toEqual expectations in tests/unit/source.test.ts for the new field (null for local/http, 40-hex matcher for git) and added resolved_commit: null to the dry-run and dirty-skip in-memory results.
Ruling: accept the 15 expectation updates — the field is spec-mandated on every state, and git ones assert a 40-hex value rather than loosening — cost if wrong: a reviewer note.
Task 2: review spec ✅ quality Approved; reviewer confirmed dry-run/dirty-skip paths never write state.json (only saveSourceState at src/source.ts:1394).
Task 2: minor (deferred): unit test lacks a 40-char lowercase non-hex and a non-string case for normalizeSourceState.
Task 2: minor (deferred): fail-before evidence was reasoned, not run (controller mutations will cover it).
Task 2: minor (deferred): readGitHead failure after sync throws before state is saved (loud, as briefed).
Task 2: complete (commits 999c311..d051ebb, review clean)

## Task 3
Task 3: implementer DONE, commit 9337891 (base d051ebb). Review (opus): spec ✅, quality Approved with 1 Important.
Ruling: skill-name guard in injectSkills rejects empty, `.`, `..`, leading `.`, `/`, `\`, NUL with new code E_USAGE_SKILL_NAME (exit 2 via prefix) — not the strict /^[a-zA-Z0-9_-]+$/ because local skill dir names may contain dots — cost if wrong: a dotted skill name some user relies on is still accepted (intended), or a traversal shape not in the list slips through.
Ruling: empty skill list after normalizing throws E_USAGE_INJECT_SELECTION (spec silent; an empty lock is useless to the caller) — cost if wrong: a caller wanting an empty snapshot gets exit 2.
Task 3: minor (deferred): stale `.syncskill-inject-<pid>` from a dead process with the same pid makes one run fail and is then removed.
Task 3: minor (deferred): a target created by this call is left (empty) when a later step fails — spec allows; Task 4 should not assert its absence after a mid-copy failure.
Task 3: minor (deferred): link() fails on filesystems without hard links (exFAT) — spec-mandated.
Task 3: minor (deferred): no separate fail-first run for the pure-helper test.
Task 3: fix round 1/5 (2 addressed, 0 open — unsafe skill names; empty selection; commits 9337891..66c87b2). Guard tests 5/5 fail with the guard reverted (implementer-run).
Task 3: complete (commits d051ebb..66c87b2, review clean)

## Task 4
Task 4: implementer DONE, commit 3e067f9 (base 66c87b2); new integration file 8/8, failed 8/8 with src stashed. Review (opus): spec ❌ (1 Important), quality Needs fixes.
Ruling: `profile set` reuses inject's name guard (exported isSafeSkillName) and refuses unsafe names with E_USAGE_SKILL_NAME before resolution — a profile must never hold a name inject will refuse — cost if wrong: none found.
Ruling: take review Minors 2–7 and 9 into fix round 1 (test strength, cause message, guard without mtimes, relative --target case) — cheap and each closes an assertion that could not go red — cost if wrong: a slightly larger diff.
Ruling: profile set/rm keep `entity: 'skill'` in change events — spec forbids new event types and ChangeEvent.entity has no profile value — cost if wrong: a JSON consumer reads a profile change as a skill change.
⚠️ resolved by controller: profiles survive every saveConfig because every writer saves an object that came through validateConfig (keeps profiles) or createDefaultConfig (profiles: {}) — Task 1 code; integration case 1 pins the config-set path.
(Controller check of the ⚠️ line above: 30 saveConfig call sites in src/ (grep this session); the spot-checked ones (index.ts removeAllSkillLinks, config set via setConfigValue, repo.ts init, install.ts) all save a loaded/validated object; and `profiles` is a required field of SyncSkillConfig with `npm run build` clean, so a literal missing it would not compile. A runtime object from JSON.parse that bypasses validateConfig would not be caught by this argument — none seen.)
Task 4: fix round 1/5 (8 addressed, 0 open — profile set name guard; case 1/5/6 strength; events name+target; unknown-profile, ls-all, relative target cases; cause message; guard without mtimes; commits 3e067f9..fb5b51c). Integration 11/11 (implementer-run).
Task 4: complete (commits 66c87b2..fb5b51c, review clean)

## Mutations (controller, clone of syncskill at fb5b51c, node_modules symlinked; script and JSON outputs in the session scratchpad)
M1 validateConfig drops profiles → red: int 1, 3, unknown-profiles; unit config-profiles ×2.
M2 (first form `false`) did not compile (build rc 2) → result void. M2 (`? value.resolved_commit` → `? null`) → red only unit "keeps a 40-hex lowercase commit"; integration all green. The spec's prediction (integration 2 red) was wrong: integration 2 reads state.json raw, and normalizeSourceState only matters on read, i.e. in the lock — which no integration case covered for a git-sourced skill.
Ruling: reopen Task 4 for fix round 2 — add an integration case injecting a git-sourced skill and asserting lock source/resolved_commit/content_md5 (spec §7 integration 3 required it; the implemented case 3 used manual skills only) — cost if wrong: one more test.
M3 resolved_commit never written → red: int source-resolved-commit.
M4 cp→symlink → red: int 4, 7.  M5 occupancy loop off → red: int 5.  M6 mkdir(target) before resolution → red: int 5.
M7 dereference false → red: int 7.  M8 lock link→rename + lock not checked → red: int 8.
M9 normalizeSkillList identity → red: int 3, unit inject-lock.  M10 profile-set name guard off → red: int "rejects unsafe skill names in profile set".
Restore: git diff 0 bytes, diff --cached 0 bytes, rebuild rc 0 (after M1–M10 and again after M2 rerun).
Task 4: reopened — fix round 2/5 dispatched (git-sourced lock case).
Ruling: Task 5 (docs/help, disjoint files) runs concurrently with Task 4 fix round 2 on main — both were already dispatched when the gap surfaced; files do not overlap — cost if wrong: a transient git index.lock retry.

## Task 5
Task 5: implementer DONE_WITH_CONCERNS, commit 462f40f. Gate: build 0; unit 525/525; integration first run 10 failed (9 exact-shape toEqual in config-cli/config-ui/discover/repo missing `profiles: {}` — Task 1 fallout not caught because integration is not a per-task gate; 1 install-cli help 5000 ms timeout), second full run 22 files 277/277.
Ruling: accept the nine `profiles: {}` expectation additions (same reasoning as Task 1's) — cost if wrong: none beyond a review note.
Ruling: the concurrency ruling above was wrong — 462f40f swept in Task 4 fix round 2's uncommitted git-sourced inject case via `git add tests`. Keep the commit (history on main, not rewritten); attribute the test to Task 4 fix round 2 in this ledger and verify its red proof from that implementer's report — cost if wrong: one commit mixes two tasks' changes.
Task 5: install-cli "should show install command in help" timed out once under load (load 13 at 14:35 in this session); not re-run alone — to re-run 3× singly before closing.
Task 4: fix round 2/5 (1 addressed — git-sourced lock case, landed inside 462f40f; red proof by implementer; controller re-ran M2/M3 at 462f40f with the profile-inject file included: both red on "records source identity and the source repo HEAD for a git-sourced skill"; restore 0/0 bytes, rebuild 0).
Task 4: complete (commits 66c87b2..462f40f, review clean; last test case shipped in 462f40f)
Task 5: review (A) spec PASS quality PASS; (B) Task 4 fix round 2 ADDRESSED.
Task 5: minor (deferred): usage-guide doc assertions never seen red on their own (short-circuit behind README).
Task 5: minor (deferred): top-level help assertion toContain('profile') would also match 'profiles'.
Task 4: minor (deferred): no `source` mutation demonstrated for the git-sourced case (toEqual would catch it).
Task 4: minor (deferred): the git-sourced case compares source url/branch with config.sources (spec-mandated comparison).
Task 5: minor (deferred): fix-round-2 test is inside the commit labelled "docs".
Controller gate at 462f40f (clone; TMPDIR mktemp -d /private/tmp/ssg-XXXX; load 5.2 at start): build 0; tests/unit 525/525 (0 skipped); tests/integration 278/278 (0 skipped); install-cli "should show install command in help" alone 3/3 green (load 12.2–13.0) ⇒ load flake.
Task 5: complete (commits fb5b51c..462f40f, review clean)

## Final review (opus) — ready with fixes
Findings: (1) Important prototype-key profile names (`__proto__` silently dropped; `constructor`/`toString` TypeError exit 1 in ls/inject; rm claims deletion); (2) Important data safety: mkdir(staging) inside try ⇒ EEXIST makes the catch rm -rf a pre-existing `.syncskill-inject-<pid>`; (3) Minor preflight autoRefreshManifests rewrites manifests on inject; (4) Minor raw errors exit 1 without JSON error event (CLI-wide); (5) Minor commander usage errors exit 1 (CLI-wide). Regraded deferred Task 3 stale-staging minor to Important (same path as 2).
Ruling: fix 1 with Object.hasOwn existence checks + reject `__proto__` in profile set (E_USAGE_PROFILE_NAME) — a legitimate own key like `constructor` keeps working — cost if wrong: one more reserved name.
Ruling: fix 2 with mkdtemp(join(target, '.syncskill-inject-')) created before the try; spec §5 stays verbatim, correction appended as §9 — cost if wrong: residue names change from <pid> to random suffix (docs updated).
Ruling: fix 3 — inject skips the manifest auto-refresh but keeps config diagnosis — spec §5.6 says inject does not touch the manifest and Orca will run injects in parallel — cost if wrong: an inject no longer refreshes stale manifests as a side effect (other commands still do).
Ruling: leave 4 and 5 — existing CLI convention, recorded for Orca's caller (exit 1 without a JSON error event = general failure; not every usage error is 2) — cost if wrong: Orca must not over-interpret exit codes.
Final fix wave dispatched (one fixer, all findings).
Final fix wave: commit 9fc9fd7 (base 462f40f). Scoped re-review: findings 1–3 ADDRESSED, no new breakage; skip applies only to top-level `inject`.
Controller gate at 9fc9fd7 (clone; load 5.9 at start): build 0; tests/unit 526/526; tests/integration 280/280; 0 skipped.
Controller mutations at 9fc9fd7 (script copied to mutations.py in this directory; run as `python3 mutations.py <clone> <outdir> [M…]`):
M4 (re-anchored after the mkdtemp import) cp→symlink → red int 4, 7.  M5 → red int 5.  M7 → red int 7.  M8 → red int 8.
M11 profile set accepts __proto__ → red int 9.  M12 ls existence via plain lookup → red int 9.
M13 staging back to `.syncskill-inject-<pid>` with mkdir inside try → red unit "never removes a pre-existing .syncskill-inject-* directory when the copy fails".
M14 inject refreshes manifests → red int 10.
Restore after each batch: git diff 0 bytes, --cached 0 bytes, rebuild 0.
Not shown red by the controller: the normalizeProfiles own-`__proto__` drop (JSON-borne key) — covered only by the implementer's report.

## Follow-up: --sync-dir (Orca session 08b1007d, 2026-10-03, human-authorized "按你的方案修")
Commit c30d5bd `fix(cli): make --sync-dir / SYNCSKILL_DIR relocate the sync dir; reject --config` on main (base 521897f).
Ruling: the override is a module-level value set by the CLI preAction (setSyncDirOverride), not an env read inside getSyncDir — unit tests and library callers that pass homeDir can never be redirected by a stray SYNCSKILL_DIR in the shell — cost if wrong: a future non-CLI entry point must call setSyncDirOverride itself.
Ruling: only absolute paths (E_USAGE_SYNC_DIR otherwise) — avoids the unexpanded-`~` trap in cerebrum — cost if wrong: callers must resolve paths first.
Ruling: --config / SYNCSKILL_CONFIG rejected (E_USAGE_CONFIG_PATH, exit 2), not implemented — cost if wrong: anyone with SYNCSKILL_CONFIG exported now gets exit 2 on every command.
Ruling: src/receiver/sync_receiver.mjs untouched — it runs on the remote host under the remote HOME.
New criteria: tests/integration/sync-dir-cli.test.ts (4 cases + real ~/.syncskill snapshot guard), sync-engine.test.ts "pullFromServer writes pulled skills under a relocated sync dir, not HOME" (measures the rsync destination; the fake runtime writes no files).
Mutations (clone, rebuild per mutation, both test files): M1 getSyncDir ignores override → red engine case + cli cases 1,2. M2 engine skills dir back to HOME → red engine case only. M3 preAction never sets override → red cli 1,2. M4 no --config rejection → red cli 4. M5 no absolute check → red cli 3. M6 env beats flag → red cli 2. Restore: clone files byte-identical to main tree (cmp), rebuild 0.
Gate (clone at the tree of c30d5bd minus spec/cerebrum text; HOME + 4 XDG roots redirected, TMPDIR mktemp -d /private/tmp/ss-XXXX; load 9.3 at end): build 0; tests/unit 526/526; tests/integration 285/285; 0 skipped.
Known residue (not fixed): integration helpers elsewhere spread process.env into the CLI, so an exported SYNCSKILL_DIR in the test runner's shell would now redirect those runs (the new file deletes it). 
