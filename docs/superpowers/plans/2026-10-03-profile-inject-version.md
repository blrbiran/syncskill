# Profiles, Per-Run Injection and Recorded Source Commits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named skill profiles to `config.json`, an `inject` command that copies a skill set as a snapshot into any directory with a lock file, and a recorded `resolved_commit` for git sources.

**Architecture:** `profiles` becomes a first-class key of `SyncSkillConfig` (validated, defaulted). A new module `src/inject.ts` holds the pure lock assembly and the staged copy; `src/index.ts` registers `profile set|ls|rm` and `inject` and maps the module's coded errors through the existing `failWithOutputError`. `syncSource` records `git rev-parse HEAD` into `.sources/<name>/state.json`.

**Tech Stack:** TypeScript (ESM, Node 22), commander, vitest. Build: `npm run build` (tsc + copy skills).

**Spec:** `docs/superpowers/specs/2026-10-03-profile-inject-version-design.md` (read it; §5 and §7 are normative).

## Global Constraints

- Work directly on `main` (human ruling 2026-10-03). One commit per task. Commit messages in English, ending with the two trailer lines given by the controller.
- Code, comments, commit messages: English. Default: no comments; one short line only when the reason is not obvious (AGENTS.md).
- Never touch the real `~/.syncskill` or any real agent skill dir. Every test that runs the CLI sets `HOME` and `USERPROFILE` to a `mkdtemp` dir. `--sync-dir`/`SYNCSKILL_DIR` do NOT relocate anything (spec §2) — do not rely on them.
- Exit codes: no new codes. `E_SKILL_NOT_FOUND` and `E_PROFILE_NOT_FOUND` → 2; `E_USAGE_*` → 2 (prefix rule already in `src/cli/exit-codes.ts`); `E_TARGET_OCCUPIED` → 7 (added next to `E_CONFLICT`).
- Profile name rule: `/^[a-zA-Z0-9_-]+$/` (same as `SAFE_SKILL_NAME` in `src/core/transport.ts`).
- Lock file name: `syncskill-lock.json`; schema string `syncskill-lock-v1`; staging dir `.syncskill-inject-<pid>` inside the target.
- Per-task gate: `npm run test:unit` and `npm run build` both exit 0. Integration tests need a fresh `npm run build` first (they run `dist/index.js`).
- Do not use `rm -rf` on anything outside a test's own temp dir. `.wolf/memory.md` and `.wolf/buglog.json` are never committed.

## Review Focus

1. A skill whose managed path is itself a symlink (local archive sources) — inject must copy contents, not the link (pinned by integration test 7 in Task 4, via a symlinked file inside a skill; and the dereference copy covers the root).
2. A second `inject` into a target that already holds only the lock file — must refuse with 7 and leave the lock bytes unchanged (integration test 8, Task 4).
3. A config save by an unrelated command after `profile set` — profiles must survive (integration test 1, Task 4, via `config set`).
4. `--skills` with duplicates and unsorted names — lock lists them sorted and unique (integration test 3, Task 4).
5. A git source updated after install — `resolved_commit` must follow the new HEAD (integration test 2, Task 2).

---

### Task 1: `profiles` in the config schema

**Files:**
- Modify: `src/config/types.ts` (`SyncSkillConfig`)
- Modify: `src/config/config.ts` (`createDefaultConfig`, `validateConfig`, new `normalizeProfiles`, new exported `PROFILE_NAME_PATTERN`)
- Test: `tests/unit/config-profiles.test.ts` (new)

**Interfaces:**
- Produces: `SyncSkillConfig.profiles: Record<string, string[]>` (always present after `validateConfig`/`createDefaultConfig`); `export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/` from `src/config/config.ts`.

- [ ] **Step 1: Write the failing test** — `tests/unit/config-profiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDefaultConfig, validateConfig, PROFILE_NAME_PATTERN } from '../../src/config/config.js';

const base = { version: 1, agents: {}, links: {} };

describe('config profiles', () => {
  it('keeps profiles through validation, sorted and de-duplicated', () => {
    const config = validateConfig({ ...base, profiles: { review: ['b', 'a', 'b'], empty: [] } });
    expect(config.profiles).toEqual({ review: ['a', 'b'], empty: [] });
  });

  it('drops non-string members and non-array values', () => {
    const config = validateConfig({ ...base, profiles: { mixed: ['a', 3, null], broken: 'x' } });
    expect(config.profiles).toEqual({ mixed: ['a'], broken: [] });
  });

  it('defaults to an empty object when missing or not an object', () => {
    expect(validateConfig(base).profiles).toEqual({});
    expect(validateConfig({ ...base, profiles: ['x'] }).profiles).toEqual({});
    expect(createDefaultConfig().profiles).toEqual({});
  });

  it('names follow the safe skill name rule', () => {
    expect(PROFILE_NAME_PATTERN.test('review_1-a')).toBe(true);
    expect(PROFILE_NAME_PATTERN.test('.hidden')).toBe(false);
    expect(PROFILE_NAME_PATTERN.test('a/b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/config-profiles.test.ts`
Expected: FAIL (`profiles` undefined / `PROFILE_NAME_PATTERN` not exported).

- [ ] **Step 3: Implement**

In `src/config/types.ts`, add to `SyncSkillConfig` (after `links`):

```ts
  profiles: Record<string, string[]>;
```

In `src/config/config.ts`:

```ts
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
```

`createDefaultConfig` returns `profiles: {}` (after `links: {}`). In `validateConfig`'s returned object add `profiles: normalizeProfiles(value.profiles),` after `links`. Add next to `normalizeLinks`:

```ts
function normalizeProfiles(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, skills]) => [
      name,
      [...new Set(Array.isArray(skills) ? skills.filter((skill): skill is string => typeof skill === 'string') : [])].sort()
    ])
  );
}
```

(Do not reuse `normalizeStringArray` unless reading it shows identical semantics — sort + unique + strings only.)

- [ ] **Step 4: Fix type fallout and run the gate**

Any place constructing a `SyncSkillConfig` literal now needs `profiles` — run `npm run build` and add `profiles: {}` where tsc reports it (tests included: run `npx tsc --noEmit -p tsconfig.json` too).
Run: `npx vitest run tests/unit/config-profiles.test.ts && npm run test:unit && npm run build`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/config/types.ts src/config/config.ts tests/unit/config-profiles.test.ts <any files tsc required>
git commit -m "feat(config): keep named skill profiles in config.json"
```

---

### Task 2: record the resolved commit of git sources

**Files:**
- Modify: `src/source.ts` (`SourceState`, `normalizeSourceState`, `syncSource` around the `nextState` construction near `saveSourceState(homeDir, name, nextState)`)
- Test: `tests/unit/source-state-commit.test.ts` (new), `tests/integration/source-resolved-commit.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SourceState.resolved_commit: string | null`; `loadSourceState(homeDir, name)` (already exported) returns it; `export function normalizeSourceState(value: unknown): SourceState` (make it exported for the unit test).

- [ ] **Step 1: Write the failing unit test** — `tests/unit/source-state-commit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeSourceState } from '../../src/source.js';

const sha = 'a'.repeat(40);

describe('source state resolved_commit', () => {
  it('keeps a 40-hex lowercase commit', () => {
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: sha }).resolved_commit).toBe(sha);
  });

  it('reads a missing or malformed commit as null', () => {
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't' }).resolved_commit).toBeNull();
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: 'A'.repeat(40) }).resolved_commit).toBeNull();
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: 'abc' }).resolved_commit).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/unit/source-state-commit.test.ts` → FAIL (not exported / undefined).

- [ ] **Step 3: Implement**

`SourceState` gains `resolved_commit: string | null;`. `normalizeSourceState` (export it) returns additionally:

```ts
    resolved_commit: typeof value.resolved_commit === 'string' && /^[0-9a-f]{40}$/.test(value.resolved_commit)
      ? value.resolved_commit
      : null
```

In `syncSource`, where `nextState` is built:

```ts
  const nextState: SourceState = {
    materialized_skills: materializedSkills,
    updated_at: updatedAt,
    resolved_commit: source.type === 'git' ? await readGitHead(getGitCheckoutDir(homeDir, name)) : null
  };
```

and add near `runGit`:

```ts
async function readGitHead(checkoutDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}
```

(Use whatever `execFile` promise helper `src/source.ts` already imports for `runGit`; if `runGit` returns stdout, call `runGit(['-C', checkoutDir, 'rev-parse', 'HEAD'])` instead. Read `runGit` first.) Fix any other `SourceState` literal tsc reports.

- [ ] **Step 4: Write the integration test** — `tests/integration/source-resolved-commit.test.ts`. Copy the `createGitSourceFixture`, `git`, `commitAll` helpers verbatim from `tests/integration/install-cli.test.ts` (read them there). Test:

```ts
it('records the checkout HEAD after install and follows it after update', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-commit-'));
  tempDirs.push(homeDir);
  await mkdir(join(homeDir, '.syncskill'), { recursive: true });
  const agentDir = join(homeDir, '.claude', 'skills');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
    version: 1, agents: { claude: agentDir }, links: {}, servers: {}, sources: {}
  }));
  const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
  await mkdir(join(workRepoDir, 'skills', 'alpha'), { recursive: true });
  await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v1');
  await commitAll(workRepoDir, 'v1');
  await git(['push', '-u', 'origin', 'main'], workRepoDir);

  const install = await runCli(homeDir, ['install', bareRepoDir, '--name', 'demo', '--type', 'git', '--path', 'skills', '--yes']);
  expect(install.code).toBe(0);
  const head1 = (await git(['rev-parse', 'HEAD'], workRepoDir)).trim();
  const state1 = JSON.parse(await readFile(join(homeDir, '.syncskill', '.sources', 'demo', 'state.json'), 'utf8'));
  expect(state1.resolved_commit).toBe(head1);

  await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v2');
  await commitAll(workRepoDir, 'v2');
  await git(['push'], workRepoDir);
  const update = await runCli(homeDir, ['update', 'demo', '--yes']);
  expect(update.code).toBe(0);
  const head2 = (await git(['rev-parse', 'HEAD'], workRepoDir)).trim();
  expect(head2).not.toBe(head1);
  const state2 = JSON.parse(await readFile(join(homeDir, '.syncskill', '.sources', 'demo', 'state.json'), 'utf8'));
  expect(state2.resolved_commit).toBe(head2);
});
```

`runCli` is the helper from `tests/integration/link-build-cli.test.ts` (copy it; it runs `node dist/index.js` with `HOME`/`USERPROFILE`). If `install`/`update` need different flags to run non-interactively, read `syncskill install --help` / `update --help` output from `dist/index.js` and adjust the args — the assertions must not change. If the fixture's `git` helper returns `{stdout}` rather than a string, adapt the `.trim()` calls accordingly.

- [ ] **Step 5: Run** — `npm run build && npx vitest run tests/unit/source-state-commit.test.ts tests/integration/source-resolved-commit.test.ts && npm run test:unit` → exit 0.

- [ ] **Step 6: Commit** — `git add src/source.ts tests/unit/source-state-commit.test.ts tests/integration/source-resolved-commit.test.ts` then `git commit -m "feat(source): record the commit a git source was materialized from"`.

---

### Task 3: the inject module

**Files:**
- Create: `src/inject.ts`
- Modify: `src/linker.ts` (export `resolveConfiguredSkillSourceDir`)
- Test: `tests/unit/inject-lock.test.ts` (new)

**Interfaces:**
- Consumes: `resolveConfiguredSkillSourceDir(homeDir, skill): Promise<string>` (linker.ts, now exported); `hashSkillDirectory(dir): Promise<string>` (`src/core/manifest.ts`); `loadSkillOwnershipState(homeDir)` and `listSources(homeDir)` and `loadSourceState(homeDir, name)` (`src/source.ts`); `SourceState.resolved_commit` (Task 2).
- Produces (all exported from `src/inject.ts`):
  - `class InjectError extends Error { code: 'E_SKILL_NOT_FOUND' | 'E_TARGET_OCCUPIED'; }`
  - `interface LockSource { name: string; type: string; url: string; branch?: string }`
  - `interface LockSkill { name: string; source: LockSource | null; resolved_commit: string | null; content_md5: string }`
  - `interface SkillLock { schema: 'syncskill-lock-v1'; created_at: string; profile: string | null; skills: LockSkill[] }`
  - `const LOCK_FILE_NAME = 'syncskill-lock.json'`
  - `function normalizeSkillList(skills: string[]): string[]` (sort + unique)
  - `function buildLock(profile: string | null, skills: LockSkill[], createdAt: string): SkillLock` (sorts by name)
  - `async function injectSkills(homeDir: string, request: { skills: string[]; profile: string | null; target: string }): Promise<{ target: string; lockPath: string; lock: SkillLock }>`

- [ ] **Step 1: Write the failing unit test** — `tests/unit/inject-lock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildLock, normalizeSkillList } from '../../src/inject.js';

describe('inject lock assembly', () => {
  it('sorts and de-duplicates a requested skill list', () => {
    expect(normalizeSkillList(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('builds a v1 lock sorted by skill name, keeping null sources and an omitted branch', () => {
    const lock = buildLock(null, [
      { name: 'z', source: { name: 'src', type: 'local', url: '/x' }, resolved_commit: null, content_md5: 'm2' },
      { name: 'a', source: null, resolved_commit: null, content_md5: 'm1' }
    ], '2026-10-03T00:00:00.000Z');
    expect(lock).toEqual({
      schema: 'syncskill-lock-v1',
      created_at: '2026-10-03T00:00:00.000Z',
      profile: null,
      skills: [
        { name: 'a', source: null, resolved_commit: null, content_md5: 'm1' },
        { name: 'z', source: { name: 'src', type: 'local', url: '/x' }, resolved_commit: null, content_md5: 'm2' }
      ]
    });
    expect('branch' in lock.skills[1]!.source!).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run tests/unit/inject-lock.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/inject.ts`**

```ts
import { cp, link, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashSkillDirectory } from './core/manifest.js';
import { resolveConfiguredSkillSourceDir } from './linker.js';
import { listSources, loadSkillOwnershipState, loadSourceState } from './source.js';

export const LOCK_FILE_NAME = 'syncskill-lock.json';

export class InjectError extends Error {
  constructor(readonly code: 'E_SKILL_NOT_FOUND' | 'E_TARGET_OCCUPIED', message: string) {
    super(message);
  }
}

export interface LockSource { name: string; type: string; url: string; branch?: string }
export interface LockSkill { name: string; source: LockSource | null; resolved_commit: string | null; content_md5: string }
export interface SkillLock { schema: 'syncskill-lock-v1'; created_at: string; profile: string | null; skills: LockSkill[] }

export function normalizeSkillList(skills: string[]): string[] {
  return [...new Set(skills)].sort();
}

export function buildLock(profile: string | null, skills: LockSkill[], createdAt: string): SkillLock {
  return {
    schema: 'syncskill-lock-v1',
    created_at: createdAt,
    profile,
    skills: [...skills].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function injectSkills(
  homeDir: string,
  request: { skills: string[]; profile: string | null; target: string }
): Promise<{ target: string; lockPath: string; lock: SkillLock }> {
  const target = resolve(request.target);
  const skills = normalizeSkillList(request.skills);

  const sourceDirs = new Map<string, string>();
  for (const skill of skills) {
    try {
      sourceDirs.set(skill, await resolveConfiguredSkillSourceDir(homeDir, skill));
    } catch (error) {
      throw new InjectError('E_SKILL_NOT_FOUND', `Skill not found: ${skill} (${(error as Error).message})`);
    }
  }

  const lockPath = join(target, LOCK_FILE_NAME);
  for (const path of [...skills.map((skill) => join(target, skill)), lockPath]) {
    if (await exists(path)) {
      throw new InjectError('E_TARGET_OCCUPIED', `Target already holds ${path}`);
    }
  }

  const owners = (await loadSkillOwnershipState(homeDir)).owners;
  const sources = new Map((await listSources(homeDir)).map((source) => [source.name, source]));

  await mkdir(target, { recursive: true });
  const staging = join(target, `.syncskill-inject-${process.pid}`);
  const placed: string[] = [];
  try {
    await mkdir(staging);
    for (const skill of skills) {
      await cp(sourceDirs.get(skill)!, join(staging, skill), { recursive: true, dereference: true });
    }
    for (const skill of skills) {
      await rename(join(staging, skill), join(target, skill));
      placed.push(join(target, skill));
    }

    const entries: LockSkill[] = [];
    for (const skill of skills) {
      const ownerName = owners[skill];
      const owner = ownerName === undefined ? undefined : sources.get(ownerName);
      const state = owner === undefined ? null : await loadSourceState(homeDir, owner.name);
      entries.push({
        name: skill,
        source: owner === undefined ? null : {
          name: owner.name, type: owner.type, url: owner.url, ...(owner.branch === undefined ? {} : { branch: owner.branch })
        },
        resolved_commit: state?.resolved_commit ?? null,
        content_md5: await hashSkillDirectory(join(target, skill))
      });
    }

    const lock = buildLock(request.profile, entries, new Date().toISOString());
    const stagedLock = join(staging, LOCK_FILE_NAME);
    await writeFile(stagedLock, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    try {
      await link(stagedLock, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new InjectError('E_TARGET_OCCUPIED', `Target already holds ${lockPath}`);
      }
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
    return { target, lockPath, lock };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    for (const path of placed) await rm(path, { recursive: true, force: true });
    throw error;
  }
}
```

Note the ordering: "resolve all" happens before the target is created, so a missing skill leaves a non-existent target non-existent (spec §5.2). In `src/linker.ts` change `async function resolveConfiguredSkillSourceDir` to `export async function resolveConfiguredSkillSourceDir` — nothing else.

If `listSources` / `loadSkillOwnershipState` have different names or shapes than stated above, read `src/source.ts` and adapt the import, keeping the produced interfaces unchanged.

- [ ] **Step 4: Run** — `npx vitest run tests/unit/inject-lock.test.ts && npm run test:unit && npm run build` → exit 0.

- [ ] **Step 5: Commit** — `git add src/inject.ts src/linker.ts tests/unit/inject-lock.test.ts` then `git commit -m "feat(inject): copy a skill set into a directory as a snapshot with a lock file"`.

---

### Task 4: `profile` and `inject` commands

**Files:**
- Modify: `src/index.ts` (register `profile` with `set`, `ls`/`list`, `rm`; register `inject`)
- Modify: `src/cli/exit-codes.ts` (map `E_PROFILE_NOT_FOUND` → 2 next to `E_SKILL_NOT_FOUND`; `E_TARGET_OCCUPIED` → 7 next to `E_CONFLICT`)
- Test: `tests/integration/profile-inject-cli.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `profiles`, `PROFILE_NAME_PATTERN`; Task 3 `injectSkills`, `InjectError`; `resolveConfiguredSkillSourceDir`; existing `loadConfig`, `saveConfig`, `getGlobalOutput`, `failWithOutputError(code, message, hint?)`.
- Produces: CLI surface per spec §4/§5/§6.

- [ ] **Step 1: Write the failing integration tests** — `tests/integration/profile-inject-cli.test.ts`. Use `runCli`/`parseEvents` copied from `tests/integration/link-build-cli.test.ts`, `useTempDirs` from `tests/helpers/temp-dir.ts`, and `hashSkillDirectory` from `../../src/core/manifest.js`. A setup helper writes a config with `agents: { claude: <home>/.claude/skills }` and two manual skills `alpha`, `beta` (+ `gamma`) under `<home>/.syncskill/skills/<name>/SKILL.md`. The result event is the parsed event with `type === 'result'`. Cases (numbers match spec §7):

```ts
// 1. profile round trip, surviving an unrelated config save
let run = await runCli(home, ['--json', 'profile', 'set', 'review', 'beta', 'alpha']);
expect(run.code).toBe(0);
run = await runCli(home, ['--json', 'config', 'set', 'conflict_resolution', 'keep-local']);
expect(run.code).toBe(0);
const saved = JSON.parse(await readFile(join(home, '.syncskill', 'config.json'), 'utf8'));
expect(saved.profiles).toEqual({ review: ['alpha', 'beta'] });
run = await runCli(home, ['--json', 'profile', 'ls', 'review']);
expect(resultOf(run).summary).toMatchObject({ profiles: { review: ['alpha', 'beta'] } });
run = await runCli(home, ['--json', 'profile', 'rm', 'review']);
expect(run.code).toBe(0);
expect(JSON.parse(await readFile(join(home, '.syncskill', 'config.json'), 'utf8')).profiles).toEqual({});
expect((await runCli(home, ['--json', 'profile', 'rm', 'review'])).code).toBe(2);
expect((await runCli(home, ['--json', 'profile', 'set', 'bad.name', 'alpha'])).code).toBe(2);
expect((await runCli(home, ['--json', 'profile', 'set', 'x', 'ghost'])).code).toBe(2);

// 3. two targets, two profiles; then --skills
await runCli(home, ['profile', 'set', 'p1', 'alpha']);
await runCli(home, ['profile', 'set', 'p2', 'beta', 'gamma']);
const t1 = join(home, 'runs', 'one'); const t2 = join(home, 'runs', 'two');
expect((await runCli(home, ['--json', 'inject', '--profile', 'p1', '--target', t1])).code).toBe(0);
expect((await runCli(home, ['--json', 'inject', '--profile', 'p2', '--target', t2])).code).toBe(0);
expect((await readdir(t1)).sort()).toEqual(['alpha', 'syncskill-lock.json']);
expect((await readdir(t2)).sort()).toEqual(['beta', 'gamma', 'syncskill-lock.json']);
const lock2 = JSON.parse(await readFile(join(t2, 'syncskill-lock.json'), 'utf8'));
expect(lock2.profile).toBe('p2');
for (const entry of lock2.skills) expect(entry.content_md5).toBe(await hashSkillDirectory(join(t2, entry.name)));
expect(lock2.skills.map((s: { source: unknown }) => s.source)).toEqual([null, null]);
const t3 = join(home, 'runs', 'three');
expect((await runCli(home, ['--json', 'inject', '--skills', 'beta,alpha,alpha', '--target', t3])).code).toBe(0);
const lock3 = JSON.parse(await readFile(join(t3, 'syncskill-lock.json'), 'utf8'));
expect(lock3.profile).toBeNull();
expect(lock3.skills.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta']);

// 4. snapshot: editing the managed source after inject does not change the target
const before = await hashSkillDirectory(join(t1, 'alpha'));
await writeFile(join(home, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha changed');
expect(await hashSkillDirectory(join(t1, 'alpha'))).toBe(before);

// 5. occupied target -> 7, missing skill -> 2; directory listing unchanged in both
const listing = (await readdir(t1)).sort();
expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t1])).code).toBe(7);
expect((await readdir(t1)).sort()).toEqual(listing);
const t5 = join(home, 'runs', 'five');
expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha,ghost', '--target', t5])).code).toBe(2);
await expect(readdir(t5)).rejects.toMatchObject({ code: 'ENOENT' });

// 6. both selectors -> 2
expect((await runCli(home, ['--json', 'inject', '--profile', 'p1', '--skills', 'alpha', '--target', join(home, 'runs', 'six')])).code).toBe(2);

// 7. a symlink inside a skill becomes a regular file in the target
await writeFile(join(home, 'outside.txt'), 'outside');
await symlink(join(home, 'outside.txt'), join(home, '.syncskill', 'skills', 'gamma', 'link.txt'));
const t7 = join(home, 'runs', 'seven');
expect((await runCli(home, ['--json', 'inject', '--skills', 'gamma', '--target', t7])).code).toBe(0);
expect((await lstat(join(t7, 'gamma', 'link.txt'))).isSymbolicLink()).toBe(false);
expect(await readFile(join(t7, 'gamma', 'link.txt'), 'utf8')).toBe('outside');

// 8. a target holding only a lock file -> 7, lock bytes unchanged
const t8 = join(home, 'runs', 'eight');
await mkdir(t8, { recursive: true });
await writeFile(join(t8, 'syncskill-lock.json'), 'prior');
expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t8])).code).toBe(7);
expect(await readFile(join(t8, 'syncskill-lock.json'), 'utf8')).toBe('prior');
expect((await readdir(t8)).sort()).toEqual(['syncskill-lock.json']);
```

Split these into separate `it(...)` blocks (one per numbered case, each with its own temp home from the setup helper), so a red names its case. Add one more `it`: the `inject` result event's `summary` has `target`, `lock` and `skills` (deep-equal to the lock file's `skills`), and one `change` event per skill with `op: 'add'`, `entity: 'skill'`.

Also add, at the top of this file, the real-data guard (spec §7): in `beforeAll` record a snapshot of the real `~/.syncskill` (use `os.userInfo().homedir`, NOT `process.env.HOME`): for every entry under it (recursive), `relativePath + size + mtimeMs + sha256(file)`; if it does not exist, the snapshot is the string `"<absent>"`. In `afterAll`, recompute and `expect(after).toEqual(before)`.

- [ ] **Step 2: Build and run to see them fail** — `npm run build && npx vitest run tests/integration/profile-inject-cli.test.ts` → FAIL (unknown command `profile`/`inject`).

- [ ] **Step 3: Implement the commands in `src/index.ts`**

Register after the `link` command group, following its style (read `linkCommand.command('set …')` for the pattern and how `ensureLinkCommandReady()` loads config; use `loadConfig(resolvedHomeDir)` directly if that helper does link-specific work). Behaviour:

```ts
  const profileCommand = program.command('profile').description('Manage named skill profiles');

  profileCommand
    .command('set <name> <skills...>')
    .description('Set a profile to exactly these skills')
    .action(async (name: string, skills: string[]) => {
      if (!PROFILE_NAME_PATTERN.test(name)) {
        return failWithOutputError('E_USAGE_PROFILE_NAME', `Invalid profile name: ${name}`);
      }
      const config = await loadConfig(resolvedHomeDir);
      const members = normalizeSkillList(skills);
      for (const skill of members) {
        try {
          await resolveConfiguredSkillSourceDir(resolvedHomeDir, skill);
        } catch {
          return failWithOutputError('E_SKILL_NOT_FOUND', `Skill not found: ${skill}`);
        }
      }
      config.profiles[name] = members;
      await saveConfig(config, resolvedHomeDir);
      const output = getGlobalOutput();
      output.change('modify', 'skill', name, { after: members.join(',') });
      output.result(true, { profile: name, skills: members });
    });

  profileCommand
    .command('list [name]')
    .alias('ls')
    .description('Show profiles')
    .action(async (name?: string) => {
      const config = await loadConfig(resolvedHomeDir);
      if (name !== undefined && config.profiles[name] === undefined) {
        return failWithOutputError('E_PROFILE_NOT_FOUND', `Profile not found: ${name}`);
      }
      const profiles = name === undefined ? config.profiles : { [name]: config.profiles[name]! };
      const output = getGlobalOutput();
      for (const [profile, members] of Object.entries(profiles)) output.info(`${profile}: ${members.join(', ')}`);
      output.result(true, { profiles });
    });

  profileCommand
    .command('rm <name>')
    .description('Remove a profile')
    .action(async (name: string) => {
      const config = await loadConfig(resolvedHomeDir);
      if (config.profiles[name] === undefined) {
        return failWithOutputError('E_PROFILE_NOT_FOUND', `Profile not found: ${name}`);
      }
      delete config.profiles[name];
      await saveConfig(config, resolvedHomeDir);
      const output = getGlobalOutput();
      output.change('delete', 'skill', name);
      output.result(true, { profile: name });
    });

  program
    .command('inject')
    .description('Copy a skill set into a directory as a snapshot, with a lock file')
    .option('--profile <name>', 'Profile to inject')
    .option('--skills <list>', 'Comma-separated skills to inject')
    .requiredOption('--target <dir>', 'Directory to copy the skills into')
    .action(async (options: { profile?: string; skills?: string; target: string }) => {
      if ((options.profile === undefined) === (options.skills === undefined)) {
        return failWithOutputError('E_USAGE_INJECT_SELECTION', 'Give exactly one of --profile or --skills');
      }
      let skills: string[];
      if (options.profile !== undefined) {
        const config = await loadConfig(resolvedHomeDir);
        const members = config.profiles[options.profile];
        if (members === undefined) {
          return failWithOutputError('E_PROFILE_NOT_FOUND', `Profile not found: ${options.profile}`);
        }
        skills = members;
      } else {
        skills = options.skills!.split(',').map((skill) => skill.trim()).filter((skill) => skill.length > 0);
      }
      let injected: Awaited<ReturnType<typeof injectSkills>>;
      try {
        injected = await injectSkills(resolvedHomeDir, { skills, profile: options.profile ?? null, target: options.target });
      } catch (error) {
        if (error instanceof InjectError) return failWithOutputError(error.code, error.message);
        throw error;
      }
      const output = getGlobalOutput();
      for (const entry of injected.lock.skills) output.change('add', 'skill', entry.name, { target: join(injected.target, entry.name) });
      output.result(true, { target: injected.target, lock: injected.lockPath, skills: injected.lock.skills });
    });
```

Imports to add: `PROFILE_NAME_PATTERN` (config.ts), `injectSkills`, `InjectError`, `normalizeSkillList` (inject.ts), `resolveConfiguredSkillSourceDir` (linker.ts); `join` if not already imported. If `failWithOutputError` must be followed by `return` under mocked exit (cerebrum Do-Not-Repeat 2026-06-03), the `return failWithOutputError(...)` form above already does that. If `ResultEvent['summary']` is typed narrowly and rejects these objects, read its type in `src/cli/types.ts` and widen only as far as needed (or cast at the call site, matching what existing commands do).

In `src/cli/exit-codes.ts`: add `errorCode === 'E_PROFILE_NOT_FOUND'` to the `E_SKILL_NOT_FOUND` branch, and `|| errorCode === 'E_TARGET_OCCUPIED'` to the `E_CONFLICT` branch.

If the preflight (doctor) blocks these commands in the test config, read `src/index.ts` preflight (`ensure…Ready`/the `preAction` hook and the skip list) and make the test config satisfy it — do NOT add `profile`/`inject` to the preflight skip list.

- [ ] **Step 4: Run** — `npm run build && npx vitest run tests/integration/profile-inject-cli.test.ts && npm run test:unit` → exit 0.

- [ ] **Step 5: Commit** — `git add src/index.ts src/cli/exit-codes.ts tests/integration/profile-inject-cli.test.ts` then `git commit -m "feat(cli): profile set/ls/rm and inject"`.

---

### Task 5: docs, help, and the full gate

**Files:**
- Modify: `README.md`, `docs/usage-guide.md` (command tables: add `profile set|ls|rm` and `inject`; English)
- Modify: `tests/integration/help-output.test.ts`, `tests/unit/docs.test.ts` (lock stable substrings only)
- Modify (if it lists commands): the bundled skill doc under `skills/syncskill/` — read it; add the two commands only if it already enumerates commands.

- [ ] **Step 1: Write the failing assertions.** In `help-output.test.ts`, following its existing style, assert top-level help contains `profile` and `inject`, and `inject --help` contains `--target`, `--profile`, `--skills`. In `docs.test.ts`, following its style, assert `README.md` and `docs/usage-guide.md` each contain `syncskill inject --profile` and `syncskill profile set`.

- [ ] **Step 2: Run to see them fail** — `npm run build && npx vitest run tests/integration/help-output.test.ts tests/unit/docs.test.ts` → the new assertions FAIL.

- [ ] **Step 3: Write the docs.** In each command table add rows for `syncskill profile set <name> <skills...>`, `syncskill profile ls [name]`, `syncskill profile rm <name>`, `syncskill inject --profile <name> --target <dir>` / `--skills a,b`; one short paragraph: inject copies a snapshot (symlinks dereferenced), refuses an occupied target (exit 7), writes `syncskill-lock.json` with each skill's source, `resolved_commit` and `content_md5`, and never touches agent skill directories or `config.links`.

- [ ] **Step 4: Full gate** — `npm run build && npm run test:unit && npm run test:integration` → all exit 0. Redirect each to a file and read it whole; report pass/fail/skip counts from the files.

- [ ] **Step 5: Commit** — `git add README.md docs/usage-guide.md tests/integration/help-output.test.ts tests/unit/docs.test.ts <skill doc if changed>` then `git commit -m "docs: profile and inject commands"`.

---

## After all tasks (controller, not an implementer task)

Mutations from spec §7, each in a `git clone --local` copy of syncskill with `node_modules` symlinked, built, and the named test run; each must be seen red, then restored (`cmp` against the main tree): drop `profiles` from `validateConfig`; drop `resolved_commit` from `normalizeSourceState`; write `resolved_commit: null` always; `cp` → `symlink`; remove the occupancy loop; move resolution after `mkdir(target)`; `dereference: false`; lock `link` → `rename` with the lock occupancy check removed; `normalizeSkillList` → identity. Record results in `.superpowers/sdd/2026-10-03-profile-inject-version/progress.md` (create; `git add -f` if ignored).
