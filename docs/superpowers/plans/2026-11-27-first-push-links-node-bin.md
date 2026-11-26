# First-Push Links and Remote Node Plan

> **For agentic workers:** Implement directly in this isolated worktree using test-first changes.

**Goal:** Preserve per-skill targets on first push and make configured remote Node selection work from bootstrap through receiver execution.

**Architecture:** Seed a missing receiver backup from configured remote agent paths and only the included `config.links`, while merging missing entries into existing backups without overriding their explicit state. Normalize the verified legacy `servers.<name>.agents` string map at config load, pass `node_bin` into the remote bootstrap, and guard receiver runtime versions below Node 18.

**Tech Stack:** TypeScript, Node.js ESM receiver, POSIX shell, Vitest.

**Spec:** `docs/superpowers/specs/syncskill-design.md` plus archived issues #554, #518, and the `node_bin` portion of #556 in `/Users/biran/code/skills/orca/orca_archived_files/issue-20261023.md`.

## Global Constraints

- Existing receiver backup entries have priority over `config.links`.
- A first push materializes configured per-skill targets in the local receiver backup and sent receiver payload.
- Treat `servers.<name>.agents` as a legacy remote-agent path map only when entries are string paths; explicit `remote_agents` remains authoritative.
- Bootstrap and receiver invocation use the same configured `node_bin`; Node major versions below 18 fail with `E_RECEIVER_NODE_TOO_OLD` and exit 8.
- Tests use fake SSH and local temporary fixtures only; no production data, real remote hosts, external service writes, push, or merge.

## Review Focus

- First push without a backup sends configured per-skill targets and materializes them locally.
- Existing backup mappings, including explicit empty mappings, are not overridden.
- An absent, malformed, or empty remote mapping does not borrow the controller's global `config.agents` paths.
- A configured node executable outside PATH is selected during bootstrap and receiver execution.
- A Node runtime below 18 fails with stable code and exit status.

---

### Task 1: First-Push Receiver Mapping

**Files:** `src/core/sync_engine.ts`, `src/core/server.ts`, `tests/integration/sync-engine.test.ts`, `tests/unit/server.test.ts`

- [x] Add a fake-runtime regression test for first push with two skills targeted to different remote agents; assert payload `links` and persisted local backup.
- [x] Add a regression assertion that explicit backup values remain unchanged when config contains conflicting targets.
- [x] Seed a missing backup in memory from `server.remote_agents`, merge configured included links, and persist only outside dry-run when a mapping was materialized.
- [x] Run focused unit and integration tests.

### Task 2: Compatible Migrated Agent Map

**Files:** `src/config/types.ts`, `src/config/config.ts`, `tests/unit/config.test.ts`, `tests/integration/sync-engine.test.ts`

- [x] Test `servers.<name>.agents` as a string path map and malformed values; explicit `remote_agents` wins when present.
- [x] Normalize only the verified legacy map into `ConfiguredServer.remote_agents`.
- [x] Verify payload has remote agent paths when the legacy field is used.

### Task 3: Configured Remote Node

**Files:** `src/core/transport.ts`, `src/receiver/bootstrap_remote.sh`, `src/receiver/sync_receiver.mjs`, `src/index.ts`, `tests/integration/transport-server-config.test.ts`, `tests/integration/server-cli.test.ts`, `tests/integration/help-output.test.ts`, `tests/unit/receiver-node-version.test.ts`, `tests/unit/docs.test.ts`, `docs/config-guide.md`, `docs/usage-guide.md`, `README.md`

- [x] Add tests for CLI `remote add --node-bin` merge behavior and bootstrap using a local fake executable outside PATH.
- [x] Pass `SYNCSKILL_NODE_BIN` to bootstrap and validate that exact executable; keep receiver invocation on the same `node_bin`.
- [x] Add a receiver guard for Node <18 with `E_RECEIVER_NODE_TOO_OLD` and exit 8, covered by a focused test.
- [x] Document `node_bin` and nvm/fnm/volta usage in the remote configuration docs and README.
- [x] Run focused tests and build; inspect the complete diff and leave changes in the isolated worktree without commit or push.
