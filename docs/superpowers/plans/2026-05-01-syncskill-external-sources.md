# syncskill External Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 3 of `syncskill`: external source registration, listing, updating, and materialization for `local`, `git`, and `http` sources.

**Architecture:** Keep source lifecycle in a dedicated `src/source.ts` module that owns source config normalization, per-source cache/state paths under `~/.syncskill/.sources/`, and materialization into `~/.syncskill/skills/`. `src/index.ts` should only wire the `source` subcommands; it must not embed clone/download/materialization logic. Local sources should materialize as symlinks into the sync store, while `git` and `http` sources should materialize by copying directories from a checked-out or extracted cache so later Milestone 4 push logic still transfers real file contents.

**Tech Stack:** TypeScript, Node 20 ESM, commander, yaml, vitest, Node built-ins (`fs/promises`, `path`, `child_process`, `http`, `stream`, `os`)

---

## File Map

**Create:**
- `src/source.ts` — external source config normalization, cache/state paths, local/git/http materialization, update orchestration
- `tests/source.test.ts` — source module tests for local/git/http materialization and state tracking
- `tests/source-cli.test.ts` — CLI coverage for `source add`, `source list`, and `source update`

**Modify:**
- `src/index.ts` — register the `source` command group and wire it to `src/source.ts`

**Do not modify in this milestone unless a failing test requires it:**
- `src/config.ts`
- `src/config-ui.ts`
- `src/linker.ts`
- `src/manifest.ts`
- `src/conflict.ts`
- `src/refresh.ts`
- `src/repo.ts`

## Data Model

Store source definitions inside `config.yaml` using the existing `sources` object.

```yaml
sources:
  shared:
    type: local
    url: /Users/biran/shared-skills
    store: .
  team:
    type: git
    url: /tmp/team-skills.git
    store: skills
    ref: main
  bundle:
    type: http
    url: http://127.0.0.1:8787/skills.tar.gz
    store: bundle/skills
```

Per-source runtime state lives under `~/.syncskill/.sources/<name>/`.

```text
~/.syncskill/.sources/<name>/
├── checkout/          # git clone or extracted http archive
└── state.json         # materialized skill tracking
```

`state.json` records the last materialized skill set so updates can remove stale skills previously owned by the source.

```json
{
  "materialized_skills": ["alpha", "beta"],
  "updated_at": "2026-05-01T00:00:00.000Z"
}
```

## Command Contract

This milestone should ship these CLI shapes:

```text
syncskill source add <name> --type git|http|local --url <value> --store <path> [--ref <branch>]
syncskill source list
syncskill source update [name] [--all]
```

Behavior:
- `source add` saves the source definition and materializes it immediately
- `source list` prints one line per source: `<name>\t<type>\t<url>\t<store>`
- `source update <name>` refreshes one named source
- `source update --all` refreshes all configured sources
- `source update` without a name refreshes all configured sources

## Task 1: Add source definitions, state paths, and local-source materialization

**Files:**
- Create: `src/source.ts`
- Create: `tests/source.test.ts`

- [ ] **Step 1: Write the failing source-module tests**

```ts
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config.js';
import { materializeSource, loadSourceState, listSources } from '../src/source.js';

describe('source module', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('listSources normalizes valid source entries and sorts them by name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          zeta: { type: 'git', url: '/tmp/zeta.git', store: 'skills', ref: 'main' },
          alpha: { type: 'local', url: '/tmp/local-skills', store: '.' },
          broken: { type: 'git' }
        }
      },
      homeDir
    );

    await expect(listSources(homeDir)).resolves.toEqual([
      {
        name: 'alpha',
        type: 'local',
        url: '/tmp/local-skills',
        store: '.'
      },
      {
        name: 'zeta',
        type: 'git',
        url: '/tmp/zeta.git',
        store: 'skills',
        ref: 'main'
      }
    ]);
  });

  it('materializeSource symlinks local-source skills into the sync store and records state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha', 'beta']);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceRoot, 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha', 'beta'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource removes stale local-source skills from a previous state file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'beta'), { recursive: true, force: true });
    await mkdir(join(sourceRoot, 'gamma'), { recursive: true });
    await writeFile(join(sourceRoot, 'gamma', 'SKILL.md'), '# gamma\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['gamma']);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['gamma'],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
  });
});
```

- [ ] **Step 2: Run the source-module tests to verify they fail**

Run: `npm test -- tests/source.test.ts`
Expected: FAIL with a missing module or missing exports from `../src/source.js`.

- [ ] **Step 3: Create `src/source.ts` with source definitions, state IO, and local materialization**

```ts
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getSyncDir, getSyncPaths, loadConfig, saveConfig } from './config.js';

export type SourceType = 'git' | 'http' | 'local';

export interface SourceDefinition {
  type: SourceType;
  url: string;
  store: string;
  ref?: string;
}

export interface SourceEntry extends SourceDefinition {
  name: string;
}

export interface SourceState {
  materialized_skills: string[];
  updated_at: string;
}

export async function listSources(homeDir: string): Promise<SourceEntry[]> {
  const config = await loadConfig(homeDir);

  return Object.entries(config.sources)
    .flatMap(([name, value]) => normalizeSourceEntry(name, value))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadSourceState(homeDir: string, name: string): Promise<SourceState | null> {
  const stateFile = getSourceStateFile(homeDir, name);

  try {
    const raw = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<SourceState>;
    return {
      materialized_skills: Array.isArray(raw.materialized_skills)
        ? raw.materialized_skills.filter((value): value is string => typeof value === 'string').sort()
        : [],
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function materializeSource(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  updatedAt = new Date().toISOString()
): Promise<SourceState> {
  const materializedRoot = await prepareSourceMaterializedRoot(homeDir, name, source);
  const skillNames = await listSkillDirectories(materializedRoot);
  const state = await loadSourceState(homeDir, name);
  const { skillsDir } = getSyncPaths(homeDir);

  await mkdir(skillsDir, { recursive: true });
  await removeStaleSkills(skillsDir, state?.materialized_skills ?? [], skillNames);

  for (const skillName of skillNames) {
    const sourceSkillDir = join(materializedRoot, skillName);
    const targetSkillDir = join(skillsDir, skillName);
    await rm(targetSkillDir, { recursive: true, force: true });

    if (source.type === 'local') {
      await symlink(sourceSkillDir, targetSkillDir, 'dir');
    } else {
      await cp(sourceSkillDir, targetSkillDir, { recursive: true });
    }
  }

  const nextState = {
    materialized_skills: skillNames,
    updated_at: updatedAt
  } satisfies SourceState;

  await saveSourceState(homeDir, name, nextState);
  return nextState;
}

export async function addSource(homeDir: string, name: string, source: SourceDefinition): Promise<void> {
  const config = await loadConfig(homeDir);
  config.sources[name] = source;
  await saveConfig(config, homeDir);
  await materializeSource(homeDir, name, source);
}
```

- [ ] **Step 4: Run the source-module tests to verify they pass**

Run: `npm test -- tests/source.test.ts`
Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the source foundations**

```bash
git add src/source.ts tests/source.test.ts
git commit -m "feat: add local source materialization helpers"
```

## Task 2: Wire `source add` and `source list`

**Files:**
- Modify: `src/source.ts`
- Modify: `src/index.ts`
- Create: `tests/source-cli.test.ts`

- [ ] **Step 1: Write the failing CLI tests for `source add` and `source list`**

```ts
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createProgram } from '../src/index.js';

describe('source CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('source add saves a local source definition and materializes its skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'source', 'add', 'shared', '--type', 'local', '--url', sourceRoot, '--store', '.'],
      { from: 'node' }
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      sources: {
        shared: {
          type: 'local',
          url: sourceRoot,
          store: '.'
        }
      }
    });
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceRoot, 'alpha'));
  });

  it('source list prints sorted source definitions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'source', 'add', 'zeta', '--type', 'git', '--url', '/tmp/zeta.git', '--store', 'skills'],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'source', 'add', 'alpha', '--type', 'local', '--url', '/tmp/local-skills', '--store', '.'],
      { from: 'node' }
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([
      ['alpha\tlocal\t/tmp/local-skills\t.'],
      ['zeta\tgit\t/tmp/zeta.git\tskills']
    ]);
  });
});
```

- [ ] **Step 2: Run the source CLI tests to verify they fail**

Run: `npm test -- tests/source-cli.test.ts`
Expected: FAIL because the `source` command group does not exist yet.

- [ ] **Step 3: Extend `src/source.ts` and `src/index.ts` for `source add` and `source list`**

```ts
export function formatSourceListLines(sources: SourceEntry[]): string[] {
  return sources.map((source) => `${source.name}\t${source.type}\t${source.url}\t${source.store}`);
}
```

```ts
const sourceCommand = program.command('source').description('Manage external skill sources');

sourceCommand
  .command('add <name>')
  .requiredOption('--type <type>', 'Choose git, http, or local', /^(git|http|local)$/u)
  .requiredOption('--url <url>', 'Source URL or local path')
  .requiredOption('--store <path>', 'Skill directory inside the source root')
  .option('--ref <ref>', 'Git branch or ref to track')
  .action(async (name: string, options: { type: 'git' | 'http' | 'local'; url: string; store: string; ref?: string }) => {
    await addSource(resolvedHomeDir, name, {
      type: options.type,
      url: options.url,
      store: options.store,
      ref: options.ref
    });
  });

sourceCommand
  .command('list')
  .description('List configured external sources')
  .action(async () => {
    for (const line of formatSourceListLines(await listSources(resolvedHomeDir))) {
      console.log(line);
    }
  });
```

- [ ] **Step 4: Run the source CLI tests to verify they pass**

Run: `npm test -- tests/source-cli.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit source add/list wiring**

```bash
git add src/source.ts src/index.ts tests/source-cli.test.ts
git commit -m "feat: add source add and list commands"
```

## Task 3: Add git-source checkout and update behavior

**Files:**
- Modify: `src/source.ts`
- Modify: `tests/source.test.ts`

- [ ] **Step 1: Extend `tests/source.test.ts` with failing git-source tests**

```ts
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

it('materializeSource clones a git source and copies tracked skills into the sync store', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
  const repoDir = join(homeDir, 'repo');
  tempDirs.push(homeDir);

  await mkdir(join(repoDir, 'skills', 'alpha'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
  await execFile('git', ['init'], { cwd: repoDir });
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=syncskill', '-c', 'user.email=syncskill@example.com', 'commit', '-m', 'init'],
    { cwd: repoDir }
  );

  const state = await materializeSource(
    homeDir,
    'team',
    { type: 'git', url: repoDir, store: 'skills', ref: 'master' },
    '2026-05-01T00:00:00.000Z'
  );

  expect(state.materialized_skills).toEqual(['alpha']);
  await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha\n');
});

it('updateSource refreshes a git checkout and removes stale materialized skills', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
  const repoDir = join(homeDir, 'repo');
  tempDirs.push(homeDir);

  await mkdir(join(repoDir, 'skills', 'alpha'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
  await execFile('git', ['init'], { cwd: repoDir });
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=syncskill', '-c', 'user.email=syncskill@example.com', 'commit', '-m', 'init'],
    { cwd: repoDir }
  );

  await addSource(homeDir, 'team', { type: 'git', url: repoDir, store: 'skills', ref: 'master' });

  await rm(join(repoDir, 'skills', 'alpha'), { recursive: true, force: true });
  await mkdir(join(repoDir, 'skills', 'beta'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'beta', 'SKILL.md'), '# beta\n', 'utf8');
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=syncskill', '-c', 'user.email=syncskill@example.com', 'commit', '-m', 'update'],
    { cwd: repoDir }
  );

  const state = await updateSource(homeDir, 'team', '2026-05-01T01:00:00.000Z');

  expect(state.materialized_skills).toEqual(['beta']);
  await expect(readFile(join(homeDir, '.syncskill', 'skills', 'beta', 'SKILL.md'), 'utf8')).resolves.toBe('# beta\n');
});
```

- [ ] **Step 2: Run the source-module tests to verify git behavior fails**

Run: `npm test -- tests/source.test.ts`
Expected: FAIL because `git` sources are not cloned or updated yet.

- [ ] **Step 3: Extend `src/source.ts` with git checkout helpers and update orchestration**

```ts
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

async function syncGitCheckout(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const checkoutDir = getSourceCheckoutDir(homeDir, name);
  const checkoutExists = await pathExists(join(checkoutDir, '.git'));

  await mkdir(getSourceRuntimeDir(homeDir, name), { recursive: true });

  if (!checkoutExists) {
    await execFile('git', ['clone', '--single-branch', '--depth', '1', source.url, checkoutDir]);
  }

  const ref = source.ref ?? 'HEAD';
  await execFile('git', ['fetch', '--depth', '1', 'origin', ref], { cwd: checkoutDir });
  await execFile('git', ['reset', '--hard', `origin/${ref}`], { cwd: checkoutDir }).catch(async () => {
    await execFile('git', ['reset', '--hard', ref], { cwd: checkoutDir });
  });

  return join(checkoutDir, source.store);
}

export async function updateSource(homeDir: string, name: string, updatedAt = new Date().toISOString()): Promise<SourceState> {
  const source = await getSourceByName(homeDir, name);
  return materializeSource(homeDir, name, source, updatedAt);
}
```

- [ ] **Step 4: Run the source-module tests to verify git behavior passes**

Run: `npm test -- tests/source.test.ts`
Expected: PASS with the local-source tests plus 2 new passing git-source tests.

- [ ] **Step 5: Commit git-source support**

```bash
git add src/source.ts tests/source.test.ts
git commit -m "feat: add git source materialization"
```

## Task 4: Add HTTP archive download and extraction behavior

**Files:**
- Modify: `src/source.ts`
- Modify: `tests/source.test.ts`

- [ ] **Step 1: Extend `tests/source.test.ts` with failing HTTP-source tests**

```ts
import { createServer } from 'node:http';

it('materializeSource downloads an http tar.gz archive and copies skills into the sync store', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
  tempDirs.push(homeDir);

  const archiveRoot = join(homeDir, 'archive-root');
  await mkdir(join(archiveRoot, 'bundle', 'skills', 'alpha'), { recursive: true });
  await writeFile(join(archiveRoot, 'bundle', 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

  const archiveFile = join(homeDir, 'skills.tar.gz');
  await execFile('tar', ['-czf', archiveFile, '-C', archiveRoot, '.']);

  const server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(await readFile(archiveFile));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const port = (server.address() as { port: number }).port;

    const state = await materializeSource(
      homeDir,
      'bundle',
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/skills.tar.gz`,
        store: 'bundle/skills'
      },
      '2026-05-01T00:00:00.000Z'
    );

    expect(state.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha\n');
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the source-module tests to verify HTTP behavior fails**

Run: `npm test -- tests/source.test.ts`
Expected: FAIL because `http` sources are not downloaded or extracted yet.

- [ ] **Step 3: Extend `src/source.ts` with HTTP archive download and extraction**

```ts
async function syncHttpArchive(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const runtimeDir = getSourceRuntimeDir(homeDir, name);
  const checkoutDir = getSourceCheckoutDir(homeDir, name);
  const archiveFile = join(runtimeDir, 'source.tar.gz');

  await mkdir(runtimeDir, { recursive: true });
  await rm(checkoutDir, { recursive: true, force: true });
  await mkdir(checkoutDir, { recursive: true });

  const response = await fetch(source.url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download source archive: ${source.url}`);
  }

  await writeFile(archiveFile, Buffer.from(await response.arrayBuffer()));
  await execFile('tar', ['-xzf', archiveFile, '-C', checkoutDir]);

  return join(checkoutDir, source.store);
}
```

- [ ] **Step 4: Run the source-module tests to verify HTTP behavior passes**

Run: `npm test -- tests/source.test.ts`
Expected: PASS with the local, git, and HTTP source tests green.

- [ ] **Step 5: Commit HTTP-source support**

```bash
git add src/source.ts tests/source.test.ts
git commit -m "feat: add http source materialization"
```

## Task 5: Wire `source update`, verify the milestone, and ship

**Files:**
- Modify: `src/source.ts`
- Modify: `src/index.ts`
- Modify: `tests/source-cli.test.ts`

- [ ] **Step 1: Extend `tests/source-cli.test.ts` with failing update coverage**

```ts
it('source update <name> refreshes one configured source', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
  tempDirs.push(homeDir);

  const repoDir = join(homeDir, 'repo');
  await mkdir(join(repoDir, 'skills', 'alpha'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
  await execFile('git', ['init'], { cwd: repoDir });
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=syncskill', '-c', 'user.email=syncskill@example.com', 'commit', '-m', 'init'],
    { cwd: repoDir }
  );

  await createProgram(homeDir).parseAsync(
    ['node', 'syncskill', 'source', 'add', 'team', '--type', 'git', '--url', repoDir, '--store', 'skills'],
    { from: 'node' }
  );

  await rm(join(repoDir, 'skills', 'alpha'), { recursive: true, force: true });
  await mkdir(join(repoDir, 'skills', 'beta'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'beta', 'SKILL.md'), '# beta\n', 'utf8');
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=syncskill', '-c', 'user.email=syncskill@example.com', 'commit', '-m', 'update'],
    { cwd: repoDir }
  );

  await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'update', 'team'], { from: 'node' });

  await expect(readFile(join(homeDir, '.syncskill', 'skills', 'beta', 'SKILL.md'), 'utf8')).resolves.toBe('# beta\n');
});

it('source update --all refreshes every configured source', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
  tempDirs.push(homeDir);

  const localRoot = join(homeDir, 'shared');
  await mkdir(join(localRoot, 'alpha'), { recursive: true });
  await writeFile(join(localRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

  await createProgram(homeDir).parseAsync(
    ['node', 'syncskill', 'source', 'add', 'shared', '--type', 'local', '--url', localRoot, '--store', '.'],
    { from: 'node' }
  );

  await rm(join(localRoot, 'alpha'), { recursive: true, force: true });
  await mkdir(join(localRoot, 'gamma'), { recursive: true });
  await writeFile(join(localRoot, 'gamma', 'SKILL.md'), '# gamma\n', 'utf8');

  await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'update', '--all'], { from: 'node' });

  await expect(readlink(join(homeDir, '.syncskill', 'skills', 'gamma'))).resolves.toBe(join(localRoot, 'gamma'));
});
```

- [ ] **Step 2: Run the source CLI tests to verify `source update` fails**

Run: `npm test -- tests/source-cli.test.ts`
Expected: FAIL because `source update` is not wired yet.

- [ ] **Step 3: Extend `src/source.ts` and `src/index.ts` with update helpers and CLI wiring**

```ts
export async function updateAllSources(homeDir: string, updatedAt = new Date().toISOString()): Promise<SourceState[]> {
  const sources = await listSources(homeDir);
  const results: SourceState[] = [];

  for (const source of sources) {
    results.push(await updateSource(homeDir, source.name, updatedAt));
  }

  return results;
}
```

```ts
sourceCommand
  .command('update [name]')
  .description('Refresh one source or all configured sources')
  .option('--all', 'Refresh all sources')
  .action(async (name: string | undefined, options: { all?: boolean }) => {
    if (options.all || !name) {
      await updateAllSources(resolvedHomeDir);
      return;
    }

    await updateSource(resolvedHomeDir, name);
  });
```

- [ ] **Step 4: Run the source tests, full suite, and build verification**

Run: `npm test -- tests/source.test.ts tests/source-cli.test.ts`
Expected: PASS with all source-module and source-CLI tests green.

Run: `npm test`
Expected: PASS with Milestones 1–3 tests all green.

Run: `npm run build && node dist/index.js source list`
Expected: PASS and the built CLI recognizes the `source` command group.

- [ ] **Step 5: Commit the completed Milestone 3 slice**

```bash
git add src/source.ts src/index.ts tests/source.test.ts tests/source-cli.test.ts
git commit -m "feat: deliver syncskill external sources milestone"
```

## Self-Review

**Spec coverage:**
- `source add`: covered in Tasks 2 and 5
- `source list`: covered in Task 2
- `source update`: covered in Task 5
- local-source symlink materialization: covered in Task 1
- git-source clone and update materialization: covered in Task 3
- http archive download and extraction behavior: covered in Task 4
- stale source-owned skill removal on update: covered in Tasks 1 and 3
- keeping source logic in `src/source.ts` and CLI wiring in `src/index.ts`: covered across Tasks 1–5

**Placeholder scan:**
- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every code-changing step includes concrete TypeScript or shell content.
- Test and build commands are explicit and have expected outcomes.

**Type consistency:**
- `SourceDefinition`, `SourceEntry`, `SourceState`, `listSources`, `materializeSource`, `addSource`, `updateSource`, `updateAllSources`, and `formatSourceListLines` are used consistently across tasks.
- `sources` config entries consistently use `type`, `url`, `store`, and optional `ref`.
- `local` always materializes via symlink; `git` and `http` always materialize via copied directories from a cache checkout.
