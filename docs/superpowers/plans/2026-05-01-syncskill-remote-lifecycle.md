# syncskill Remote Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `refresh --remote`, add a lightweight `server` command group, and document remote lifecycle plus `npm link` source-install flows without changing `push`, `pull`, or `sync` semantics.

**Architecture:** Keep the existing CLI shape for `refresh --remote`, but finish its orchestration by teaching transport and receiver layers to observe real remote skill directories, recalculate remote hashes, and persist a corrected remote manifest both remotely and locally. Add a small `server`-focused module for list/show/probe read-only orchestration, and update user docs so source-based installation and remote lifecycle workflows are explicit and testable.

**Tech Stack:** TypeScript, Node 20 ESM, commander, vitest, YAML, SSH/rsync transport, remote receiver script

---

## File Map

**Create:**
- `src/server.ts` — read-only `server list/show/probe` orchestration and line formatting
- `tests/unit/server.test.ts` — unit coverage for server formatting and probe result helpers
- `tests/integration/server-cli.test.ts` — CLI wiring coverage for `server list/show/probe`
- `tests/integration/remote-refresh.test.ts` — integration coverage for `refresh --remote` against mocked transport/receiver behavior

**Modify:**
- `src/index.ts` — register `server` command group and keep `refresh --remote` CLI behavior aligned
- `src/refresh.ts` — complete remote refresh orchestration and save corrected manifests locally after remote rewrite
- `src/transport.ts` — add remote manifest/skill scan/probe primitives and remote manifest rewrite helpers
- `src/receiver/sync_receiver.mjs` — expose receiver commands for remote skill inventory, hash calculation, and probe-friendly checks
- `src/manifest.ts` — add helper(s) for rebuilding a remote manifest from real remote hashes while preserving reconciliation-friendly state shape
- `README.md` — add remote lifecycle command overview and `npm link` source-install flow
- `docs/usage-guide.md` — add remote lifecycle workflow and source-install flow
- `docs/config-guide.md` — document server fields, remote paths, and probe/refresh expectations
- `tests/unit/refresh.test.ts` — extend unit coverage for remote refresh control flow and manifest rebuild rules
- `tests/integration/reconciliation-cli.test.ts` — extend refresh CLI coverage for `--remote` and `--status`
- `tests/integration/transport.test.ts` — extend transport/receiver tests for remote scan/probe primitives
- `tests/unit/docs.test.ts` — update docs assertions for `server` commands and `npm link`
- `tests/integration/help-output.test.ts` — update help-contract assertions for the new `server` command group

**Do not modify in this milestone unless a failing test requires it:**
- `src/sync_engine.ts`
- `src/source.ts`
- `tests/end2end/*`

## Delivery Contract

This milestone introduces only these new read-only lifecycle commands:

```text
server list
server show <name>
server probe <name>
```

It also completes the existing command contract:

```text
refresh [--local | --remote | --status] [server]
```

Confirmed `refresh --remote <server>` behavior in this milestone:
- read remote manifest
- scan real remote skill directories
- recalculate remote hashes
- rebuild manifest using real remote directories as source of truth
- write corrected manifest back to the remote server
- save the same corrected manifest locally
- recompute reconciliation so `status` and `diff` reflect refreshed remote state
- fail if a configured remote skill root path does not exist

## Test Contract

Default task gate:
- `npm run test`
- `npm run build`

Milestone merge gate:
- `npm run test`
- `npm run build`
- `npm run test:integration`

`npm run test:end2end` is not part of the default or milestone gate for this milestone unless a later task explicitly requires it.

### Task 1: Add remote lifecycle CLI surface

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/server.test.ts`
- Test: `tests/integration/server-cli.test.ts`
- Test: `tests/integration/help-output.test.ts`

- [ ] **Step 1: Write the failing server-command tests**

```ts
// tests/unit/server.test.ts
import { describe, expect, it } from 'vitest';

import { formatServerListLines, formatServerShowLines, formatProbeLines } from '../../src/server.js';

describe('server helpers', () => {
  it('formats server list lines in sorted order', () => {
    expect(formatServerListLines(['beta', 'alpha'])).toEqual(['alpha', 'beta']);
  });

  it('formats one server summary with configured connection details', () => {
    expect(
      formatServerShowLines({
        name: 'alpha',
        host: 'alpha.example.com',
        user: 'deploy',
        port: 2222,
        identity_file: '/Users/demo/.ssh/id_syncskill',
        remote_agents: {
          claude: '/home/deploy/.claude/skills'
        }
      })
    ).toEqual([
      'name\talpha',
      'host\talpha.example.com',
      'user\tdeploy',
      'port\t2222',
      'identity_file\t/Users/demo/.ssh/id_syncskill',
      'remote_agent\tclaude\t/home/deploy/.claude/skills'
    ]);
  });

  it('formats probe results as tab-separated status rows', () => {
    expect(
      formatProbeLines([
        { check: 'transport', ok: true, detail: 'ssh ok' },
        { check: 'remote_skill_root', ok: false, detail: 'missing: /srv/skills' }
      ])
    ).toEqual([
      'transport\tok\tssh ok',
      'remote_skill_root\tfail\tmissing: /srv/skills'
    ]);
  });
});
```

```ts
// tests/integration/server-cli.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../../src/config.js';
import { createProgram } from '../../src/index.js';
import * as serverModule from '../../src/server.js';

describe('server CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('server list prints configured server names', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: { host: 'beta.example.com', remote_agents: {} },
          alpha: { host: 'alpha.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'server', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([['alpha'], ['beta']]);
  });

  it('server probe prints one row per probe check and preserves failure rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: { claude: '/srv/skills' } }
        },
        sources: {}
      },
      homeDir
    );

    vi.spyOn(serverModule, 'probeServer').mockResolvedValue([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'remote_skill_root', ok: false, detail: 'missing: /srv/skills' }
    ]);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'server', 'probe', 'alpha'], {
        from: 'node'
      })
    ).rejects.toThrow('Server probe failed: alpha');

    expect(consoleLog.mock.calls).toEqual([
      ['transport\tok\tssh ok'],
      ['remote_skill_root\tfail\tmissing: /srv/skills']
    ]);
  });
});
```

```ts
// tests/integration/help-output.test.ts
import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('help output', () => {
  it('describes the shipped commands in install-facing language', () => {
    const help = createProgram('/tmp').helpInformation();

    expect(help).toContain('Multi-device AI Agent Skill sync tool');
    expect(help).toContain('init');
    expect(help).toContain('server');
    expect(help).toContain('source');
    expect(help).toContain('push');
    expect(help).toContain('sync');
  });
});
```

- [ ] **Step 2: Run the failing server-command tests**

Run: `npx vitest run tests/unit/server.test.ts tests/integration/server-cli.test.ts tests/integration/help-output.test.ts`
Expected: FAIL because `src/server.ts` and the `server` command group do not exist yet.

- [ ] **Step 3: Add the minimal `src/server.ts` module**

```ts
import { getConfiguredServer, loadConfig, type ConfiguredServer } from './config.js';
import { probeServerAccess, type ServerProbeResult } from './transport.js';

export interface ProbeLine {
  check: string;
  ok: boolean;
  detail: string;
}

export function formatServerListLines(names: string[]): string[] {
  return [...names].sort();
}

export function formatServerShowLines(server: ConfiguredServer): string[] {
  return [
    `name\t${server.name}`,
    `host\t${server.host}`,
    ...(typeof server.user === 'string' ? [`user\t${server.user}`] : []),
    ...(typeof server.port === 'number' ? [`port\t${server.port}`] : []),
    ...(typeof server.identity_file === 'string' ? [`identity_file\t${server.identity_file}`] : []),
    ...Object.entries(server.remote_agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent, path]) => `remote_agent\t${agent}\t${path}`)
  ];
}

export function formatProbeLines(results: ProbeLine[]): string[] {
  return results.map((result) => `${result.check}\t${result.ok ? 'ok' : 'fail'}\t${result.detail}`);
}

export async function listServers(homeDir: string): Promise<string[]> {
  return Object.keys((await loadConfig(homeDir)).servers).sort();
}

export async function showServer(homeDir: string, name: string): Promise<ConfiguredServer> {
  return getConfiguredServer(await loadConfig(homeDir), name);
}

export async function probeServer(homeDir: string, name: string): Promise<ProbeLine[]> {
  const server = getConfiguredServer(await loadConfig(homeDir), name);
  const results: ServerProbeResult[] = await probeServerAccess(server);

  return results.map((result) => ({
    check: result.check,
    ok: result.ok,
    detail: result.detail
  }));
}
```

- [ ] **Step 4: Register the `server` command group in `src/index.ts`**

```ts
import { formatProbeLines, formatServerListLines, formatServerShowLines, listServers, probeServer, showServer } from './server.js';
```

```ts
const serverCommand = program.command('server').description('Inspect configured remote servers');

serverCommand
  .command('list')
  .description('List configured remote servers')
  .action(async () => {
    for (const line of formatServerListLines(await listServers(resolvedHomeDir))) {
      console.log(line);
    }
  });

serverCommand
  .command('show <name>')
  .description('Show configured details for one remote server')
  .action(async (name: string) => {
    for (const line of formatServerShowLines(await showServer(resolvedHomeDir, name))) {
      console.log(line);
    }
  });

serverCommand
  .command('probe <name>')
  .description('Probe remote access for one configured server')
  .action(async (name: string) => {
    const lines = formatProbeLines(await probeServer(resolvedHomeDir, name));

    for (const line of lines) {
      console.log(line);
    }

    if (lines.some((line) => line.includes('\tfail\t'))) {
      throw new Error(`Server probe failed: ${name}`);
    }
  });
```

- [ ] **Step 5: Run the server-command tests to verify they pass**

Run: `npx vitest run tests/unit/server.test.ts tests/integration/server-cli.test.ts tests/integration/help-output.test.ts`
Expected: PASS with `server list`, `server show`, `server probe`, and help output wired.

- [ ] **Step 6: Run the default gate and build for this task**

Run: `npm run test`
Expected: PASS with unit tests including `tests/unit/server.test.ts`.

Run: `npm run build`
Expected: PASS with the new `server` module compiled.

- [ ] **Step 7: Commit the remote lifecycle CLI surface**

```bash
git add src/server.ts src/index.ts tests/unit/server.test.ts tests/integration/server-cli.test.ts tests/integration/help-output.test.ts
git commit -m "feat: add remote server lifecycle commands"
```

### Task 2: Complete remote refresh against real remote state

**Files:**
- Modify: `src/transport.ts`
- Modify: `src/receiver/sync_receiver.mjs`
- Modify: `src/manifest.ts`
- Modify: `src/refresh.ts`
- Test: `tests/unit/refresh.test.ts`
- Test: `tests/integration/remote-refresh.test.ts`
- Test: `tests/integration/transport.test.ts`
- Test: `tests/integration/reconciliation-cli.test.ts`

- [ ] **Step 1: Write the failing remote-refresh tests**

```ts
// tests/unit/refresh.test.ts
it('rebuildRemoteManifestFromHashes uses real remote hashes as source of truth', () => {
  const manifest = createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z');
  manifest.skills.docs = {
    local_hash: null,
    remote_hash: 'old-docs',
    recorded_hash: 'old-docs',
    direction: 'skip',
    status: 'in-sync'
  };
  manifest.skills.stale = {
    local_hash: null,
    remote_hash: 'stale-hash',
    recorded_hash: 'stale-hash',
    direction: 'skip',
    status: 'in-sync'
  };

  expect(
    rebuildRemoteManifestFromHashes(
      manifest,
      {
        docs: 'new-docs',
        welcome: 'new-welcome'
      },
      '2026-05-02T00:00:00.000Z'
    )
  ).toEqual({
    version: 1,
    server: 'alpha',
    updated_at: '2026-05-02T00:00:00.000Z',
    skills: {
      docs: {
        local_hash: null,
        remote_hash: 'new-docs',
        recorded_hash: 'old-docs',
        direction: 'pull',
        status: 'remote-changed'
      },
      welcome: {
        local_hash: null,
        remote_hash: 'new-welcome',
        recorded_hash: null,
        direction: 'pull',
        status: 'new'
      }
    }
  });
});
```

```ts
// tests/integration/remote-refresh.test.ts
it('refreshStoredManifests rewrites remote and local manifests from real remote hashes', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-remote-refresh-'));
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
          remote_agents: {
            claude: '/srv/skills'
          }
        }
      },
      sources: {}
    },
    homeDir
  );

  await saveServerManifest(homeDir, {
    version: 1,
    server: 'alpha',
    updated_at: '2026-05-01T00:00:00.000Z',
    skills: {
      stale: {
        local_hash: null,
        remote_hash: 'stale-hash',
        recorded_hash: 'stale-hash',
        direction: 'skip',
        status: 'in-sync'
      }
    }
  });

  vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
    version: 1,
    server: 'alpha',
    updated_at: '2026-05-02T00:00:00.000Z',
    skills: {
      welcome: {
        local_hash: null,
        remote_hash: 'welcome-hash',
        recorded_hash: null,
        direction: 'pull',
        status: 'new'
      }
    }
  });

  const manifests = await refreshStoredManifests(homeDir, {
    local: false,
    remote: true,
    server: 'alpha'
  });

  expect(manifests[0].skills.stale).toBeUndefined();
  expect(manifests[0].skills.welcome?.remote_hash).toBe('welcome-hash');
  await expect(loadServerManifest(homeDir, 'alpha')).resolves.toEqual(manifests[0]);
});
```

```ts
// tests/integration/reconciliation-cli.test.ts
it('refresh --remote --status <server> prints refreshed remote rows', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
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
          remote_agents: {
            claude: '/srv/skills'
          }
        }
      },
      sources: {}
    },
    homeDir
  );

  vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
    version: 1,
    server: 'alpha',
    updated_at: '2026-05-02T00:00:00.000Z',
    skills: {
      welcome: {
        local_hash: null,
        remote_hash: 'remote-hash',
        recorded_hash: null,
        direction: 'pull',
        status: 'new'
      }
    }
  });

  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', '--remote', '--status', 'alpha'], {
    from: 'node'
  });

  expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpull\tnew']]);
});
```

- [ ] **Step 2: Run the failing remote-refresh tests**

Run: `npx vitest run tests/unit/refresh.test.ts tests/integration/remote-refresh.test.ts tests/integration/reconciliation-cli.test.ts tests/integration/transport.test.ts`
Expected: FAIL because remote refresh still treats remote work as a placeholder and transport lacks remote scan/probe primitives.

- [ ] **Step 3: Add manifest rebuild helpers in `src/manifest.ts`**

```ts
export function rebuildRemoteManifestFromHashes(
  manifest: ServerManifest,
  remoteHashes: Record<string, string>,
  updatedAt: string
): ServerManifest {
  const skillNames = Object.keys(remoteHashes).sort();

  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      skillNames.map((skill) => {
        const previous = manifest.skills[skill] ?? createEmptySkillState();

        return [
          skill,
          {
            ...previous,
            remote_hash: remoteHashes[skill]
          }
        ];
      })
    )
  });
}
```

- [ ] **Step 4: Add receiver commands for remote refresh and probe support**

```js
async function scanSkills() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillEntries = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const hashes = {};

  for (const entry of skillEntries) {
    hashes[entry.name] = await hashSkillDirectory(join(skillsDir, entry.name));
  }

  process.stdout.write(`${JSON.stringify({
    manifest: await readManifest(),
    remote_hashes: hashes
  })}\n`);
}

async function probeAccess() {
  const manifestExists = await readJson(manifestFile, null) !== null;
  const config = await readJson(configFile, { remote_agents: {} });
  const remoteAgentResults = [];

  for (const [agent, path] of Object.entries(config.remote_agents ?? {})) {
    if (typeof path !== 'string') {
      continue;
    }

    try {
      await access(resolve(path.replace(/^~(?=\/|$)/, homedir())));
      remoteAgentResults.push({ check: `remote_agent:${agent}`, ok: true, detail: path });
    } catch {
      remoteAgentResults.push({ check: `remote_agent:${agent}`, ok: false, detail: `missing: ${path}` });
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      checks: [
        { check: 'manifest', ok: manifestExists, detail: manifestExists ? manifestFile : `missing: ${manifestFile}` },
        ...remoteAgentResults
      ]
    })}\n`
  );
}
```

```js
} else if (command === 'scan-skills') {
  await scanSkills();
} else if (command === 'probe-access') {
  await probeAccess();
} else {
```

- [ ] **Step 5: Add transport primitives for remote refresh and probe**

```ts
export interface ServerProbeResult {
  check: string;
  ok: boolean;
  detail: string;
}

export async function refreshRemoteManifestFromServer(
  server: ConfiguredServer,
  runtime: TransportRuntime,
  currentManifest: ServerManifest,
  updatedAt: string
): Promise<ServerManifest> {
  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'scan-skills']));
  const parsed = JSON.parse(result.stdout || '{}') as {
    manifest?: Partial<ServerManifest>;
    remote_hashes?: Record<string, string>;
  };

  const remoteHashes = parsed.remote_hashes ?? {};
  const corrected = rebuildRemoteManifestFromHashes(
    {
      ...createEmptyManifest(server.name),
      ...currentManifest,
      ...(parsed.manifest ?? {}),
      server: server.name
    },
    remoteHashes,
    updatedAt
  );

  await pushManifest(server, corrected, runtime);
  return corrected;
}

export async function probeServerAccess(server: ConfiguredServer): Promise<ServerProbeResult[]> {
  const runtime = createTransportRuntime();
  const checks: ServerProbeResult[] = [];

  try {
    await runtime.exec('ssh', buildSshArgs(server, ['true']));
    checks.push({ check: 'transport', ok: true, detail: 'ssh ok' });
  } catch (error) {
    checks.push({
      check: 'transport',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
    return checks;
  }

  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'probe-access']));
  const parsed = JSON.parse(result.stdout || '{}') as { checks?: ServerProbeResult[] };

  return [...checks, ...(parsed.checks ?? [])];
}
```

- [ ] **Step 6: Complete remote refresh orchestration in `src/refresh.ts`**

```ts
import { getConfiguredServer, loadConfig } from './config.js';
import { loadServerManifest, refreshLocalManifest, saveServerManifest, type ServerManifest } from './manifest.js';
import { createTransportRuntime, refreshRemoteManifestFromServer } from './transport.js';
```

```ts
    if (refreshRemote) {
      const config = await loadConfig(homeDir);
      const serverConfig = getConfiguredServer(config, server);
      const refreshedRemote = await refreshRemoteManifestFromServer(
        serverConfig,
        createTransportRuntime(),
        reconciled,
        updatedAt
      );
      await saveServerManifest(homeDir, refreshedRemote);
      manifests.push(reconciled = refreshedRemote);
      continue;
    }
```

```ts
    await saveServerManifest(homeDir, reconciled);
    manifests.push(reconciled);
```

- [ ] **Step 7: Run remote-refresh tests to verify they pass**

Run: `npx vitest run tests/unit/refresh.test.ts tests/integration/remote-refresh.test.ts tests/integration/reconciliation-cli.test.ts tests/integration/transport.test.ts`
Expected: PASS with `refresh --remote` rewriting remote and local manifests from real remote state.

- [ ] **Step 8: Run the default gate and build for this task**

Run: `npm run test`
Expected: PASS with remote refresh unit coverage included.

Run: `npm run build`
Expected: PASS with transport/receiver refresh support compiled.

- [ ] **Step 9: Commit remote refresh completion**

```bash
git add src/transport.ts src/receiver/sync_receiver.mjs src/manifest.ts src/refresh.ts tests/unit/refresh.test.ts tests/integration/remote-refresh.test.ts tests/integration/reconciliation-cli.test.ts tests/integration/transport.test.ts
git commit -m "feat: complete remote refresh flow"
```

### Task 3: Document remote lifecycle and source install flows

**Files:**
- Modify: `README.md`
- Modify: `docs/usage-guide.md`
- Modify: `docs/config-guide.md`
- Test: `tests/unit/docs.test.ts`

- [ ] **Step 1: Write the failing docs assertions**

```ts
expect(readme).toContain('npm link');
expect(readme).toContain('syncskill --help');
expect(readme).toContain('server list');
expect(readme).toContain('server probe alpha');

expect(configGuide).toContain('remote_agents');
expect(configGuide).toContain('server show');
expect(configGuide).toContain('refresh --remote');

expect(usageGuide).toContain('syncskill server list');
expect(usageGuide).toContain('syncskill server show alpha');
expect(usageGuide).toContain('syncskill server probe alpha');
expect(usageGuide).toContain('syncskill refresh --remote --status alpha');
expect(usageGuide).toContain('npm link');
expect(usageGuide).toContain('node dist/index.js --help');
```

- [ ] **Step 2: Run the failing docs test**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: FAIL because the new remote lifecycle commands and `npm link` flow are not documented yet.

- [ ] **Step 3: Update README with source-install and remote lifecycle overview**

```md
## Install from source

```bash
npm install
npm run build
npm link
syncskill --help
```

You can also run the built entrypoint directly:

```bash
node dist/index.js --help
```

### Remote lifecycle

- `syncskill server list`
- `syncskill server show <name>`
- `syncskill server probe <name>`
- `syncskill refresh --remote --status <server>`
```

- [ ] **Step 4: Update usage and config guides with remote lifecycle workflows**

```md
## Remote lifecycle workflow

```bash
syncskill server list
syncskill server show alpha
syncskill server probe alpha
syncskill refresh --remote --status alpha
```

Use `server probe` before the first sync or after changing remote paths.
Use `refresh --remote` when you want reconciliation to reflect the real remote skill tree without pulling content into the local repo.
```

```md
`server show` and `server probe` use the configured `host`, optional `user`, optional `port`, optional `identity_file`, and `remote_agents` paths.
`refresh --remote` scans the configured remote agent roots to rebuild remote manifest state.
```

- [ ] **Step 5: Run the docs test to verify it passes**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: PASS with docs covering `npm link`, direct build execution, and remote lifecycle commands.

- [ ] **Step 6: Run the default gate and build for this task**

Run: `npm run test`
Expected: PASS with updated docs assertions.

Run: `npm run build`
Expected: PASS with no code regressions introduced by docs updates.

- [ ] **Step 7: Commit the remote lifecycle docs**

```bash
git add README.md docs/usage-guide.md docs/config-guide.md tests/unit/docs.test.ts
git commit -m "docs: add remote lifecycle guidance"
```

### Task 4: Run milestone integration gate and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/usage-guide.md`
- Modify: `docs/config-guide.md`
- Modify: `tests/integration/server-cli.test.ts`
- Modify: `tests/integration/remote-refresh.test.ts`
- Modify: `tests/integration/reconciliation-cli.test.ts`
- Modify: `tests/integration/transport.test.ts`

- [ ] **Step 1: Run the milestone gate before final touch-ups**

Run: `npm run test:integration`
Expected: PASS if Task 1 and Task 2 integration wiring is complete; otherwise FAIL with the exact lifecycle or remote-refresh gaps that still need a final adjustment.

- [ ] **Step 2: If the integration gate exposes output mismatches, tighten the tests and output strings**

```ts
expect(consoleLog.mock.calls).toEqual([
  ['alpha'],
  ['beta']
]);
```

```ts
expect(consoleLog.mock.calls).toEqual([
  ['welcome\talpha\tpull\tnew']
]);
```

Use this step only to align the final CLI rows and doc-cited commands with the already approved design. Do not add new behavior here.

- [ ] **Step 3: Run the full milestone verification set**

Run: `npm run test`
Expected: PASS for the default unit gate.

Run: `npm run build`
Expected: PASS with remote lifecycle code compiled.

Run: `npm run test:integration`
Expected: PASS for the milestone merge gate.

Run: `node dist/index.js --help`
Expected: PASS and include `server` in the top-level command list.

- [ ] **Step 4: Commit the final verification alignment if this task made changes**

```bash
git add README.md docs/usage-guide.md docs/config-guide.md tests/integration/server-cli.test.ts tests/integration/remote-refresh.test.ts tests/integration/reconciliation-cli.test.ts tests/integration/transport.test.ts
git commit -m "test: verify remote lifecycle milestone"
```

If Step 2 makes no file changes, do not create an extra implementation commit for this task; just use the verification results to close the milestone.

## Self-Review

- Spec coverage check: Task 1 adds the new `server` command group and help wiring; Task 2 completes `refresh --remote` using real remote state and remote manifest rewrite semantics; Task 3 updates README/config/usage docs with remote lifecycle and `npm link`; Task 4 enforces the milestone integration gate and final verification set.
- Placeholder scan: every task includes concrete files, commands, assertions, and commit boundaries; no placeholder instructions remain.
- Type consistency check: the plan consistently uses `server list`, `server show <name>`, `server probe <name>`, and `refresh --remote`; test tiers stay aligned with the repo rules throughout.
