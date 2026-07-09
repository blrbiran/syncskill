# Install Docs and Help Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align install-related spec wording, CLI help, user-facing docs, and the bundled `skills/syncskill` skill with the current verified install/GitHub tree URL behavior.

**Architecture:** First tighten the canonical contract in the main spec for the two known drift points: text install output (`Installed` / `Already installed` / `No skills installed`) and the relationship between single-skill installs and execute-phase `skill-selection`. Then mirror that contract into one source of truth for CLI help (`src/index.ts`) plus the help-facing tests, and finally update the user-facing documentation surfaces (`README.md`, `docs/*.md`, `skills/syncskill/SKILL.md`) so they all describe the same verified behavior.

**Tech Stack:** TypeScript CLI (commander + Vitest), Markdown docs, OpenWolf project memory.

## Global Constraints

- Follow `docs/superpowers/specs/syncskill-design.md` as the primary spec, but only sync docs/help to verified code semantics.
- Keep documentation outside `docs/superpowers/specs/` in English; spec and audit notes under `docs/superpowers/specs/` remain Chinese.
- Preserve the current verified install behavior: GitHub tree/subdir URLs use `basename(source.path)` when the requested subdir root itself contains `SKILL.md`.
- Preserve the current verified duplicate-install behavior: same-repo / duplicate installs must surface `already_installed` semantics instead of a misleading silent no-op.
- Do not broaden this milestone into source-discovery redesign, link-status redesign, or unrelated remote/config changes.
- Use TDD for any help-facing or docs-facing contract change that requires code/test edits.
- Validate any CLI help copy changes with focused help tests before broader docs assertions.

---

## File Map

- Modify: `docs/superpowers/specs/syncskill-design.md` — tighten the canonical contract for install output wording and clarify single-skill vs execute-phase `skill-selection` semantics.
- Modify: `src/index.ts` — update install/help descriptions only if the verified contract and current help copy diverge.
- Modify: `tests/integration/help-output.test.ts` — lock any changed help wording or newly documented install contract copy.
- Modify: `README.md` — top-level install/source/help narrative and quick-start examples.
- Modify: `docs/README.md` — docs index + install UX quick links.
- Modify: `docs/usage-guide.md` — command workflows and install behavior examples.
- Modify: `docs/config-guide.md` — only if install/source config wording needs clarification (`sources[*].path`, `ignore`, receiver backup mentions).
- Modify: `docs/design-guide.md` — architecture-level install/source behavior summary, not full spec duplication.
- Modify: `skills/syncskill/SKILL.md` — packaged operator skill quick reference and reminders.
- Modify: `tests/unit/docs.test.ts` — doc contract assertions for any changed public wording.
- Modify: `.wolf/memory.md` — append one-line OpenWolf action log after the work.
- Modify: `.wolf/cerebrum.md` — only if the work reveals a lasting docs/help convention not already captured.

## Task 1: Tighten the spec’s install/help contract

**Files:**
- Modify: `docs/superpowers/specs/syncskill-design.md`

**Interfaces:**
- Consumes: Verified current behavior from `src/source.ts`, `src/install.ts`, `src/index.ts`, and the audit conclusions already established in session.
- Produces: Canonical wording for (a) install text output states, and (b) single-skill vs execute-phase `skill-selection` semantics, which later tasks mirror into help/docs/tests.

- [ ] **Step 1: Identify the exact spec sections to update**

Read and target these sections in `docs/superpowers/specs/syncskill-design.md`:

- `1437-1506` — install behavior, single vs multiple skill, same-repo merge cases
- `3006-3025` — JSON result contract (`skills.already_installed`)
- `1039-1045` — existing install output examples

Expected update scope:
- Add explicit text-output contract for:
  - `Installed <N> skill(s)`
  - `Already installed: <names>`
  - `No skills installed.`
- Clarify that the **runtime behavior** is:
  - single discovered skill on first install installs directly (no user prompt)
  - `skill-selection` unresolved exists only when a real user choice remains after execution-time discovery
- If current code still models local-source unresolved more broadly, note that as current implementation detail only if verified during Task 2; do not silently contradict current code.

- [ ] **Step 2: Edit the spec with explicit wording**

Add concise Chinese wording in the relevant sections. Use wording along these lines:

```md
文本输出约定：
- 本次新装出至少 1 个 skill：输出 `Installed <N> skill(s)`
- 本次没有新装，但请求范围内的 skill 已全部存在：输出 `Already installed: <skill-a>, <skill-b>`
- 本次既没有新装，也没有命中已安装 skill（例如用户在可选列表中全取消）：输出 `No skills installed.`
```

And for single-skill install semantics:

```md
首次安装发现单个 skill 时，不产生用户决议项，直接安装。
仅当执行期枚举后发现多个可选 skill 且需要用户子集选择时，才保留 `skill-selection` unresolved。
```

- [ ] **Step 3: Self-check the spec edit**

Verify inline that the spec now answers:
- What should text mode say for duplicate install?
- When does `skill-selection` exist vs not exist?
- Does the JSON `already_installed` section still match the text contract?

Expected result: no contradiction between the behavioral section and the JSON result section.

## Task 2: Align CLI help text and help tests to the tightened contract

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/integration/help-output.test.ts`

**Interfaces:**
- Consumes: Task 1 spec wording, existing commander help definitions in `src/index.ts`.
- Produces: Updated CLI help surface and locked tests for stable install wording.

- [ ] **Step 1: Write the failing help test if wording changes are required**

Add or update one focused test in `tests/integration/help-output.test.ts` that asserts the stable install-help wording you want users to rely on.

Use this structure if the help wording changes:

```ts
it('install help describes subdir installs and built-in self flow clearly', async () => {
  const { stdout } = await execAsync('node', ['dist/index.js', 'install', '--help'], {
    cwd: '/Users/biran/code/skills/syncskill'
  });

  expect(stdout).toContain('Use "self" for built-in skill; URL/path for external source');
  expect(stdout).toContain('--path <path>');
  expect(stdout).toContain('Repo-relative subdirectory within source containing skills');
});
```

- [ ] **Step 2: Run the focused help test to verify current behavior**

Run:

```bash
npx vitest run tests/integration/help-output.test.ts -t "install help"
```

Expected:
- PASS if current help already matches the intended contract
- FAIL only if wording still diverges from the spec text you just tightened

- [ ] **Step 3: Update `src/index.ts` only if the test failed**

Relevant install help definitions live near:
- `src/index.ts:1415-1421`

If needed, keep the code change minimal, for example:

```ts
.description('Install skill(s). Use "self" for built-in skill; URL/path for external source')
.option('--path <path>', 'Repo-relative subdirectory within source containing skills')
.option('--skill-subdir <dir>', 'Alias for --path')
.option('--type <type>', 'Source type: git, http, or local')
```

Do not change runtime behavior in this task — help text only.

- [ ] **Step 4: Re-run the focused help test**

Run:

```bash
npx vitest run tests/integration/help-output.test.ts -t "install help"
```

Expected: PASS

- [ ] **Step 5: Run the full help-output suite**

Run:

```bash
npx vitest run tests/integration/help-output.test.ts
```

Expected: PASS with no unrelated help regressions.

## Task 3: Update README, docs index, and usage guide for install behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/usage-guide.md`
- Modify: `tests/unit/docs.test.ts`

**Interfaces:**
- Consumes: Task 1 canonical contract and Task 2 verified help wording.
- Produces: User-facing install docs that match the verified CLI/help behavior.

- [ ] **Step 1: Write/adjust docs contract assertions first**

Extend `tests/unit/docs.test.ts` with focused assertions for the wording you expect to appear after the docs sync. Keep them stable and substring-based.

Add assertions like:

```ts
expect(readme).toContain('Repeated installs from the same git or HTTP source reuse the existing source entry.');
expect(readme).toContain('If the requested skills are already present, syncskill reports them as already installed instead of treating the install as a silent no-op.');
expect(skillDoc).toContain('Repeated installs from the same source reuse the recorded source entry.');
```

Do **not** assert full paragraphs.

- [ ] **Step 2: Run docs test to verify it fails (if you added new assertions)**

Run:

```bash
npx vitest run tests/unit/docs.test.ts
```

Expected: FAIL on the new assertions until the docs are updated.

- [ ] **Step 3: Update `README.md`**

Touch these areas:
- Quick Start install examples
- “Source Management” section
- Repeated install / same-source reuse explanation

Add wording that explicitly covers:
- `install` with no target shows help
- `install <url-or-path> --path <dir>` means repo-relative subdirectory inside the source checkout
- repeated installs from the same source reuse and expand the existing source entry
- when the requested skill already exists, syncskill reports it as already installed

- [ ] **Step 4: Update `docs/README.md`**

Refresh the quick links and install UX summary so it points users to the right guide sections for:
- install help behavior
- plan/apply with install
- same-source reuse / subdir installs
- already-installed reporting

- [ ] **Step 5: Update `docs/usage-guide.md`**

Update only the install/source workflow sections. Make sure it clearly explains:
- bare repo URL vs GitHub tree URL behavior
- `--path` / `--skill-subdir` meaning
- first install: single skill installs directly; multiple skills can require selection
- repeated installs from same source reuse the source record and may widen `config.sources[*].path`
- duplicate install surfaces already-installed instead of silent no-op

- [ ] **Step 6: Re-run docs test**

Run:

```bash
npx vitest run tests/unit/docs.test.ts
```

Expected: PASS

## Task 4: Update config/design guide and bundled skill reference

**Files:**
- Modify: `docs/config-guide.md`
- Modify: `docs/design-guide.md`
- Modify: `skills/syncskill/SKILL.md`
- Modify: `tests/unit/docs.test.ts`

**Interfaces:**
- Consumes: Task 1 canonical wording and Task 3 docs wording.
- Produces: Deeper reference docs and bundled skill quick reference that stay aligned with README/help.

- [ ] **Step 1: Add stable docs assertions for deeper references**

Extend `tests/unit/docs.test.ts` with stable expectations for the deeper docs if they are not already covered:

```ts
expect(configGuide).toContain('`config.sources[*].path` stores the relative source-root subdirectory currently managed for that source.');
expect(designGuide).toContain('Repeated installs from the same source widen or reuse the recorded source path instead of creating duplicate source entries.');
expect(skillDoc).toContain('If requested skills already exist locally, syncskill reports them as already installed.');
```

- [ ] **Step 2: Run docs test to verify it fails (if needed)**

Run:

```bash
npx vitest run tests/unit/docs.test.ts
```

Expected: FAIL only on the new assertions.

- [ ] **Step 3: Update `docs/config-guide.md`**

Limit changes to source/install-related config explanation:
- clarify `config.sources[*].path`
- clarify `ignore[]` semantics for out-of-scope or deselected skills
- do not broaden into unrelated config topics

- [ ] **Step 4: Update `docs/design-guide.md`**

Mirror the implementation-level install contract at a high level:
- GitHub tree/subdir URLs feed the source subdirectory scope
- root skill naming for subdir roots follows directory basename
- same-source installs reuse and widen source scope rather than duplicating entries
- duplicate installs report already-installed state

- [ ] **Step 5: Update `skills/syncskill/SKILL.md`**

Keep the skill concise but accurate. Update the quick-reference install section and reminders so an agent reading the skill learns:
- install no-target shows help
- `--path` / `--skill-subdir` meaning
- plan/apply flow for external installs
- repeated installs from the same source reuse one source entry
- duplicate installs surface already-installed status

- [ ] **Step 6: Re-run docs test**

Run:

```bash
npx vitest run tests/unit/docs.test.ts
```

Expected: PASS

## Task 5: End-to-end verification and OpenWolf bookkeeping

**Files:**
- Modify: `.wolf/memory.md`
- Modify: `.wolf/cerebrum.md` (only if a durable docs/help convention was learned)

**Interfaces:**
- Consumes: All prior task outputs.
- Produces: Verified final state plus OpenWolf memory entries.

- [ ] **Step 1: Run the focused verification suite**

Run:

```bash
npx vitest run tests/integration/help-output.test.ts tests/unit/docs.test.ts tests/integration/install-cli.test.ts -t "already-installed|install help|does not require resolutions|merges same-repo"
npm run build
```

Expected:
- help tests PASS
- docs tests PASS
- targeted install regressions PASS
- build PASS

- [ ] **Step 2: Manually inspect generated help output**

Run:

```bash
node dist/index.js install --help
node dist/index.js --help
```

Confirm:
- install wording matches Task 1/2 contract
- no removed flags or stale wording reappeared

- [ ] **Step 3: Append OpenWolf memory entry**

Append one line to `.wolf/memory.md` in the current session table, for example:

```md
| HH:MM | Synced install/spec/help docs and tests for GitHub tree URL + already-installed behavior | `docs/*`, `README.md`, `skills/syncskill/SKILL.md`, `tests/{unit/docs,integration/help-output}.test.ts` | docs/help/build verification passed | ~tokens |
```

- [ ] **Step 4: Update `.wolf/cerebrum.md` only if a durable rule emerged**

If you learned a reusable convention (for example, that help/docs contract changes should always be locked by both `help-output.test.ts` and `docs.test.ts`), add one short item under `## Key Learnings`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/syncskill-design.md src/index.ts tests/integration/help-output.test.ts README.md docs/README.md docs/usage-guide.md docs/config-guide.md docs/design-guide.md skills/syncskill/SKILL.md tests/unit/docs.test.ts .wolf/memory.md .wolf/cerebrum.md
git commit -m "docs: align install docs and help contracts"
```

## Self-Review Checklist

- Spec coverage: Tasks 1-4 cover the two known drift points (install text output and single-skill vs `skill-selection`) plus every requested docs/help surface.
- Placeholder scan: No TBD/TODO placeholders remain; every task names exact files and commands.
- Type consistency: Uses the existing public names consistently — `alreadyInstalledSkills`, `skills.already_installed`, `--path`, `--skill-subdir`, `install [url-or-path]`.

Plan complete and saved to `docs/superpowers/plans/2026-07-09-install-docs-help-alignment.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**