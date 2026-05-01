# syncskill Remote Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 4 of `syncskill`: real remote transport plus `push`, `pull`, and `sync` workflows over configured servers.

**Architecture:** Keep shell transport concerns in `src/transport.ts` and synchronization policy in `src/sync_engine.ts`. Remote state is still persisted in the existing local manifest files under `~/.syncskill/manifests/`, while the remote host runs a zero-dependency receiver under `~/.syncskill/` that can return its manifest, accept manifest updates, import/export skill trees, and relink remote agent directories.

**Tech Stack:** TypeScript, Node 20 ESM, commander, yaml, vitest, Node built-ins (`fs/promises`, `path`, `child_process`, `stream`, `os`)

---

## File Map

**Create:**
- `src/transport.ts` — server config lookup, SSH/rsync command construction, receiver deployment, manifest transfer, skill transfer, rsync fallback helpers
- `src/sync_engine.ts` — push/pull/sync orchestration and conflict-policy application
- `src/receiver/bootstrap_remote.sh` — remote bootstrap script that creates `~/.syncskill/` and validates `node`
- `src/receiver/sync_receiver.mjs` — remote manifest/skill import-export/apply entrypoint
- `tests/transport.test.ts` — transport command and receiver-IO coverage
- `tests/sync-engine.test.ts` — push/pull/sync policy coverage with transport stubs
- `tests/sync-cli.test.ts` — CLI wiring plus one end-to-end fake-transport integration path

**Modify:**
- `src/config.ts` — add typed server lookup helpers without breaking existing permissive config loading
- `src/manifest.ts` — add remote snapshot merge/finalization helpers used by sync orchestration
- `src/index.ts` — register `push`, `pull`, and `sync` commands
- `tests/config.test.ts` — cover server lookup normalization
- `tests/manifest.test.ts` — cover remote snapshot/finalization helpers

**Do not modify in this milestone unless a failing test requires it:**
- `src/config-ui.ts`
- `src/repo.ts`
- `src/linker.ts`
- `src/source.ts`
- `src/conflict.ts`
- `src/refresh.ts`

## Remote Config Contract

Milestone 4 should treat `config.yaml` server entries as permissive raw data at load time, then normalize only when a remote command targets one of them.

```yaml
servers:
  alpha:
    host: alpha.example.com
    user: deploy
    port: 2222
    identity_file: /Users/demo/.ssh/id_syncskill
    remote_agents:
      claude: ~/.claude/skills
      qoder: ~/.qoder/skills
  beta:
    host: beta.example.com
    remote_agents:
      claude: ~/.claude/skills
```

Normalization rules:
- `host` is required when a server is actually used by `push`, `pull`, or `sync`
- `user`, `port`, and `identity_file` are optional
- `remote_agents` defaults to `{}` and filters out non-string values
- older tests and configs that save `servers: { alpha: {} }` must still load successfully; only a remote command targeting `alpha` should throw `Server config is invalid: alpha`

## Remote Layout and Receiver Contract

The receiver owns one remote root per host:

```text
~/.syncskill/
├── skills/
├── manifest.json
├── receiver_config.json
└── sync_receiver.mjs
```

`receiver_config.json` should contain only the agent-link mapping needed remotely:

```json
{
  "remote_agents": {
    "claude": "~/.claude/skills",
    "qoder": "~/.qoder/skills"
  }
}
```

`sync_receiver.mjs` should support these subcommands:
- `manifest` — print `manifest.json` or an empty manifest JSON when the file is missing
- `write-manifest` — read manifest JSON from stdin and save it
- `import-skill <name>` — read a JSON file tree from stdin and replace `skills/<name>`
- `export-skill <name>` — print a JSON file tree for `skills/<name>`
- `apply` — relink remote agents and recompute remote hashes in `manifest.json`

## Command Contract

This milestone should ship these CLI shapes:

```text
syncskill push [server] [--all]
syncskill pull <server>
syncskill sync [server] [--all]
```

Behavior:
- `push <server>` pushes one server
- `push --all` and bare `push` push all configured servers
- `pull <server>` pulls exactly one server
- `sync <server>` performs pull-then-push for one server
- `sync --all` and bare `sync` pull every configured server first, refresh local state, then push all servers
- manual conflicts remain persisted as `conflict` rows and are not transferred
- `keep-local` turns conflict rows into push work during `push` / `sync`
- `keep-remote` turns conflict rows into pull work during `pull` / `sync`
- CLI output should print one row per affected skill using the existing tab-separated shape: `<skill>\t<server>\t<direction>\t<status>`

### Task 1: Add remote server lookup and manifest transition helpers

**Files:**
- Modify: `src/config.ts`
- Modify: `src/manifest.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/manifest.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { getConfiguredServer } from '../src/config.js';
import {
  applyRemoteSnapshot,
  collectRemoteHistoryEntries,
  createEmptyManifest,
  finalizePulledSkills,
  finalizePushedSkills
} from '../src/manifest.js';

it('getConfiguredServer normalizes host, auth fields, and remote agent mappings', () => {
  const config = validateConfig({
    version: 1,
    conflict_resolution: 'manual',
    agents: {},
    links: {},
    servers: {
      alpha: {
        host: 'alpha.example.com',
        user: 'deploy',
        port: 2222,
        identity_file: '/Users/demo/.ssh/id_syncskill',
        remote_agents: {
          claude: '~/.claude/skills',
          qoder: '~/.qoder/skills',
          broken: 123
        }
      },
      broken: {
        user: 'deploy'
      }
    },
    sources: {}
  });

  expect(getConfiguredServer(config, 'alpha')).toEqual({
    name: 'alpha',
    host: 'alpha.example.com',
    user: 'deploy',
    port: 2222,
    identity_file: '/Users/demo/.ssh/id_syncskill',
    remote_agents: {
      claude: '~/.claude/skills',
      qoder: '~/.qoder/skills'
    }
  });
  expect(() => getConfiguredServer(config, 'broken')).toThrow('Server config is invalid: broken');
  expect(() => getConfiguredServer(config, 'missing')).toThrow('Server not found: missing');
});

it('applyRemoteSnapshot merges remote hashes into an existing manifest', () => {
  const previous = {
    ...createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'),
    skills: {
      welcome: {
        local_hash: 'local-1',
        remote_hash: 'remote-1',
        recorded_hash: 'remote-1',
        direction: 'push',
        status: 'local-changed'
      }
    }
  };

  expect(
    applyRemoteSnapshot(previous, { welcome: 'remote-2', docs: 'remote-3' }, '2026-05-01T01:00:00.000Z')
  ).toEqual({
    version: 1,
    server: 'alpha',
    updated_at: '2026-05-01T01:00:00.000Z',
    skills: {
      docs: {
        local_hash: null,
        remote_hash: 'remote-3',
        recorded_hash: null,
        direction: 'pull',
        status: 'new'
      },
      welcome: {
        local_hash: 'local-1',
        remote_hash: 'remote-2',
        recorded_hash: 'remote-1',
        direction: 'conflict',
        status: 'conflict'
      }
    }
  });
});

it('collectRemoteHistoryEntries records only actual remote hash changes', () => {
  const previous = {
    ...createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'),
    skills: {
      welcome: {
        local_hash: 'local-1',
        remote_hash: 'remote-1',
        recorded_hash: 'remote-1',
        direction: 'skip',
        status: 'in-sync'
      }
    }
  };
  const next = applyRemoteSnapshot(previous, { welcome: 'remote-2', docs: 'remote-3' }, '2026-05-01T01:00:00.000Z');

  expect(collectRemoteHistoryEntries(previous, next, '2026-05-01T01:00:00.000Z')).toEqual([
    {
      skill: 'docs',
      server: 'alpha',
      old_hash: null,
      new_hash: 'remote-3',
      direction: 'remote',
      updated_at: '2026-05-01T01:00:00.000Z'
    },
    {
      skill: 'welcome',
      server: 'alpha',
      old_hash: 'remote-1',
      new_hash: 'remote-2',
      direction: 'remote',
      updated_at: '2026-05-01T01:00:00.000Z'
    }
  ]);
});

it('finalizePushedSkills promotes local hashes to the shared baseline', () => {
  const manifest = finalizePushedSkills(
    {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T01:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-2',
          remote_hash: 'remote-1',
          recorded_hash: 'remote-1',
          direction: 'push',
          status: 'local-changed'
        }
      }
    },
    ['welcome'],
    '2026-05-01T02:00:00.000Z'
  );

  expect(manifest.skills.welcome).toEqual({
    local_hash: 'local-2',
    remote_hash: 'local-2',
    recorded_hash: 'local-2',
    direction: 'skip',
    status: 'in-sync'
  });
});

it('finalizePulledSkills promotes remote hashes to the shared baseline', () => {
  const manifest = finalizePulledSkills(
    {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T01:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-1',
          remote_hash: 'remote-2',
          recorded_hash: 'local-1',
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    },
    ['welcome'],
    '2026-05-01T02:00:00.000Z'
  );

  expect(manifest.skills.welcome).toEqual({
    local_hash: 'remote-2',
    remote_hash: 'remote-2',
    recorded_hash: 'remote-2',
    direction: 'skip',
    status: 'in-sync'
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/manifest.test.ts`
Expected: FAIL with missing exports for `getConfiguredServer`, `applyRemoteSnapshot`, `collectRemoteHistoryEntries`, `finalizePushedSkills`, and `finalizePulledSkills`.

- [ ] **Step 3: Add the minimal helper implementations**

```ts
// src/config.ts
export interface ConfiguredServer {
  name: string;
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
  remote_agents: Record<string, string>;
}

export function getConfiguredServer(config: SyncSkillConfig, name: string): ConfiguredServer {
  const raw = config.servers[name];

  if (raw === undefined) {
    throw new Error(`Server not found: ${name}`);
  }

  if (!isRecord(raw) || typeof raw.host !== 'string') {
    throw new Error(`Server config is invalid: ${name}`);
  }

  return {
    name,
    host: raw.host,
    ...(typeof raw.user === 'string' ? { user: raw.user } : {}),
    ...(typeof raw.port === 'number' ? { port: raw.port } : {}),
    ...(typeof raw.identity_file === 'string' ? { identity_file: raw.identity_file } : {}),
    remote_agents: isRecord(raw.remote_agents)
      ? Object.fromEntries(
          Object.entries(raw.remote_agents).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : {}
  };
}
```

```ts
// src/manifest.ts
import { reconcileManifest } from './conflict.js';

export function applyRemoteSnapshot(
  manifest: ServerManifest,
  remoteHashes: Record<string, string>,
  updatedAt: string
): ServerManifest {
  const skillNames = [...new Set([...Object.keys(manifest.skills), ...Object.keys(remoteHashes)])].sort();

  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      skillNames.map((skill) => {
        const previous = manifest.skills[skill] ?? {
          local_hash: null,
          remote_hash: null,
          recorded_hash: null,
          direction: 'skip',
          status: 'in-sync'
        };

        return [
          skill,
          {
            ...previous,
            remote_hash: remoteHashes[skill] ?? null
          }
        ];
      })
    )
  });
}

export function collectRemoteHistoryEntries(
  previous: ServerManifest,
  next: ServerManifest,
  updatedAt: string
): ManifestHistoryEntry[] {
  const skillNames = [...new Set([...Object.keys(previous.skills), ...Object.keys(next.skills)])].sort();

  return skillNames.flatMap((skill) => {
    const before = previous.skills[skill]?.remote_hash ?? null;
    const after = next.skills[skill]?.remote_hash ?? null;

    if (before === after) {
      return [];
    }

    return [
      {
        skill,
        server: next.server,
        old_hash: before,
        new_hash: after,
        direction: 'remote',
        updated_at: updatedAt
      }
    ];
  });
}

export function finalizePushedSkills(
  manifest: ServerManifest,
  skills: string[],
  updatedAt: string
): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill) || state.local_hash === null) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            remote_hash: state.local_hash,
            recorded_hash: state.local_hash
          }
        ];
      })
    )
  });
}

export function finalizePulledSkills(
  manifest: ServerManifest,
  skills: string[],
  updatedAt: string
): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill) || state.remote_hash === null) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            local_hash: state.remote_hash,
            recorded_hash: state.remote_hash
          }
        ];
      })
    )
  });
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/manifest.test.ts`
Expected: PASS with the new helper cases green and no regressions in the earlier config/manifest cases.

- [ ] **Step 5: Commit the remote-state helpers**

```bash
git add src/config.ts src/manifest.ts tests/config.test.ts tests/manifest.test.ts
git commit -m "feat: add remote sync state helpers"
```

### Task 2: Add receiver assets and transport primitives

**Files:**
- Create: `src/transport.ts`
- Create: `src/receiver/bootstrap_remote.sh`
- Create: `src/receiver/sync_receiver.mjs`
- Create: `tests/transport.test.ts`

- [ ] **Step 1: Write the failing transport tests**

```ts
import { describe, expect, it, vi } from 'vitest';

import { createEmptyManifest } from '../src/manifest.js';
import {
  deployReceiver,
  fetchRemoteManifest,
  pushManifest,
  pushSkillDirectory,
  pullSkillDirectory,
  type TransportRuntime
} from '../src/transport.js';

function createRuntime(stdoutByCommand: Record<string, string> = {}): TransportRuntime {
  const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];

  return {
    calls,
    async exec(file, args, options = {}) {
      const key = [file, ...args].join(' ');
      calls.push({
        file,
        args,
        stdin: typeof options.stdin === 'string' ? options.stdin : undefined
      });

      if (key in stdoutByCommand) {
        return { stdout: stdoutByCommand[key], stderr: '' };
      }

      if (file === 'rsync' && args.includes('--version')) {
        return { stdout: 'rsync 3.2.7', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }
  };
}

it('deployReceiver uploads bootstrap, receiver, and receiver config over ssh', async () => {
  const runtime = createRuntime();

  await deployReceiver(
    {
      name: 'alpha',
      host: 'alpha.example.com',
      user: 'deploy',
      port: 2222,
      identity_file: '/Users/demo/.ssh/id_syncskill',
      remote_agents: {
        claude: '~/.claude/skills'
      }
    },
    runtime
  );

  expect(runtime.calls.map((call) => [call.file, ...call.args])).toEqual(
    expect.arrayContaining([
      [
        'ssh',
        '-p',
        '2222',
        '-i',
        '/Users/demo/.ssh/id_syncskill',
        'deploy@alpha.example.com',
        'sh',
        '-s'
      ],
      [
        'ssh',
        '-p',
        '2222',
        '-i',
        '/Users/demo/.ssh/id_syncskill',
        'deploy@alpha.example.com',
        'sh',
        '-lc',
        'cat > ~/.syncskill/sync_receiver.mjs'
      ],
      [
        'ssh',
        '-p',
        '2222',
        '-i',
        '/Users/demo/.ssh/id_syncskill',
        'deploy@alpha.example.com',
        'sh',
        '-lc',
        'cat > ~/.syncskill/receiver_config.json'
      ]
    ])
  );
});

it('fetchRemoteManifest reads manifest JSON through the receiver command', async () => {
  const manifestJson = JSON.stringify(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'));
  const runtime = createRuntime({
    'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs manifest': manifestJson
  });

  await expect(
    fetchRemoteManifest(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {}
      },
      runtime
    )
  ).resolves.toEqual(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'));
});

it('pushManifest writes manifest JSON through stdin', async () => {
  const runtime = createRuntime();
  const manifest = createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z');

  await pushManifest(
    {
      name: 'alpha',
      host: 'alpha.example.com',
      remote_agents: {}
    },
    manifest,
    runtime
  );

  expect(runtime.calls.at(-1)).toMatchObject({
    file: 'ssh',
    args: ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'write-manifest'],
    stdin: `${JSON.stringify(manifest, null, 2)}\n`
  });
});

it('pushSkillDirectory prefers rsync and falls back to receiver import when rsync is unavailable', async () => {
  const runtime = createRuntime();
  runtime.exec = vi
    .fn<TransportRuntime['exec']>()
    .mockResolvedValueOnce({ stdout: '', stderr: 'missing rsync' })
    .mockResolvedValue({ stdout: '', stderr: '' });

  await pushSkillDirectory(
    {
      name: 'alpha',
      host: 'alpha.example.com',
      remote_agents: {}
    },
    '/tmp/home/.syncskill/skills/welcome',
    'welcome',
    runtime
  );

  expect(runtime.exec).toHaveBeenCalledWith('rsync', expect.any(Array), expect.anything());
  expect(runtime.exec).toHaveBeenCalledWith(
    'ssh',
    ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'import-skill', 'welcome'],
    expect.objectContaining({ stdin: expect.stringContaining('SKILL.md') })
  );
});

it('pullSkillDirectory falls back to receiver export when rsync is unavailable', async () => {
  const runtime = createRuntime();
  runtime.exec = vi
    .fn<TransportRuntime['exec']>()
    .mockResolvedValueOnce({ stdout: '', stderr: 'missing rsync' })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ 'SKILL.md': Buffer.from('# welcome\n').toString('base64') }),
      stderr: ''
    });

  await pullSkillDirectory(
    {
      name: 'alpha',
      host: 'alpha.example.com',
      remote_agents: {}
    },
    'welcome',
    '/tmp/home/.syncskill/skills/welcome',
    runtime
  );

  expect(runtime.exec).toHaveBeenCalledWith(
    'ssh',
    ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'export-skill', 'welcome'],
    expect.anything()
  );
});
```

- [ ] **Step 2: Run the transport tests to verify they fail**

Run: `npx vitest run tests/transport.test.ts`
Expected: FAIL with a missing module for `../src/transport.js`.

- [ ] **Step 3: Create the receiver assets and transport module**

```sh
# src/receiver/bootstrap_remote.sh
#!/usr/bin/env sh
set -eu

SYNC_ROOT="$HOME/.syncskill"
mkdir -p "$SYNC_ROOT/skills"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required on the remote host" >&2
  exit 1
fi
```

```js
// src/receiver/sync_receiver.mjs
#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';

const syncRoot = join(homedir(), '.syncskill');
const skillsDir = join(syncRoot, 'skills');
const manifestFile = join(syncRoot, 'manifest.json');
const configFile = join(syncRoot, 'receiver_config.json');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function hashSkillDirectory(skillDir, currentDir = skillDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await hashSkillDirectory(skillDir, fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push({
        relativePath: relative(skillDir, fullPath).replaceAll('\\', '/'),
        contents: await readFile(fullPath)
      });
    }
  }

  if (currentDir !== skillDir) {
    return files;
  }

  const hash = createHash('md5');
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(Buffer.from(file.relativePath, 'utf8'));
    hash.update(file.contents);
  }
  return hash.digest('hex');
}

async function readManifest() {
  return readJson(manifestFile, {
    version: 1,
    server: 'remote',
    updated_at: new Date().toISOString(),
    skills: {}
  });
}

async function writeManifestFromStdin() {
  let stdin = '';
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  await mkdir(syncRoot, { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(JSON.parse(stdin), null, 2)}\n`, 'utf8');
}

async function importSkill(name) {
  let stdin = '';
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  const files = JSON.parse(stdin);
  const targetDir = join(skillsDir, name);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const [relativePath, base64] of Object.entries(files)) {
    const destination = resolve(targetDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(base64, 'base64'));
  }
}

async function exportSkill(name) {
  const targetDir = join(skillsDir, name);
  const files = {};

  async function walk(rootDir, currentDir = rootDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(rootDir, fullPath);
      } else if (entry.isFile()) {
        files[relative(rootDir, fullPath).replaceAll('\\', '/')] = (await readFile(fullPath)).toString('base64');
      }
    }
  }

  await walk(targetDir);
  process.stdout.write(`${JSON.stringify(files)}\n`);
}

async function applyLinks() {
  const manifest = await readManifest();
  const config = await readJson(configFile, { remote_agents: {} });

  for (const [agent, agentDir] of Object.entries(config.remote_agents ?? {})) {
    await mkdir(resolve(agentDir), { recursive: true });
    for (const skill of Object.keys(manifest.skills).sort()) {
      const sourceDir = join(skillsDir, skill);
      const targetDir = join(resolve(agentDir), skill);

      try {
        const stats = await lstat(targetDir);
        if (stats.isSymbolicLink() || stats.isDirectory()) {
          await rm(targetDir, { recursive: true, force: true });
        }
      } catch {
        // nothing to clean
      }

      await symlink(sourceDir, targetDir, 'dir');
    }
  }

  process.stdout.write(`${JSON.stringify(await readManifest())}\n`);
}

const [command, arg] = process.argv.slice(2);

if (command === 'manifest') {
  process.stdout.write(`${JSON.stringify(await readManifest())}\n`);
} else if (command === 'write-manifest') {
  await writeManifestFromStdin();
} else if (command === 'import-skill' && typeof arg === 'string') {
  await importSkill(arg);
} else if (command === 'export-skill' && typeof arg === 'string') {
  await exportSkill(arg);
} else if (command === 'apply') {
  await applyLinks();
} else {
  throw new Error(`Unsupported receiver command: ${command ?? ''}`.trim());
}
```

```ts
// src/transport.ts
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type ConfiguredServer } from './config.js';
import { createEmptyManifest, type ServerManifest } from './manifest.js';

const execFileAsync = promisify(execFile);

export interface TransportRuntime {
  calls?: Array<{ file: string; args: string[]; stdin?: string }>;
  exec(
    file: string,
    args: string[],
    options?: { stdin?: string }
  ): Promise<{ stdout: string; stderr: string }>;
}

export function createTransportRuntime(): TransportRuntime {
  return {
    async exec(file, args, options = {}) {
      const result = await execFileAsync(file, args, options.stdin === undefined ? {} : { input: options.stdin });
      return {
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  };
}

function buildSshArgs(server: ConfiguredServer, remoteArgs: string[]): string[] {
  return [
    ...(typeof server.port === 'number' ? ['-p', String(server.port)] : []),
    ...(typeof server.identity_file === 'string' ? ['-i', server.identity_file] : []),
    typeof server.user === 'string' ? `${server.user}@${server.host}` : server.host,
    ...remoteArgs
  ];
}

export async function deployReceiver(server: ConfiguredServer, runtime: TransportRuntime): Promise<void> {
  const bootstrap = await readFile(new URL('./receiver/bootstrap_remote.sh', import.meta.url), 'utf8');
  const receiver = await readFile(new URL('./receiver/sync_receiver.mjs', import.meta.url), 'utf8');

  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-s']), { stdin: bootstrap });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', 'cat > ~/.syncskill/sync_receiver.mjs']), { stdin: receiver });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', 'cat > ~/.syncskill/receiver_config.json']), {
    stdin: `${JSON.stringify({ remote_agents: server.remote_agents }, null, 2)}\n`
  });
}

export async function fetchRemoteManifest(server: ConfiguredServer, runtime: TransportRuntime): Promise<ServerManifest> {
  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', '~/.syncskill/sync_receiver.mjs', 'manifest']));
  const parsed = JSON.parse(result.stdout || '{}') as Partial<ServerManifest>;
  return {
    ...createEmptyManifest(server.name),
    ...parsed,
    server: server.name
  };
}

export async function pushManifest(
  server: ConfiguredServer,
  manifest: ServerManifest,
  runtime: TransportRuntime
): Promise<void> {
  await runtime.exec('ssh', buildSshArgs(server, ['node', '~/.syncskill/sync_receiver.mjs', 'write-manifest']), {
    stdin: `${JSON.stringify(manifest, null, 2)}\n`
  });
}

async function collectSkillFiles(skillDir: string, currentDir = skillDir): Promise<Record<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await collectSkillFiles(skillDir, fullPath));
    } else if (entry.isFile()) {
      files[relative(skillDir, fullPath).replaceAll('\\', '/')] = (await readFile(fullPath)).toString('base64');
    }
  }

  return files;
}

export async function pushSkillDirectory(
  server: ConfiguredServer,
  sourceDir: string,
  skill: string,
  runtime: TransportRuntime
): Promise<void> {
  try {
    await runtime.exec('rsync', ['-az', '--delete', `${sourceDir}/`, `${server.host}:~/.syncskill/skills/${skill}/`]);
    return;
  } catch {
    await runtime.exec('ssh', buildSshArgs(server, ['node', '~/.syncskill/sync_receiver.mjs', 'import-skill', skill]), {
      stdin: JSON.stringify(await collectSkillFiles(sourceDir))
    });
  }
}

export async function pullSkillDirectory(
  server: ConfiguredServer,
  skill: string,
  targetDir: string,
  runtime: TransportRuntime
): Promise<void> {
  try {
    await mkdir(dirname(targetDir), { recursive: true });
    await runtime.exec('rsync', ['-az', '--delete', `${server.host}:~/.syncskill/skills/${skill}/`, `${targetDir}/`]);
    return;
  } catch {
    const exported = await runtime.exec('ssh', buildSshArgs(server, ['node', '~/.syncskill/sync_receiver.mjs', 'export-skill', skill]));
    const files = JSON.parse(exported.stdout) as Record<string, string>;

    await mkdir(targetDir, { recursive: true });
    for (const [relativePath, base64] of Object.entries(files)) {
      const destination = join(targetDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(base64, 'base64'));
    }
  }
}
```

- [ ] **Step 4: Run the transport tests to verify they pass**

Run: `npx vitest run tests/transport.test.ts`
Expected: PASS with receiver upload, manifest IO, and rsync-fallback behavior covered.

- [ ] **Step 5: Commit the transport layer**

```bash
git add src/transport.ts src/receiver/bootstrap_remote.sh src/receiver/sync_receiver.mjs tests/transport.test.ts
git commit -m "feat: add remote transport primitives"
```

### Task 3: Add push and pull orchestration

**Files:**
- Create: `src/sync_engine.ts`
- Create: `tests/sync-engine.test.ts`

- [ ] **Step 1: Write the failing sync-engine tests**

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config.js';
import { getSyncPaths } from '../src/config.js';
import { loadManifestHistory, loadServerManifest, saveServerManifest } from '../src/manifest.js';
import { pullFromServer, pushToServers } from '../src/sync_engine.js';

function createTransportStub() {
  const pulled = new Map<string, string>();
  const pushed = new Map<string, string>();
  let remoteManifest = {
    version: 1 as const,
    server: 'alpha',
    updated_at: '2026-05-01T00:00:00.000Z',
    skills: {}
  };

  return {
    pushed,
    pulled,
    async ensureReceiver() {},
    async fetchRemoteManifest() {
      return remoteManifest;
    },
    async pushManifest(_server: unknown, manifest: typeof remoteManifest) {
      remoteManifest = manifest;
    },
    async pushSkillDirectory(_server: unknown, sourceDir: string, skill: string) {
      pushed.set(skill, await readFile(join(sourceDir, 'SKILL.md'), 'utf8'));
    },
    async pullSkillDirectory(_server: unknown, skill: string, targetDir: string) {
      const contents = pulled.get(skill);
      if (contents === undefined) {
        throw new Error(`Missing remote fixture for ${skill}`);
      }
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'SKILL.md'), contents, 'utf8');
    },
    setRemoteManifest(next: typeof remoteManifest) {
      remoteManifest = next;
    }
  };
}

describe('sync engine', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('pushToServers deploys, transfers pushable skills, and persists an in-sync manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {}
          }
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const transport = createTransportStub();
    const rows = await pushToServers(homeDir, { server: 'alpha', now: '2026-05-01T01:00:00.000Z' }, transport);

    expect(rows).toEqual([{ skill: 'welcome', server: 'alpha', direction: 'push', status: 'new' }]);
    expect(transport.pushed.get('welcome')).toBe('# welcome\n');
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'skip',
          status: 'in-sync',
          local_hash: expect.any(String),
          remote_hash: expect.any(String),
          recorded_hash: expect.any(String)
        }
      }
    });
  });

  it('pullFromServer downloads remote-only skills and updates manifest history', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {}
          }
        },
        sources: {}
      },
      homeDir
    );

    const transport = createTransportStub();
    transport.pulled.set('welcome', '# remote welcome\n');
    transport.setRemoteManifest({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T01:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    const rows = await pullFromServer(homeDir, 'alpha', { now: '2026-05-01T02:00:00.000Z' }, transport);

    expect(rows).toEqual([{ skill: 'welcome', server: 'alpha', direction: 'pull', status: 'new' }]);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'utf8')).resolves.toBe('# remote welcome\n');
    await expect(loadManifestHistory(homeDir)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          skill: 'welcome',
          server: 'alpha',
          direction: 'remote'
        })
      ]
    });
  });

  it('manual conflicts stay blocked while keep-local pushes them and keep-remote pulls them', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    const baseConfig = {
      version: 1,
      agents: {},
      links: {},
      servers: {
        alpha: {
          host: 'alpha.example.com',
          remote_agents: {}
        }
      },
      sources: {}
    };

    await saveConfig({ ...baseConfig, conflict_resolution: 'manual' }, homeDir);
    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-1',
          remote_hash: 'remote-1',
          recorded_hash: 'base-1',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const manualTransport = createTransportStub();
    expect(await pushToServers(homeDir, { server: 'alpha', now: '2026-05-01T01:00:00.000Z' }, manualTransport)).toEqual([
      { skill: 'welcome', server: 'alpha', direction: 'conflict', status: 'conflict' }
    ]);
    expect(manualTransport.pushed.size).toBe(0);

    await saveConfig({ ...baseConfig, conflict_resolution: 'keep-local' }, homeDir);
    const keepLocalTransport = createTransportStub();
    await pushToServers(homeDir, { server: 'alpha', now: '2026-05-01T02:00:00.000Z' }, keepLocalTransport);
    expect(keepLocalTransport.pushed.size).toBe(1);

    await saveConfig({ ...baseConfig, conflict_resolution: 'keep-remote' }, homeDir);
    const keepRemoteTransport = createTransportStub();
    keepRemoteTransport.pulled.set('welcome', '# remote welcome\n');
    await pullFromServer(homeDir, 'alpha', { now: '2026-05-01T03:00:00.000Z' }, keepRemoteTransport);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'utf8')).resolves.toBe('# remote welcome\n');
  });
});
```

- [ ] **Step 2: Run the sync-engine tests to verify they fail**

Run: `npx vitest run tests/sync-engine.test.ts`
Expected: FAIL with a missing module for `../src/sync_engine.js`.

- [ ] **Step 3: Create the push/pull engine**

```ts
// src/sync_engine.ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getSyncPaths, getConfiguredServer, loadConfig } from './config.js';
import { reconcileManifest } from './conflict.js';
import {
  applyRemoteSnapshot,
  buildLocalSkillHashes,
  collectRemoteHistoryEntries,
  finalizePulledSkills,
  finalizePushedSkills,
  loadManifestHistory,
  loadServerManifest,
  refreshLocalManifest,
  saveManifestHistory,
  saveServerManifest,
  type ManifestStatus,
  type ServerManifest
} from './manifest.js';
import {
  createTransportRuntime,
  deployReceiver,
  fetchRemoteManifest,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
  type TransportRuntime
} from './transport.js';

export interface SyncActionRow {
  skill: string;
  server: string;
  direction: 'push' | 'pull' | 'conflict';
  status: ManifestStatus;
}

function chooseRows(manifest: ServerManifest, mode: 'push' | 'pull', conflictResolution: string): SyncActionRow[] {
  const reconciled = reconcileManifest(manifest);

  return Object.entries(reconciled.skills).flatMap(([skill, state]) => {
    if (state.direction === mode) {
      return [{ skill, server: reconciled.server, direction: mode, status: state.status }];
    }

    if (state.direction !== 'conflict') {
      return [];
    }

    if (state.status === 'conflict' && conflictResolution === 'keep-local' && mode === 'push') {
      return [{ skill, server: reconciled.server, direction: 'push', status: 'conflict' }];
    }

    if (state.status === 'conflict' && conflictResolution === 'keep-remote' && mode === 'pull') {
      return [{ skill, server: reconciled.server, direction: 'pull', status: 'conflict' }];
    }

    if (conflictResolution === 'manual') {
      return [{ skill, server: reconciled.server, direction: 'conflict', status: 'conflict' }];
    }

    return [];
  });
}

export async function pushToServers(
  homeDir: string,
  options: { server?: string; all?: boolean; now?: string } = {},
  transport: Pick<
    TransportRuntime,
    never
  > & {
    ensureReceiver?: typeof deployReceiver;
    fetchRemoteManifest?: typeof fetchRemoteManifest;
    pushManifest?: typeof pushManifest;
    pushSkillDirectory?: typeof pushSkillDirectory;
  } = {}
): Promise<SyncActionRow[]> {
  const config = await loadConfig(homeDir);
  const now = options.now ?? new Date().toISOString();
  const runtime = createTransportRuntime();
  const targetServers =
    options.server !== undefined ? [options.server] : Object.keys(config.servers).sort();
  const rows: SyncActionRow[] = [];

  for (const serverName of targetServers) {
    const server = getConfiguredServer(config, serverName);
    const ensureReceiver = transport.ensureReceiver ?? deployReceiver;
    const readRemoteManifest = transport.fetchRemoteManifest ?? fetchRemoteManifest;
    const writeRemoteManifest = transport.pushManifest ?? pushManifest;
    const sendSkill = transport.pushSkillDirectory ?? pushSkillDirectory;

    await refreshLocalManifest(homeDir, serverName, now);
    const previous = await loadServerManifest(homeDir, serverName);
    await ensureReceiver(server, runtime);
    const remoteSnapshot = await readRemoteManifest(server, runtime);
    let working = applyRemoteSnapshot(previous, Object.fromEntries(
      Object.entries(remoteSnapshot.skills)
        .filter((entry): entry is [string, { remote_hash: string | null }] => entry[1].remote_hash !== null)
        .map(([skill, state]) => [skill, state.remote_hash])
    ), now);

    const selected = chooseRows(working, 'push', config.conflict_resolution);
    const { skillsDir } = getSyncPaths(homeDir);

    for (const row of selected.filter((row) => row.direction === 'push')) {
      await sendSkill(server, join(skillsDir, row.skill), row.skill, runtime);
    }

    working = finalizePushedSkills(
      working,
      selected.filter((row) => row.direction === 'push').map((row) => row.skill),
      now
    );

    await writeRemoteManifest(server, working, runtime);
    await saveServerManifest(homeDir, working);
    rows.push(...selected);
  }

  return rows;
}

export async function pullFromServer(
  homeDir: string,
  serverName: string,
  options: { now?: string } = {},
  transport: Pick<
    TransportRuntime,
    never
  > & {
    ensureReceiver?: typeof deployReceiver;
    fetchRemoteManifest?: typeof fetchRemoteManifest;
    pullSkillDirectory?: typeof pullSkillDirectory;
  } = {}
): Promise<SyncActionRow[]> {
  const config = await loadConfig(homeDir);
  const now = options.now ?? new Date().toISOString();
  const server = getConfiguredServer(config, serverName);
  const runtime = createTransportRuntime();
  const ensureReceiver = transport.ensureReceiver ?? deployReceiver;
  const readRemoteManifest = transport.fetchRemoteManifest ?? fetchRemoteManifest;
  const receiveSkill = transport.pullSkillDirectory ?? pullSkillDirectory;

  await refreshLocalManifest(homeDir, serverName, now);
  const previous = await loadServerManifest(homeDir, serverName);
  await ensureReceiver(server, runtime);
  const remoteSnapshot = await readRemoteManifest(server, runtime);
  let working = applyRemoteSnapshot(previous, Object.fromEntries(
    Object.entries(remoteSnapshot.skills)
      .filter((entry): entry is [string, { remote_hash: string | null }] => entry[1].remote_hash !== null)
      .map(([skill, state]) => [skill, state.remote_hash])
  ), now);

  const history = await loadManifestHistory(homeDir);
  history.entries.push(...collectRemoteHistoryEntries(previous, working, now));

  const rows = chooseRows(working, 'pull', config.conflict_resolution);
  const { skillsDir } = getSyncPaths(homeDir);
  for (const row of rows.filter((row) => row.direction === 'pull')) {
    await receiveSkill(server, row.skill, join(skillsDir, row.skill), runtime);
  }

  working = finalizePulledSkills(
    working,
    rows.filter((row) => row.direction === 'pull').map((row) => row.skill),
    now
  );

  await saveManifestHistory(homeDir, history);
  await saveServerManifest(homeDir, working);
  return rows;
}
```

- [ ] **Step 4: Run the sync-engine tests to verify they pass**

Run: `npx vitest run tests/sync-engine.test.ts`
Expected: PASS with push, pull, and conflict-policy coverage green.

- [ ] **Step 5: Commit the push/pull workflows**

```bash
git add src/sync_engine.ts tests/sync-engine.test.ts
git commit -m "feat: add push and pull workflows"
```

### Task 4: Add full-sync orchestration and CLI wiring

**Files:**
- Modify: `src/sync_engine.ts`
- Modify: `src/index.ts`
- Create: `tests/sync-cli.test.ts`

- [ ] **Step 1: Write the failing CLI and end-to-end tests**

```ts
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../src/config.js';
import { getSyncPaths } from '../src/config.js';
import { createProgram } from '../src/index.js';

async function installFakeBinary(binDir: string, name: string, body: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

describe('sync CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('push <server> prints transferred rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {}
          }
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', 'alpha'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tnew']]);
  });

  it('sync --all pulls first and then pushes all configured servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    const fakeBinDir = join(homeDir, 'bin');
    const remoteRoot = join(homeDir, 'remote');
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(join(remoteRoot, '.syncskill', 'skills', 'remote-only'), { recursive: true });
    await writeFile(join(remoteRoot, '.syncskill', 'skills', 'remote-only', 'SKILL.md'), '# remote only\n', 'utf8');
    await writeFile(
      join(remoteRoot, '.syncskill', 'manifest.json'),
      `${JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          'remote-only': {
            local_hash: null,
            remote_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            recorded_hash: null,
            direction: 'pull',
            status: 'new'
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    await installFakeBinary(
      fakeBinDir,
      'ssh',
      `#!/usr/bin/env node
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
const remoteRoot = process.env.SYNCSKILL_FAKE_REMOTE_ROOT;
const args = process.argv.slice(2);
if (args.at(-3) === 'node' && args.at(-2) === '~/.syncskill/sync_receiver.mjs' && args.at(-1) === 'manifest') {
  process.stdout.write(await readFile(join(remoteRoot, '.syncskill', 'manifest.json'), 'utf8'));
} else {
  await mkdir(join(remoteRoot, '.syncskill'), { recursive: true });
}
`
    );
    await installFakeBinary(fakeBinDir, 'rsync', '#!/usr/bin/env sh\nexit 1\n');

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {}
          },
          beta: {
            host: 'beta.example.com',
            remote_agents: {}
          }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBinDir}:${originalPath}`;
    process.env.SYNCSKILL_FAKE_REMOTE_ROOT = remoteRoot;

    try {
      await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'sync', '--all'], { from: 'node' });
    } finally {
      process.env.PATH = originalPath;
      delete process.env.SYNCSKILL_FAKE_REMOTE_ROOT;
    }

    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'remote-only', 'SKILL.md'), 'utf8')).resolves.toBe('# remote only\n');
    expect(consoleLog.mock.calls).toEqual(expect.arrayContaining([['remote-only\talpha\tpull\tnew']]));
  });
});
```

- [ ] **Step 2: Run the CLI tests to verify they fail**

Run: `npx vitest run tests/sync-cli.test.ts`
Expected: FAIL because `push` and `sync` commands are not registered yet.

- [ ] **Step 3: Wire full sync and CLI commands**

```ts
// src/sync_engine.ts
export async function syncServers(
  homeDir: string,
  options: { server?: string; all?: boolean; now?: string } = {}
): Promise<SyncActionRow[]> {
  const config = await loadConfig(homeDir);
  const targetServers =
    options.server !== undefined ? [options.server] : Object.keys(config.servers).sort();
  const rows: SyncActionRow[] = [];

  for (const server of targetServers) {
    rows.push(...(await pullFromServer(homeDir, server, { now: options.now })));
  }

  const refreshedAt = options.now ?? new Date().toISOString();
  for (const server of targetServers) {
    await refreshLocalManifest(homeDir, server, refreshedAt);
  }

  rows.push(...(await pushToServers(homeDir, { server: options.server, all: options.all, now: refreshedAt })));
  return rows;
}
```

```ts
// src/index.ts
import { pullFromServer, pushToServers, syncServers } from './sync_engine.js';

program
  .command('push [server]')
  .description('Push local skill changes to one server or all configured servers')
  .option('--all', 'Push all configured servers')
  .action(async (server: string | undefined, options: { all?: boolean }) => {
    const rows = await pushToServers(resolvedHomeDir, {
      server: options.all ? undefined : server,
      all: Boolean(options.all)
    });

    for (const row of rows) {
      console.log(`${row.skill}\t${row.server}\t${row.direction}\t${row.status}`);
    }
  });

program
  .command('pull <server>')
  .description('Pull remote skill changes from one configured server')
  .action(async (server: string) => {
    const rows = await pullFromServer(resolvedHomeDir, server);

    for (const row of rows) {
      console.log(`${row.skill}\t${row.server}\t${row.direction}\t${row.status}`);
    }
  });

program
  .command('sync [server]')
  .description('Pull first and then push for one server or all configured servers')
  .option('--all', 'Sync all configured servers')
  .action(async (server: string | undefined, options: { all?: boolean }) => {
    const rows = await syncServers(resolvedHomeDir, {
      server: options.all ? undefined : server,
      all: Boolean(options.all)
    });

    for (const row of rows) {
      console.log(`${row.skill}\t${row.server}\t${row.direction}\t${row.status}`);
    }
  });
```

- [ ] **Step 4: Run the new CLI tests and full regression suite**

Run: `npx vitest run tests/sync-cli.test.ts tests/transport.test.ts tests/sync-engine.test.ts`
Expected: PASS for the new remote-sync coverage.

Run: `npm test`
Expected: PASS for the full suite.

Run: `npm run build`
Expected: PASS and `dist/index.js` updates without TypeScript errors.

Run: `HOME=$(mktemp -d) node dist/index.js --help`
Expected: PASS with `push`, `pull`, and `sync` listed in the command help output.

- [ ] **Step 5: Commit the full remote-sync milestone**

```bash
git add src/index.ts src/sync_engine.ts tests/sync-cli.test.ts
git commit -m "feat: add remote sync commands"
```
