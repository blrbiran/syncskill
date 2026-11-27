# Link Target Changes Implementation Plan

> **For agentic workers:** Follow this plan task-by-task using `superpowers:executing-plans`.

**Goal:** Make `link set` and `link add` refuse before any persistent change when stale-link cleanup needs confirmation that is unavailable.

**Architecture:** Detect stale links against the proposed target configuration before saving it or creating new links. In non-interactive mode without `-y`, refuse with exit 4 and preserve the config and filesystem; with `-y`, keep the existing completed transition behavior.

**Tech Stack:** TypeScript, Vitest, Node filesystem APIs.

**Spec:** `orca_archived_files/issue-20261023.md`, issue #514 acceptance criteria. No separate design spec is needed for this narrow preflight.

## Global Constraints

- Tests use isolated temporary homes and never touch the user's syncskill configuration or agent directories.
- Leave interactive prompting and other link verbs unchanged.
- `-y` must still create the new link and remove stale managed links.

## Review Focus

- A stale link under a configured target directory is found from the proposed config before it is persisted.
- No stale link means non-interactive `link set` and `link add` keep their current successful behavior.
- `-y` still completes the target transition and removes the old symlink.
- Refusal preserves the exact config bytes and leaves both old and proposed target directories unchanged.

---

### Task 1: Preflight stale-link confirmation for target changes

**Files:**
- Modify: `src/linker.ts` (`findStaleLinks` accepts an optional already-loaded configuration)
- Modify: `src/index.ts` (`link set` and `link add` preflight proposed links before save/apply)
- Test: `tests/integration/reconciliation-cli.test.ts`

**Interfaces:**
- `findStaleLinks(homeDir, skillNames, configOverride?)` scans using `configOverride` when supplied; other callers keep the existing two-argument behavior.
- A local preflight helper receives the proposed `SyncSkillConfig`, one skill name, and `{yes}`; with stale links and no `-y` in non-interactive mode it invokes the existing `failForNoInteractive` before any write.

- [x] **Step 1: Add failing integration coverage** for both `link set` and `link add`: non-interactive with stale old targets and no `-y` returns exit 4, preserves exact `config.json` bytes, keeps the old symlink, and creates no new symlink. Add the positive `-y` assertion that only the new target remains.
- [x] **Step 2: Run the focused integration test**

Run: `npm run test:integration -- --run tests/integration/reconciliation-cli.test.ts -t 'link set|link add'`
Expected: the no-`-y` cases fail because `config.json` is already rewritten and the proposed link already exists.

- [x] **Step 3: Implement proposed-config stale-link preflight** and call it from both `link set` and `link add` before `saveConfig`.
- [x] **Step 4: Run the focused integration tests**

Run: `npm run test:integration -- --run tests/integration/reconciliation-cli.test.ts -t 'link set|link add'`
Expected: all selected cases pass.

- [x] **Step 5: Run the unit gate and build**

Run: `npm test -- --run tests/unit` and `npm run build`
Expected: both exit 0.

- [x] **Step 6: Commit the implementation and tests**

Use a message naming issue #514 and keep the plan document in a separate documentation commit after the feature commit.
