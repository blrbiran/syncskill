# syncskill State and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 2 of `syncskill`: manifest/history state, `status`, `diff <server>`, `resolve <skill> --take local|remote`, and `refresh [--local | --remote | --status] [server]`.

**Architecture:** Keep all synchronization state in local JSON files under `~/.syncskill/manifests/` plus `manifest_history.json`. `src/manifest.ts` owns hashing and persistence, `src/conflict.ts` owns delta and resolution math, and `src/refresh.ts` owns orchestration over stored manifests. Milestone 2 does not talk to remote hosts yet; `refresh --remote` only re-reads and reclassifies saved remote snapshots on disk so Milestone 4 can later plug in transport without changing the state model.

**Tech Stack:** TypeScript, Node 20 ESM, commander, yaml, vitest, Node built-ins (`crypto`, `fs/promises`, `path`)

---

## File Map

**Create:**
- `src/manifest.ts` — stable MD5 hashing, local hash snapshots, manifest/history read-write helpers
- `src/conflict.ts` — delta classification, manifest reconciliation, resolution application
- `src/refresh.ts` — tracked-server discovery, refresh orchestration, auto-refresh hook helpers
- `tests/manifest.test.ts` — hashing, manifest persistence, history append behavior
- `tests/conflict.test.ts` — delta classification and resolution behavior
- `tests/refresh.test.ts` — orchestration over tracked manifests and auto-refresh behavior
- `tests/reconciliation-cli.test.ts` — CLI coverage for `status`, `diff`, `resolve`, `refresh`, and `--no-refresh`

**Modify:**
- `src/index.ts` — wire Milestone 2 commands and the global `--no-refresh` behavior

**Do not modify in this milestone unless required by a failing test:**
- `src/config.ts`
- `src/repo.ts`
- `src/linker.ts`
- `src/config-ui.ts`

## Data Model

Per-server manifest files live at `~/.syncskill/manifests/<server>.json`.

```json
{
  "version": 1,
  "server": "dev",
  "updated_at": "2026-05-01T00:00:00.000Z",
  "skills": {
    "welcome": {
      "local_hash": "11111111111111111111111111111111",
      "remote_hash": "22222222222222222222222222222222",
      "recorded_hash": "22222222222222222222222222222222",
      "direction": "push",
      "status": "local-changed"
    }
  }
}
```

`recorded_hash` is the last reconciled baseline shared by both sides.

- `local_hash === recorded_hash` means local matches the baseline
- `remote_hash === recorded_hash` means the stored remote snapshot matches the baseline
- `local_hash !== recorded_hash && remote_hash === recorded_hash` means `push`
- `local_hash === recorded_hash && remote_hash !== recorded_hash` means `pull`
- `local_hash !== recorded_hash && remote_hash !== recorded_hash && local_hash !== remote_hash` means `conflict`
- `local_hash === remote_hash` means no sync work is needed, even if the baseline is older

History stays in `~/.syncskill/manifest_history.json`.

```json
{
  "version": 1,
  "entries": [
    {
      "skill": "welcome",
      "server": "local",
      "old_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "new_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "direction": "local",
      "updated_at": "2026-05-01T00:00:00.000Z"
    }
  ]
}
```

## Task 1: Add manifest hashing primitives

**Files:**
- Create: `src/manifest.ts`
- Create: `tests/manifest.test.ts`

- [ ] **Step 1: Write the failing hashing tests**

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getSyncPaths } from '../src/config.js';
import { buildLocalSkillHashes, hashSkillDirectory } from '../src/manifest.js';

describe('manifest hashing', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('hashSkillDirectory sorts relative paths and ignores symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const skillDir = join(homeDir, '.syncskill', 'skills', 'demo');
    await mkdir(join(skillDir, 'b'), { recursive: true });
    await mkdir(join(skillDir, 'a'), { recursive: true });
    await writeFile(join(skillDir, 'b', 'second.txt'), 'second', 'utf8');
    await writeFile(join(skillDir, 'a', 'first.txt'), 'first', 'utf8');
    await symlink(join(skillDir, 'a', 'first.txt'), join(skillDir, 'link.txt'));

    const withSymlink = await hashSkillDirectory(skillDir);

    await rm(join(skillDir, 'link.txt'));

    const withoutSymlink = await hashSkillDirectory(skillDir);

    expect(withSymlink).toMatch(/^[a-f0-9]{32}$/);
    expect(withSymlink).toBe(withoutSymlink);
  });

  it('buildLocalSkillHashes returns hashes for all local skills in name order', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await mkdir(join(skillsDir, 'ops'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome', 'utf8');
    await writeFile(join(skillsDir, 'ops', 'SKILL.md'), '# ops', 'utf8');

    const hashes = await buildLocalSkillHashes(homeDir);

    expect(Object.keys(hashes)).toEqual(['ops', 'welcome']);
    expect(hashes.ops).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.welcome).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.ops).not.toBe(hashes.welcome);
  });
});
```

- [ ] **Step 2: Run the hashing tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL with a missing module or export for `../src/manifest.js`.

- [ ] **Step 3: Create `src/manifest.ts` with stable hashing helpers**

```ts
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { getSyncPaths } from './config.js';

export async function listLocalSkillNames(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);
  await mkdir(skillsDir, { recursive: true });

  const entries = await readdir(skillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function collectFiles(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(currentDir, entry.name);
    const stats = await lstat(fullPath);

    if (stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...(await collectFiles(rootDir, fullPath)));
      continue;
    }

    if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => relative(rootDir, left).localeCompare(relative(rootDir, right)));
}

export async function hashSkillDirectory(skillDir: string): Promise<string> {
  const hash = createHash('md5');
  const files = await collectFiles(skillDir, skillDir);

  for (const file of files) {
    const relativePath = relative(skillDir, file).replaceAll('\\', '/');
    hash.update(Buffer.from(relativePath, 'utf8'));
    hash.update(await readFile(file));
  }

  return hash.digest('hex');
}

export async function buildLocalSkillHashes(homeDir: string): Promise<Record<string, string>> {
  const { skillsDir } = getSyncPaths(homeDir);
  const hashes: Record<string, string> = {};

  for (const skill of await listLocalSkillNames(homeDir)) {
    hashes[skill] = await hashSkillDirectory(join(skillsDir, skill));
  }

  return hashes;
}
```

- [ ] **Step 4: Run the hashing tests to verify they pass**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit the hashing foundation**

```bash
git add src/manifest.ts tests/manifest.test.ts
git commit -m "feat: add manifest hashing helpers"
```

### Task 2: Store per-server manifests and manifest history

**Files:**
- Modify: `src/manifest.ts`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Extend `tests/manifest.test.ts` with failing persistence and history tests**

```ts
import { readFile } from 'node:fs/promises';

import {
  buildLocalSkillHashes,
  createEmptyManifest,
  hashSkillDirectory,
  loadManifestHistory,
  loadServerManifest,
  refreshLocalManifest,
  saveServerManifest
} from '../src/manifest.js';

it('loadServerManifest returns an empty manifest when the file is missing', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
  tempDirs.push(homeDir);

  await expect(loadServerManifest(homeDir, 'dev')).resolves.toEqual({
    version: 1,
    server: 'dev',
    updated_at: expect.any(String),
    skills: {}
  });
});

it('refreshLocalManifest saves local hashes and appends history only when a hash changes', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
  tempDirs.push(homeDir);

  const { skillsDir } = getSyncPaths(homeDir);
  await mkdir(join(skillsDir, 'welcome'), { recursive: true });
  await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome', 'utf8');

  const first = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T00:00:00.000Z');
  expect(first.skills.welcome.local_hash).toMatch(/^[a-f0-9]{32}$/);

  const afterFirstHistory = await loadManifestHistory(homeDir);
  expect(afterFirstHistory.entries).toEqual([]);

  await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome changed', 'utf8');

  const second = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T01:00:00.000Z');
  const history = await loadManifestHistory(homeDir);

  expect(second.skills.welcome.local_hash).not.toBe(first.skills.welcome.local_hash);
  expect(history.entries).toEqual([
    {
      skill: 'welcome',
      server: 'local',
      old_hash: first.skills.welcome.local_hash,
      new_hash: second.skills.welcome.local_hash,
      direction: 'local',
      updated_at: '2026-05-01T01:00:00.000Z'
    }
  ]);
});
```

- [ ] **Step 2: Run the manifest tests to verify they fail because persistence helpers are missing**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL with missing exports such as `createEmptyManifest`, `loadServerManifest`, `loadManifestHistory`, or `refreshLocalManifest`.

- [ ] **Step 3: Extend `src/manifest.ts` with manifest and history storage**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export type SyncDirection = 'push' | 'pull' | 'skip' | 'conflict';
export type SyncStatus = 'in-sync' | 'local-changed' | 'remote-changed' | 'conflict' | 'new';

export interface ManifestSkillState {
  local_hash: string | null;
  remote_hash: string | null;
  recorded_hash: string | null;
  direction: SyncDirection;
  status: SyncStatus;
}

export interface ServerManifest {
  version: 1;
  server: string;
  updated_at: string;
  skills: Record<string, ManifestSkillState>;
}

export interface ManifestHistoryEntry {
  skill: string;
  server: string;
  old_hash: string | null;
  new_hash: string | null;
  direction: 'local' | 'remote';
  updated_at: string;
}

export interface ManifestHistory {
  version: 1;
  entries: ManifestHistoryEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptySkillState(): ManifestSkillState {
  return {
    local_hash: null,
    remote_hash: null,
    recorded_hash: null,
    direction: 'skip',
    status: 'in-sync'
  };
}

export function createEmptyManifest(server: string, updatedAt = nowIso()): ServerManifest {
  return {
    version: 1,
    server,
    updated_at: updatedAt,
    skills: {}
  };
}

function normalizeSkillState(value: unknown): ManifestSkillState {
  const state = (value ?? {}) as Partial<ManifestSkillState>;

  return {
    local_hash: typeof state.local_hash === 'string' ? state.local_hash : null,
    remote_hash: typeof state.remote_hash === 'string' ? state.remote_hash : null,
    recorded_hash: typeof state.recorded_hash === 'string' ? state.recorded_hash : null,
    direction: state.direction === 'push' || state.direction === 'pull' || state.direction === 'conflict' ? state.direction : 'skip',
    status:
      state.status === 'local-changed' ||
      state.status === 'remote-changed' ||
      state.status === 'conflict' ||
      state.status === 'new'
        ? state.status
        : 'in-sync'
  };
}

export async function loadServerManifest(homeDir: string, server: string): Promise<ServerManifest> {
  const { manifestsDir } = getSyncPaths(homeDir);
  const manifestFile = join(manifestsDir, `${server}.json`);

  try {
    const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Partial<ServerManifest>;

    return {
      version: 1,
      server,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
      skills: Object.fromEntries(
        Object.entries(raw.skills ?? {}).map(([skill, state]) => [skill, normalizeSkillState(state)])
      )
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyManifest(server);
    }

    throw error;
  }
}

export async function saveServerManifest(homeDir: string, manifest: ServerManifest): Promise<void> {
  const { manifestsDir } = getSyncPaths(homeDir);
  await mkdir(manifestsDir, { recursive: true });
  await writeFile(join(manifestsDir, `${manifest.server}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function loadManifestHistory(homeDir: string): Promise<ManifestHistory> {
  const { historyFile } = getSyncPaths(homeDir);

  try {
    const raw = JSON.parse(await readFile(historyFile, 'utf8')) as Partial<ManifestHistory>;

    return {
      version: 1,
      entries: Array.isArray(raw.entries) ? raw.entries as ManifestHistoryEntry[] : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, entries: [] };
    }

    throw error;
  }
}

export async function saveManifestHistory(homeDir: string, history: ManifestHistory): Promise<void> {
  const { historyFile, syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  await writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

export async function refreshLocalManifest(
  homeDir: string,
  server: string,
  updatedAt = nowIso()
): Promise<ServerManifest> {
  const manifest = await loadServerManifest(homeDir, server);
  const history = await loadManifestHistory(homeDir);
  const localHashes = await buildLocalSkillHashes(homeDir);
  const skillNames = [...new Set([...Object.keys(manifest.skills), ...Object.keys(localHashes)])].sort();
  const nextSkills: Record<string, ManifestSkillState> = {};

  for (const skill of skillNames) {
    const previous = manifest.skills[skill] ?? createEmptySkillState();
    const nextLocalHash = localHashes[skill] ?? null;

    if (previous.local_hash !== null && previous.local_hash !== nextLocalHash) {
      history.entries.push({
        skill,
        server: 'local',
        old_hash: previous.local_hash,
        new_hash: nextLocalHash,
        direction: 'local',
        updated_at: updatedAt
      });
    }

    nextSkills[skill] = {
      ...previous,
      local_hash: nextLocalHash
    };
  }

  const nextManifest: ServerManifest = {
    ...manifest,
    updated_at: updatedAt,
    skills: nextSkills
  };

  await saveServerManifest(homeDir, nextManifest);
  await saveManifestHistory(homeDir, history);

  return nextManifest;
}
```

- [ ] **Step 4: Run the manifest tests to verify they pass**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit manifest persistence and history tracking**

```bash
git add src/manifest.ts tests/manifest.test.ts
git commit -m "feat: store manifest history and local snapshots"
```

### Task 3: Classify deltas and apply conflict resolutions

**Files:**
- Create: `src/conflict.ts`
- Create: `tests/conflict.test.ts`

- [ ] **Step 1: Write the failing conflict and resolution tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  applyResolution,
  classifySkillDelta,
  getDiffRows,
  reconcileManifest
} from '../src/conflict.js';
import { createEmptyManifest } from '../src/manifest.js';

describe('conflict reconciliation', () => {
  it('classifySkillDelta returns push when local changed and remote still matches the baseline', () => {
    expect(classifySkillDelta('local-hash', 'recorded-hash', 'recorded-hash')).toEqual({
      direction: 'push',
      status: 'local-changed'
    });
  });

  it('classifySkillDelta returns pull when remote changed and local still matches the baseline', () => {
    expect(classifySkillDelta('recorded-hash', 'remote-hash', 'recorded-hash')).toEqual({
      direction: 'pull',
      status: 'remote-changed'
    });
  });

  it('classifySkillDelta returns conflict when both sides changed differently', () => {
    expect(classifySkillDelta('local-hash', 'remote-hash', 'recorded-hash')).toEqual({
      direction: 'conflict',
      status: 'conflict'
    });
  });

  it('applyResolution turns a conflict into push when taking local', () => {
    const manifest = createEmptyManifest('dev', '2026-05-01T00:00:00.000Z');
    manifest.skills.welcome = {
      local_hash: 'local-hash',
      remote_hash: 'remote-hash',
      recorded_hash: 'recorded-hash',
      direction: 'conflict',
      status: 'conflict'
    };

    const next = applyResolution(manifest, 'welcome', 'local', '2026-05-01T01:00:00.000Z');

    expect(next.skills.welcome).toMatchObject({
      recorded_hash: 'remote-hash',
      direction: 'push',
      status: 'local-changed'
    });
  });

  it('getDiffRows excludes skip rows and keeps pending work', () => {
    const manifest = createEmptyManifest('dev', '2026-05-01T00:00:00.000Z');
    manifest.skills.skipme = {
      local_hash: 'same',
      remote_hash: 'same',
      recorded_hash: 'same',
      direction: 'skip',
      status: 'in-sync'
    };
    manifest.skills.pushme = {
      local_hash: 'local-hash',
      remote_hash: 'recorded-hash',
      recorded_hash: 'recorded-hash',
      direction: 'push',
      status: 'local-changed'
    };

    expect(getDiffRows(reconcileManifest(manifest))).toEqual([
      {
        skill: 'pushme',
        server: 'dev',
        direction: 'push',
        status: 'local-changed',
        local_hash: 'local-hash',
        remote_hash: 'recorded-hash',
        recorded_hash: 'recorded-hash'
      }
    ]);
  });
});
```

- [ ] **Step 2: Run the conflict tests to verify they fail**

Run: `npx vitest run tests/conflict.test.ts`
Expected: FAIL with a missing module or export for `../src/conflict.js`.

- [ ] **Step 3: Create `src/conflict.ts` with delta and resolution logic**

```ts
import type { ManifestSkillState, ServerManifest, SyncDirection, SyncStatus } from './manifest.js';

export type ResolutionChoice = 'local' | 'remote';

export interface ManifestRow {
  skill: string;
  server: string;
  direction: SyncDirection;
  status: SyncStatus;
  local_hash: string | null;
  remote_hash: string | null;
  recorded_hash: string | null;
}

export function classifySkillDelta(
  localHash: string | null,
  remoteHash: string | null,
  recordedHash: string | null
): Pick<ManifestSkillState, 'direction' | 'status'> {
  if (localHash === remoteHash) {
    return {
      direction: 'skip',
      status: 'in-sync'
    };
  }

  if (recordedHash === null) {
    if (localHash !== null && remoteHash === null) {
      return {
        direction: 'push',
        status: 'new'
      };
    }

    if (localHash === null && remoteHash !== null) {
      return {
        direction: 'pull',
        status: 'new'
      };
    }
  }

  if (localHash === recordedHash && remoteHash === recordedHash) {
    return {
      direction: 'skip',
      status: 'in-sync'
    };
  }

  if (localHash !== recordedHash && remoteHash === recordedHash) {
    return {
      direction: 'push',
      status: 'local-changed'
    };
  }

  if (localHash === recordedHash && remoteHash !== recordedHash) {
    return {
      direction: 'pull',
      status: 'remote-changed'
    };
  }

  return {
    direction: 'conflict',
    status: 'conflict'
  };
}

export function reconcileSkillState(state: ManifestSkillState): ManifestSkillState {
  return {
    ...state,
    ...classifySkillDelta(state.local_hash, state.remote_hash, state.recorded_hash)
  };
}

export function reconcileManifest(manifest: ServerManifest, updatedAt = manifest.updated_at): ServerManifest {
  return {
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([skill, state]) => [skill, reconcileSkillState(state)])
    )
  };
}

export function getStatusRows(manifest: ServerManifest): ManifestRow[] {
  return Object.entries(reconcileManifest(manifest).skills).map(([skill, state]) => ({
    skill,
    server: manifest.server,
    direction: state.direction,
    status: state.status,
    local_hash: state.local_hash,
    remote_hash: state.remote_hash,
    recorded_hash: state.recorded_hash
  }));
}

export function getDiffRows(manifest: ServerManifest): ManifestRow[] {
  return getStatusRows(manifest).filter((row) => row.direction !== 'skip');
}

export function applyResolution(
  manifest: ServerManifest,
  skill: string,
  take: ResolutionChoice,
  updatedAt = new Date().toISOString()
): ServerManifest {
  const current = manifest.skills[skill];

  if (!current) {
    throw new Error(`Skill not found in manifest: ${skill}`);
  }

  const currentState = reconcileSkillState(current);

  if (currentState.direction !== 'conflict') {
    throw new Error(`Skill is not in conflict: ${skill}`);
  }

  const recordedHash = take === 'local' ? current.remote_hash : current.local_hash;

  return reconcileManifest(
    {
      ...manifest,
      updated_at: updatedAt,
      skills: {
        ...manifest.skills,
        [skill]: {
          ...current,
          recorded_hash: recordedHash
        }
      }
    },
    updatedAt
  );
}
```

- [ ] **Step 4: Run the conflict tests to verify they pass**

Run: `npx vitest run tests/conflict.test.ts`
Expected: PASS with 5 passing tests.

- [ ] **Step 5: Commit the conflict logic**

```bash
git add src/conflict.ts tests/conflict.test.ts
git commit -m "feat: add conflict classification and resolution"
```

### Task 4: Orchestrate refreshes over stored manifests

**Files:**
- Create: `src/refresh.ts`
- Create: `tests/refresh.test.ts`

- [ ] **Step 1: Write the failing refresh orchestration tests**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, saveConfig } from '../src/config.js';
import { refreshLocalManifest, saveServerManifest } from '../src/manifest.js';
import { autoRefreshManifests, listTrackedServers, refreshStoredManifests } from '../src/refresh.js';

describe('refresh orchestration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('listTrackedServers returns the union of configured servers and stored manifests', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {});
    config.servers = { dev: {} };
    await saveConfig(config, homeDir);
    await saveServerManifest(homeDir, {
      version: 1,
      server: 'prod',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {}
    });

    await expect(listTrackedServers(homeDir)).resolves.toEqual(['dev', 'prod']);
  });

  it('refreshStoredManifests recomputes local hashes for every tracked server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {});
    config.servers = { dev: {}, prod: {} };
    await saveConfig(config, homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# welcome', 'utf8');

    const manifests = await refreshStoredManifests(homeDir, {
      local: true,
      now: '2026-05-01T00:00:00.000Z'
    });

    expect(manifests.map((manifest) => manifest.server)).toEqual(['dev', 'prod']);
    expect(manifests[0].skills.welcome.local_hash).toMatch(/^[a-f0-9]{32}$/);
    expect(manifests[1].skills.welcome.local_hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it('autoRefreshManifests warns instead of throwing when refresh fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await autoRefreshManifests('/path/that/does/not/exist', true);

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('WARNING: auto refresh failed:'));
  });
});
```

- [ ] **Step 2: Run the refresh tests to verify they fail**

Run: `npx vitest run tests/refresh.test.ts`
Expected: FAIL with a missing module or export for `../src/refresh.js`.

- [ ] **Step 3: Create `src/refresh.ts` with tracked-server and refresh helpers**

```ts
import { readdir } from 'node:fs/promises';

import { loadConfig } from './config.js';
import { getDiffRows, getStatusRows, type ManifestRow, reconcileManifest } from './conflict.js';
import { getSyncPaths, type SyncSkillConfig } from './config.js';
import { loadServerManifest, refreshLocalManifest, saveServerManifest, type ServerManifest } from './manifest.js';

export interface RefreshOptions {
  local?: boolean;
  remote?: boolean;
  server?: string;
  now?: string;
}

function getConfiguredServerNames(config: SyncSkillConfig | null): string[] {
  if (!config || typeof config.servers !== 'object' || config.servers === null) {
    return [];
  }

  return Object.keys(config.servers).sort();
}

export async function listTrackedServers(homeDir: string): Promise<string[]> {
  const config = await loadConfig(homeDir).catch(() => null);
  const configuredServers = getConfiguredServerNames(config);
  const { manifestsDir } = getSyncPaths(homeDir);
  let manifestServers: string[] = [];

  try {
    const entries = await readdir(manifestsDir, { withFileTypes: true });
    manifestServers = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/u, ''))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return [...new Set([...configuredServers, ...manifestServers])].sort();
}

export async function loadTrackedManifests(homeDir: string, server?: string): Promise<ServerManifest[]> {
  const servers = server ? [server] : await listTrackedServers(homeDir);

  return Promise.all(
    servers.map(async (name) => reconcileManifest(await loadServerManifest(homeDir, name)))
  );
}

export async function refreshStoredManifests(homeDir: string, options: RefreshOptions = {}): Promise<ServerManifest[]> {
  const updatedAt = options.now ?? new Date().toISOString();
  const shouldRefreshLocal = options.local || (!options.local && !options.remote);
  const servers = options.server ? [options.server] : await listTrackedServers(homeDir);
  const refreshed: ServerManifest[] = [];

  for (const server of servers) {
    const manifest = shouldRefreshLocal
      ? await refreshLocalManifest(homeDir, server, updatedAt)
      : await loadServerManifest(homeDir, server);
    const reconciled = reconcileManifest(manifest, updatedAt);

    await saveServerManifest(homeDir, reconciled);
    refreshed.push(reconciled);
  }

  return refreshed;
}

export function formatStatusLines(manifests: ServerManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    getStatusRows(manifest).map((row) => `${row.skill}\t${row.server}\t${row.direction}\t${row.status}`)
  );
}

export function formatDiffLines(manifest: ServerManifest): string[] {
  return getDiffRows(manifest).map(
    (row) =>
      `${row.skill}\t${row.direction}\t${row.local_hash ?? '-'}\t${row.remote_hash ?? '-'}\t${row.recorded_hash ?? '-'}`
  );
}

export async function autoRefreshManifests(homeDir: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  try {
    await refreshStoredManifests(homeDir, { local: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARNING: auto refresh failed: ${message}`);
  }
}
```

- [ ] **Step 4: Run the refresh tests to verify they pass**

Run: `npx vitest run tests/refresh.test.ts`
Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the refresh orchestration**

```bash
git add src/refresh.ts tests/refresh.test.ts
git commit -m "feat: add manifest refresh orchestration"
```

### Task 5: Wire `status` and `diff <server>`

**Files:**
- Modify: `src/index.ts`
- Create: `tests/reconciliation-cli.test.ts`

- [ ] **Step 1: Write the failing CLI tests for `status` and `diff <server>`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, saveConfig } from '../src/config.js';
import { refreshLocalManifest, saveServerManifest } from '../src/manifest.js';
import { createProgram } from '../src/index.js';

describe('reconciliation CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('status prints one row per skill and server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {});
    config.servers = { dev: {} };
    await saveConfig(config, homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# welcome', 'utf8');

    const manifest = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T00:00:00.000Z');
    await saveServerManifest(homeDir, {
      ...manifest,
      skills: {
        welcome: {
          ...manifest.skills.welcome,
          remote_hash: manifest.skills.welcome.local_hash,
          recorded_hash: manifest.skills.welcome.local_hash
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'status'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledWith('welcome\tdev\tskip\tin-sync');
  });

  it('diff prints only the pending rows for one server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {});
    config.servers = { dev: {} };
    await saveConfig(config, homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# welcome', 'utf8');

    const manifest = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T00:00:00.000Z');
    const localHash = manifest.skills.welcome.local_hash as string;

    await saveServerManifest(homeDir, {
      ...manifest,
      skills: {
        welcome: {
          ...manifest.skills.welcome,
          remote_hash: 'ffffffffffffffffffffffffffffffff',
          recorded_hash: localHash,
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'diff', 'dev'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledWith(
      `welcome\tpull\t${localHash}\tffffffffffffffffffffffffffffffff\t${localHash}`
    );
  });
});
```

- [ ] **Step 2: Run the reconciliation CLI tests to verify they fail**

Run: `npx vitest run tests/reconciliation-cli.test.ts`
Expected: FAIL because `status` and `diff` are not registered in `src/index.ts` yet.

- [ ] **Step 3: Wire `status` and `diff <server>` in `src/index.ts`**

```ts
import { loadTrackedManifests, formatDiffLines, formatStatusLines } from './refresh.js';

program
  .command('status')
  .description('Show reconciliation status for all tracked servers')
  .action(async () => {
    const manifests = await loadTrackedManifests(resolvedHomeDir);

    for (const line of formatStatusLines(manifests)) {
      console.log(line);
    }
  });

program
  .command('diff <server>')
  .description('Show pending changes for one server')
  .action(async (server: string) => {
    const [manifest] = await loadTrackedManifests(resolvedHomeDir, server);

    for (const line of formatDiffLines(manifest)) {
      console.log(line);
    }
  });
```

- [ ] **Step 4: Run the reconciliation CLI tests to verify they pass**

Run: `npx vitest run tests/reconciliation-cli.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit `status` and `diff`**

```bash
git add src/index.ts tests/reconciliation-cli.test.ts
git commit -m "feat: add status and diff commands"
```

### Task 6: Wire `resolve <skill> --take local|remote`

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/reconciliation-cli.test.ts`

- [ ] **Step 1: Extend `tests/reconciliation-cli.test.ts` with a failing resolve test**

```ts
import { loadServerManifest } from '../src/manifest.js';

it('resolve updates every matching conflict to the chosen direction', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
  tempDirs.push(homeDir);

  const config = createDefaultConfig(homeDir, {});
  config.servers = { dev: {} };
  await saveConfig(config, homeDir);

  await saveServerManifest(homeDir, {
    version: 1,
    server: 'dev',
    updated_at: '2026-05-01T00:00:00.000Z',
    skills: {
      welcome: {
        local_hash: '11111111111111111111111111111111',
        remote_hash: '22222222222222222222222222222222',
        recorded_hash: '33333333333333333333333333333333',
        direction: 'conflict',
        status: 'conflict'
      }
    }
  });

  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await createProgram(homeDir).parseAsync(
    ['node', 'syncskill', 'resolve', 'welcome', '--take', 'local'],
    { from: 'node' }
  );

  await expect(loadServerManifest(homeDir, 'dev')).resolves.toMatchObject({
    skills: {
      welcome: {
        recorded_hash: '22222222222222222222222222222222',
        direction: 'push',
        status: 'local-changed'
      }
    }
  });
  expect(consoleLog).toHaveBeenCalledWith('welcome\tdev\tpush\tlocal-changed');
});
```

- [ ] **Step 2: Run the reconciliation CLI tests to verify they fail because `resolve` is not wired**

Run: `npx vitest run tests/reconciliation-cli.test.ts`
Expected: FAIL because `resolve` is not registered in `src/index.ts`.

- [ ] **Step 3: Wire `resolve` in `src/index.ts`**

```ts
import { applyResolution, reconcileManifest } from './conflict.js';
import { loadServerManifest, saveServerManifest } from './manifest.js';
import { listTrackedServers } from './refresh.js';

program
  .command('resolve <skill>')
  .description('Resolve a manifest conflict by choosing the next sync direction')
  .requiredOption('--take <side>', 'Choose local or remote', /^(local|remote)$/u)
  .action(async (skill: string, options: { take: 'local' | 'remote' }) => {
    const servers = await listTrackedServers(resolvedHomeDir);
    let matched = false;

    for (const server of servers) {
      const manifest = reconcileManifest(await loadServerManifest(resolvedHomeDir, server));

      if (!(skill in manifest.skills) || manifest.skills[skill].direction !== 'conflict') {
        continue;
      }

      const next = applyResolution(manifest, skill, options.take);
      await saveServerManifest(resolvedHomeDir, next);
      console.log(`${skill}\t${server}\t${next.skills[skill].direction}\t${next.skills[skill].status}`);
      matched = true;
    }

    if (!matched) {
      throw new Error(`No tracked conflict found for skill: ${skill}`);
    }
  });
```

- [ ] **Step 4: Run the reconciliation CLI tests to verify they pass**

Run: `npx vitest run tests/reconciliation-cli.test.ts`
Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the resolve command**

```bash
git add src/index.ts tests/reconciliation-cli.test.ts
git commit -m "feat: add conflict resolve command"
```

### Task 7: Wire `refresh`, add `--no-refresh`, and verify the milestone

**Files:**
- Modify: `src/index.ts`
- Modify: `src/refresh.ts`
- Modify: `tests/reconciliation-cli.test.ts`
- Modify: `tests/refresh.test.ts`

- [ ] **Step 1: Extend the tests with failing refresh and auto-refresh coverage**

```ts
it('refresh --local --status prints the refreshed status rows', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
  tempDirs.push(homeDir);

  const config = createDefaultConfig(homeDir, {});
  config.servers = { dev: {} };
  await saveConfig(config, homeDir);

  await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
  await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# welcome', 'utf8');

  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await createProgram(homeDir).parseAsync(
    ['node', 'syncskill', 'refresh', '--local', '--status', 'dev'],
    { from: 'node' }
  );

  expect(consoleLog).toHaveBeenCalledWith('welcome\tdev\tpush\tnew');
});

it('status auto-refreshes by default and respects --no-refresh', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
  tempDirs.push(homeDir);

  const config = createDefaultConfig(homeDir, {});
  config.servers = { dev: {} };
  await saveConfig(config, homeDir);

  await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
  await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# one', 'utf8');

  const first = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T00:00:00.000Z');
  await saveServerManifest(homeDir, {
    ...first,
    skills: {
      welcome: {
        ...first.skills.welcome,
        remote_hash: first.skills.welcome.local_hash,
        recorded_hash: first.skills.welcome.local_hash
      }
    }
  });

  await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), '# two', 'utf8');

  const withoutRefresh = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'status'], { from: 'node' });
  expect(withoutRefresh).toHaveBeenCalledWith('welcome\tdev\tskip\tin-sync');

  withoutRefresh.mockReset();

  await createProgram(homeDir).parseAsync(['node', 'syncskill', 'status'], { from: 'node' });
  expect(withoutRefresh).toHaveBeenCalledWith('welcome\tdev\tpush\tlocal-changed');
});
```

- [ ] **Step 2: Run the CLI and refresh tests to verify they fail**

Run: `npx vitest run tests/reconciliation-cli.test.ts tests/refresh.test.ts`
Expected: FAIL because `refresh` and the global `--no-refresh` behavior are not wired yet.

- [ ] **Step 3: Extend `src/refresh.ts` with reusable helpers for CLI refresh and auto-refresh**

```ts
export function shouldRefreshLocal(options: RefreshOptions): boolean {
  return Boolean(options.local) || (!options.local && !options.remote);
}

export function shouldRefreshRemote(options: RefreshOptions): boolean {
  return Boolean(options.remote);
}
```

- [ ] **Step 4: Wire `refresh` and global auto-refresh in `src/index.ts`**

```ts
import type { Command } from 'commander';

import { autoRefreshManifests, formatStatusLines, refreshStoredManifests } from './refresh.js';

function commandIncludes(command: Command, name: string): boolean {
  let current: Command | null = command;

  while (current) {
    if (current.name() === name) {
      return true;
    }

    current = current.parent ?? null;
  }

  return false;
}

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool')
    .option('--no-refresh', 'Skip manifest auto-refresh before command execution');

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (commandIncludes(actionCommand, 'init') || commandIncludes(actionCommand, 'config') || commandIncludes(actionCommand, 'refresh')) {
      return;
    }

    await autoRefreshManifests(resolvedHomeDir, program.opts<{ refresh: boolean }>().refresh);
  });

  program
    .command('refresh [server]')
    .description('Refresh stored manifest state for one server or all tracked servers')
    .option('--local', 'Recalculate local hashes from ~/.syncskill/skills')
    .option('--remote', 'Re-evaluate stored remote snapshots already present on disk')
    .option('--status', 'Print status rows after refresh completes')
    .action(async (server: string | undefined, options: { local?: boolean; remote?: boolean; status?: boolean }) => {
      const manifests = await refreshStoredManifests(resolvedHomeDir, {
        local: Boolean(options.local),
        remote: Boolean(options.remote),
        server
      });

      if (options.status) {
        for (const line of formatStatusLines(manifests)) {
          console.log(line);
        }
      }
    });

  return program;
}
```

- [ ] **Step 5: Run the full Milestone 2 tests**

Run: `npm test`
Expected: PASS with all Milestone 1 and Milestone 2 tests green.

- [ ] **Step 6: Build the CLI and run a help smoke test**

Run: `npm run build && node dist/index.js --help`
Expected: PASS and the help text includes `status`, `diff`, `resolve`, and `refresh`.

- [ ] **Step 7: Commit the completed Milestone 2 slice**

```bash
git add src/index.ts src/refresh.ts tests/reconciliation-cli.test.ts tests/refresh.test.ts src/manifest.ts src/conflict.ts tests/manifest.test.ts tests/conflict.test.ts
git commit -m "feat: deliver syncskill state and reconciliation milestone"
```

## Self-Review

**Spec coverage:**
- `manifest.ts` hashing, manifest IO, and history append behavior: covered in Tasks 1 and 2
- delta classification and deterministic conflict handling: covered in Task 3
- `status`: covered in Task 5
- `diff <server>`: covered in Task 5
- `resolve <skill> --take local|remote`: covered in Task 6
- `refresh [--local | --remote | --status] [server]`: covered in Task 7
- `--no-refresh` and pre-command auto-refresh behavior from the base spec: covered in Task 7

**Placeholder scan:**
- No `TODO`, `TBD`, or vague “add tests” steps remain.
- Every code-changing step includes concrete TypeScript or shell content.
- Commands include exact test/build invocations and expected outcomes.

**Type consistency:**
- `ServerManifest`, `ManifestSkillState`, `ManifestHistory`, `classifySkillDelta`, `reconcileManifest`, `applyResolution`, `refreshStoredManifests`, and `autoRefreshManifests` are used consistently across tasks.
- `recorded_hash` is the only persisted baseline field throughout the plan; later tasks do not introduce a second baseline name.
- `direction` stays `push | pull | skip | conflict` throughout the plan, while `status` carries `new` when needed.
