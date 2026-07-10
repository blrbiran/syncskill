# Shared `agents` Contract Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the main spec, user-facing docs, bundled skill doc, and help-facing contract tests with the current shared local target `agents` behavior.

**Architecture:** Treat the current implementation as canonical for shared local target handling, then update only the contract surfaces directly affected by that behavior. Keep the scope narrow: verify behavior-test coverage first, update the main spec and docs where shared-link semantics drifted, and only touch CLI help if a real contradiction exists.

**Tech Stack:** TypeScript CLI (`commander`, `vitest`), Markdown docs, bundled skill prompt docs

## Global Constraints

- Shared local target `agents` is in scope as a first-class local link target.
- `syncskill install` default local link behavior where `config.links[*]` may include `"agents"` is in scope.
- `syncskill link build` materialization and stale cleanup behavior for `~/.agents/skills/` is in scope.
- `syncskill link list` / `link ls` realized-status behavior for shared links is in scope.
- `syncskill link edit`, `link remove`, `link clear`, and `unlink` behavior as it relates to `agents` is in scope.
- Shared-vs-private agent semantics are in scope only where they affect user-visible explanation.
- Do not expand into unrelated install/link wording drift not caused by shared `agents` behavior.
- Do not do remote/server/receiver documentation cleanup.
- Do not do structural rewrites of docs.
- Do not add new features or command-surface changes.
- Only add tests that directly protect the shared `agents` contract.
- If existing shared-`agents` behavior is already covered by targeted unit/integration tests, prefer updating docs/help contract tests over adding more behavior tests.
- Only change CLI help text if the current wording contradicts the shared-target behavior.

---

## File Map

- Modify: `docs/superpowers/specs/syncskill-design.md` — canonical behavior spec; fix shared-target semantics that still describe the pre-fix model.
- Modify: `docs/config-guide.md` — config field semantics for `agents`, `private_agents`, and `links`.
- Modify: `docs/design-guide.md` — high-level design explanation for shared vs private local targets.
- Modify: `docs/usage-guide.md` — user workflows and examples for install/link/list/remove/build.
- Modify: `docs/README.md` — docs entrypoint summary language that mentions shared linking.
- Modify: `README.md` — top-level quickstart/install/link explanations.
- Modify: `skills/syncskill/SKILL.md` — bundled skill guidance for target names and declarative link flows.
- Modify: `tests/unit/docs.test.ts` — stable substring assertions for docs surfaces.
- Review-only unless contradiction is found: `src/index.ts` — help descriptions.
- Review-only unless contradiction is found: `tests/integration/help-output.test.ts` — help-surface contract tests.
- Review-only for coverage audit: `tests/unit/linker.test.ts`, `tests/integration/config-cli.test.ts`, `tests/integration/config-ui.test.ts`, `tests/integration/source-cli.test.ts`, `tests/integration/install-cli.test.ts`.

### Task 1: Audit shared-`agents` coverage and align the main spec + core guides

**Files:**
- Modify: `docs/superpowers/specs/syncskill-design.md`
- Modify: `docs/config-guide.md`
- Modify: `docs/design-guide.md`
- Modify: `docs/usage-guide.md`
- Modify: `tests/unit/docs.test.ts`
- Review-only: `tests/unit/linker.test.ts`
- Review-only: `tests/integration/config-cli.test.ts`
- Review-only: `tests/integration/config-ui.test.ts`
- Review-only: `tests/integration/source-cli.test.ts`
- Review-only: `tests/integration/install-cli.test.ts`

**Interfaces:**
- Consumes: current shared-target behavior already exercised by `linker`, `config-cli`, `config-ui`, `source-cli`, and `install-cli` regression suites.
- Produces: canonical spec wording and docs-test assertions that describe `agents` as a first-class shared local target at `~/.agents/skills/`.

- [ ] **Step 1: Audit existing behavior coverage before adding more tests**

Read the existing shared-target behavior tests and confirm they already cover all six bullets from the approved design spec:

```text
- Shared-link materialization to ~/.agents/skills/
- Shared-link JSON/result summaries
- Shared stale-link cleanup
- Shared target visibility in link list / link ls
- Shared target handling in link remove / unlinkSkillFromAgent
- Shared target visibility in the local matrix/UI path
```

Files to inspect:

```text
tests/unit/linker.test.ts
tests/integration/config-cli.test.ts
tests/integration/config-ui.test.ts
tests/integration/source-cli.test.ts
tests/integration/install-cli.test.ts
```

Expected audit outcome:

```text
All six shared-`agents` behaviors are already covered.
Do not add more behavior tests in this task.
```

- [ ] **Step 2: Add failing docs contract assertions for the core guides**

Update `tests/unit/docs.test.ts` with stable substring checks for the new shared-target wording. Add assertions like these inside the existing `top-level docs exist and link the expected entrypoints` test:

```ts
expect(configGuide).toContain('The special target name `agents` means the shared `~/.agents/skills/` directory.');
expect(configGuide).toContain('Unlike named entries under `config.agents`, `"agents"` does not need its own `config.agents.agents` mapping.');
expect(configGuide).toContain('`private_agents` lists agents that still need dedicated per-agent links in addition to the shared target.');

expect(usageGuide).toContain('`agents` is a valid local target name for the shared `~/.agents/skills/` directory.');
expect(usageGuide).toContain('syncskill link remove welcome agents');
expect(usageGuide).toContain('`link list` shows realized shared links under `~/.agents/skills/` as well as named agent directories.');

expect(designGuide).toContain('The shared local target `agents` resolves directly to `~/.agents/skills/`.');
expect(designGuide).toContain('Local materialization and realized-status paths understand `agents` directly rather than requiring `config.agents.agents`.');
```

- [ ] **Step 3: Run the docs test to verify it fails**

Run:

```bash
cd /Users/biran/code/skills/syncskill && npx vitest run tests/unit/docs.test.ts
```

Expected:

```text
FAIL
...toContain(...shared `~/.agents/skills/` wording...)
```

- [ ] **Step 4: Write the minimal spec and guide updates**

For `docs/superpowers/specs/syncskill-design.md`, replace the old shared-target assumptions with wording equivalent to:

```md
- `agents` is a first-class shared local target that resolves to `~/.agents/skills/`.
- Local materialization, realized-status display, and stale-link cleanup understand `agents` directly.
- `agents` does not require a `config.agents.agents` entry to be usable as a local target.
- `link list` / `link ls` includes realized shared links under `~/.agents/skills/`.
- `link edit`, `link remove`, `link clear`, and `unlink` may operate on the shared target name `agents`.
```

For `docs/config-guide.md`, add or revise wording near the `agents`, `private_agents`, and `links` sections to:

```md
The special target name `agents` means the shared `~/.agents/skills/` directory.
Unlike named entries under `config.agents`, `"agents"` does not need its own `config.agents.agents` mapping.

`private_agents` lists agents that still need dedicated per-agent links because they do not read from the shared `~/.agents/skills/` directory.

In `links`, a skill can target `"agents"`, one or more named agents, or both.
For example, `"welcome": ["agents", "claude"]` links the skill into the shared directory and also into Claude's private skills directory.
```

For `docs/design-guide.md`, add or revise a paragraph like:

```md
The shared local target `agents` resolves directly to `~/.agents/skills/` and is treated as a first-class target in local materialization, status, and cleanup flows. Named local agents still come from `config.agents`, while `private_agents` identifies agents that require dedicated per-agent links instead of relying only on the shared directory.
```

For `docs/usage-guide.md`, add or revise wording like:

```md
`agents` is a valid local target name for the shared `~/.agents/skills/` directory.
Default local linking may produce `Linked to: agents, <private-agent>` when a skill is linked into the shared directory plus one or more private agent homes.
`link list` / `link ls` shows realized shared links under `~/.agents/skills/` as well as named agent directories.
You can remove the shared link explicitly with `syncskill link remove <skill> agents`.
```

- [ ] **Step 5: Run the docs test to verify it passes**

Run:

```bash
cd /Users/biran/code/skills/syncskill && npx vitest run tests/unit/docs.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit the spec + core guides alignment**

```bash
git add docs/superpowers/specs/syncskill-design.md docs/config-guide.md docs/design-guide.md docs/usage-guide.md tests/unit/docs.test.ts
git commit -m "docs: align shared agents contract in spec and guides"
```

### Task 2: Align README surfaces and bundled skill doc

**Files:**
- Modify: `docs/README.md`
- Modify: `README.md`
- Modify: `skills/syncskill/SKILL.md`
- Modify: `tests/unit/docs.test.ts`

**Interfaces:**
- Consumes: canonical shared-target wording from Task 1.
- Produces: top-level docs and bundled skill guidance that use the same `agents` vocabulary and examples as the spec.

- [ ] **Step 1: Add failing docs assertions for README surfaces and bundled skill doc**

Extend `tests/unit/docs.test.ts` with assertions like these:

```ts
expect(readme).toContain('The shared local target `agents` maps to `~/.agents/skills/`.');
expect(readme).toContain('Default local linking may use `agents` plus detected `private_agents`.');
expect(readme).toContain('syncskill link remove welcome agents');

expect(docsReadme).toContain('The shared local target `agents` resolves to `~/.agents/skills/`.');

expect(skillDoc).toContain('`agents` is a valid local target name for the shared `~/.agents/skills/` directory.');
expect(skillDoc).toContain('Use `link remove <skill> agents` to drop only the shared link.');
```

- [ ] **Step 2: Run the docs test to verify it fails**

Run:

```bash
cd /Users/biran/code/skills/syncskill && npx vitest run tests/unit/docs.test.ts
```

Expected:

```text
FAIL
...missing shared `agents` wording in README/docs README/SKILL.md...
```

- [ ] **Step 3: Write the minimal README and bundled-skill updates**

For `README.md`, add or revise text like:

```md
The shared local target `agents` maps to `~/.agents/skills/`.
Default local linking may use `agents` plus any detected `private_agents`, so output can look like `Linked to: agents, claude`.
You can remove only the shared link with `syncskill link remove <skill> agents`.
```

For `docs/README.md`, add a concise summary line like:

```md
Shared local links use the target name `agents`, which resolves to `~/.agents/skills/` and appears in realized link status output.
```

For `skills/syncskill/SKILL.md`, add or revise wording like:

```md
`agents` is a valid local target name for the shared `~/.agents/skills/` directory.
When a skill targets both the shared directory and one or more private agents, commands may report output like `Linked to: agents, claude`.
Use `link remove <skill> agents` to remove only the shared local link.
```

- [ ] **Step 4: Run the docs test to verify it passes**

Run:

```bash
cd /Users/biran/code/skills/syncskill && npx vitest run tests/unit/docs.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 5: Commit the README + bundled skill alignment**

```bash
git add docs/README.md README.md skills/syncskill/SKILL.md tests/unit/docs.test.ts
git commit -m "docs: align shared agents wording across readmes"
```

### Task 3: Audit CLI help and run the final contract suite

**Files:**
- Review-only unless contradiction is found: `src/index.ts`
- Review-only unless contradiction is found: `tests/integration/help-output.test.ts`
- Test: `tests/integration/help-output.test.ts`
- Test: `tests/unit/docs.test.ts`
- Test: `tests/unit/linker.test.ts`
- Test: `tests/integration/config-cli.test.ts`
- Test: `tests/integration/config-ui.test.ts`
- Test: `tests/integration/source-cli.test.ts`
- Test: `tests/integration/install-cli.test.ts`

**Interfaces:**
- Consumes: final doc wording from Tasks 1-2 and the already-canonical shared-target behavior in the implementation.
- Produces: a verified decision that CLI help either stayed unchanged because it was already accurate, or was minimally corrected and regression-tested.

- [ ] **Step 1: Audit the relevant help surfaces before changing anything**

Run:

```bash
cd /Users/biran/code/skills/syncskill && \
node dist/index.js --help && \
node dist/index.js install --help && \
node dist/index.js link --help && \
node dist/index.js link list --help && \
node dist/index.js link remove --help
```

Use this rule while reading the output:

```text
Only change help if it explicitly contradicts shared `agents` behavior.
If a help surface does not mention target semantics at all, leave it unchanged.
```

Expected audit outcome:

```text
No help change is needed unless a surface explicitly claims that local targets must come only from config.agents or otherwise hides valid shared-target behavior.
```

- [ ] **Step 2: If a contradiction exists, add a failing help assertion first**

If Step 1 finds a real contradiction, add a focused assertion to `tests/integration/help-output.test.ts`. Example shape:

```ts
expect(stdout).toContain('agents');
expect(stdout).toContain('shared ~/.agents/skills target');
```

If Step 1 finds no contradiction, skip this step and leave both `src/index.ts` and `tests/integration/help-output.test.ts` unchanged.

- [ ] **Step 3: If needed, apply the minimal help-text fix**

If Step 2 was necessary, update only the relevant `commander` description in `src/index.ts`. Example pattern:

```ts
.description('Remove agents from skill targets (including the shared "agents" target)')
```

If help did not need correction, do not modify `src/index.ts`.

- [ ] **Step 4: Build and run the full targeted contract suite**

Run:

```bash
cd /Users/biran/code/skills/syncskill && npm run build && npx vitest run tests/unit/docs.test.ts tests/integration/help-output.test.ts tests/unit/linker.test.ts tests/integration/config-cli.test.ts tests/integration/config-ui.test.ts tests/integration/source-cli.test.ts tests/integration/install-cli.test.ts
```

Expected:

```text
> syncskill@0.1.0 build
> tsc -p tsconfig.build.json && shx cp -r skills dist/

PASS
```

- [ ] **Step 5: Commit the final contract verification (and help change if any)**

If `src/index.ts` or `tests/integration/help-output.test.ts` changed:

```bash
git add src/index.ts tests/integration/help-output.test.ts tests/unit/docs.test.ts
git commit -m "docs: align shared agents help contract"
```

If help stayed unchanged, commit only the verification-bearing doc/test changes from earlier tasks that remain uncommitted:

```bash
git add tests/unit/docs.test.ts
git commit -m "test: lock shared agents docs contract"
```
