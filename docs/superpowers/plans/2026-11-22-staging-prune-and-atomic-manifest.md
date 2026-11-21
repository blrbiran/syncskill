# Staging cleanup, prune command, and atomic remote manifest

Date: 2026-11-22
Issues: tracker #426, #427 (`orca_archived_files/issue-20261023.md`)

## Problems

**#426 — interrupted pushes leave `.skill.staging-*` trees on the remote forever.**
`pushSkillDirectory` transfers into `<remote>/skills/.<skill>.staging-<uuid>` and then asks the
receiver to `promote-skill`. Two failure paths leave the staging tree behind:

- rsync fails with a non-fallback error (`transport.ts:639` rethrows without cleanup);
- rsync succeeds but `promote-skill` fails (dropped ssh, receiver error, rename failure) — the
  receiver's `promoteSkill` has no `finally`, and the transport does not clean up either.

Nothing surfaces orphan staging directories: `scanSkills` reads only the configured agent roots and
the manifest, and the names start with `.` so a plain `ls` hides them.

**#427 — the remote `manifest.json` is written non-atomically.**
Both writers (`write-manifest` from stdin and the finalize step of `apply`) call `writeFile`
directly, which truncates before writing. A crash, a full disk, or a dropped ssh channel leaves a
half JSON file; `readJson` only falls back on `ENOENT` and rethrows the raw `SyntaxError`, so every
later `status` / `push` / `pull` fails with `Unexpected end of JSON input` and no named error, no
backup, and no recovery guidance.

## Fixes

### Receiver (`src/receiver/sync_receiver.mjs`)

1. `promoteSkill` wraps the swap in `try/catch`: on any failure after the staging path is
   validated, the staging tree for this call is removed (`rm -r`, idempotent) and the original
   error is rethrown. A successful swap has already renamed the staging tree into place.
2. New subcommand `remove-staging <path>`: removes one path only when it is a direct child of
   `skills/` whose name matches `.<safe-name>.staging-*`. Used by the transport's best-effort
   cleanup. Idempotent (`force: true`).
3. New subcommand `prune-staging [--apply] [--older-than-ms <n>]`: lists (and with `--apply`,
   removes) staging directories older than the threshold. Default threshold 24 h, so a direct
   receiver call can never delete the staging of a push that is still running. Only names matching
   `.<safe-name>.staging-*` are candidates; live skill directories are never touched. Prints JSON
   `{ applied, pruned: [{skill, name, path, age_ms, bytes}], skipped: [...] }`.
4. Manifest writes go through `writeJsonAtomic`: serialize, write to a sibling temp file
   (`manifest.json.tmp-<pid>-<ms>-<rand>`), `rename` over the manifest. Before replacing, the
   current manifest is copied to `manifest.json.bak` **only when it parses** — a corrupt current
   file must not overwrite the last good backup.
5. Reads of the manifest go through `readManifestOrNull`, which returns `null` on `ENOENT` and
   throws a named error on invalid JSON:
   `manifest-invalid: <path> is not valid JSON (<cause>); restore <path>.bak or remove the file to
   start fresh`. `readManifest` (default empty manifest) and `probeAccess` both use it.

### Transport (`src/core/transport.ts`)

6. `pushSkillDirectory`:
   - on a non-fallback rsync failure: best-effort `remove-staging` over ssh, then rethrow the
     original rsync error;
   - on a promote failure: best-effort `remove-staging` over ssh, then rethrow the original promote
     error.
   Cleanup failures are swallowed: they must never mask the transfer error that actually happened.
7. New `pruneRemoteStaging(server, runtime, { apply, olderThanMs })`: runs the receiver's
   `prune-staging` over ssh and returns the parsed JSON.

### CLI (`src/index.ts`)

8. New top-level command:
   `syncskill prune [server] --all --apply --older-than <hours> [--json]`
   - default is a dry run; `--apply` deletes;
   - `--older-than` defaults to 24 hours;
   - target-server resolution follows `push` / `pull` / `sync` (`selectTargetServers` gains the
     `prune` action);
   - text output: one line per candidate with `server`, skill name, age, and bytes, then a total;
     `--json` emits the structured result.
9. `docs/usage-guide.md`: document `prune` next to the remote sync workflow.

## Non-goals

- Pruning `.backup-*` sibling trees. The swap path creates them and removes them on success; a
  crash between the two renames can strand one (noted in the handoff, not fixed here).
- Remote garbage collection beyond staging directories.
- Changing the staging naming convention or the promote validation.

## Tests (write first, see red)

`tests/integration/transport.test.ts`:

- receiver `promote-skill` failure removes the staging tree (feed a staging path that is a file,
  which fails the directory check) and exits non-zero;
- receiver `remove-staging` refuses a live path and removes a staging path;
- receiver `prune-staging` lists only stale staging directories, keeps fresh ones, and with
  `--apply` deletes only candidates;
- transport cleans up on a non-fallback rsync failure (two exec calls; original error propagates);
- transport cleans up when `promote-skill` fails (two ssh calls; original error propagates);
- `pruneRemoteStaging` issues `prune-staging` with the requested flags.

`tests/integration/receiver-root.test.ts` (or a new receiver test file):

- a corrupt `manifest.json` makes the `manifest` command exit non-zero with `manifest-invalid` on
  stderr;
- `write-manifest` replaces atomically and leaves `manifest.json.bak` holding the previous
  parseable content;
- a corrupt current manifest does not clobber an existing good `.bak`.

Existing criterion to rewrite: `pushSkillDirectory does not fall back for rsync transfer errors`
asserted `exec` was called exactly once. With best-effort cleanup the call count changes; the test
keeps asserting that the original error propagates and that no `import-skill` fallback happens, and
now also asserts the cleanup call.

## Gates

- `npm test` (unit + integration) must pass; `npm run build` must pass.
- Milestone merge to `main` via `--ff-only`; no push (no `allow-push` this session).