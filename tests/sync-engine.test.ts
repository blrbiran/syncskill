import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config.js';
import { loadManifestHistory, loadServerManifest } from '../src/manifest.js';
import { pullFromServer, pushToServers } from '../src/sync_engine.js';
import { type TransportRuntime } from '../src/transport.js';

function createRuntime(options: {
  remoteManifest?: string;
  exportedSkills?: Record<string, Record<string, string>>;
} = {}): TransportRuntime & { calls: Array<{ file: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];

  return {
    calls,
    async exec(file, args, execOptions = {}) {
      calls.push({
        file,
        args,
        stdin: typeof execOptions.stdin === 'string' ? execOptions.stdin : undefined
      });

      if (file === 'ssh' && args.at(-1) === 'manifest') {
        return { stdout: options.remoteManifest ?? '', stderr: '' };
      }

      if (file === 'ssh' && args.includes('export-skill')) {
        const skill = args.at(-1) as string;
        const exported = options.exportedSkills?.[skill] ?? {};
        return {
          stdout: JSON.stringify(
            Object.fromEntries(Object.entries(exported).map(([path, contents]) => [path, Buffer.from(contents).toString('base64')]))
          ),
          stderr: ''
        };
      }

      return { stdout: '', stderr: '' };
    }
  };
}

describe('sync engine orchestration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('pushToServers uploads local-only changes and persists finalized manifest state', async () => {
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

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
    });

    const [result] = await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T01:00:00.000Z'
    });

    expect(result).toMatchObject({
      server: 'alpha',
      pushed_skills: ['welcome'],
      conflicted_skills: []
    });

    expect(runtime.calls.some((call) => call.file === 'rsync' && call.args.at(-1) === 'alpha.example.com:~/.syncskill/skills/welcome/')).toBe(true);
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.at(-1) === 'write-manifest')).toBe(true);

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.direction).toBe('skip');
    expect(manifest.skills.welcome.status).toBe('in-sync');
    expect(manifest.skills.welcome.local_hash).toBe(manifest.skills.welcome.remote_hash);
    expect(manifest.skills.welcome.recorded_hash).toBe(manifest.skills.welcome.local_hash);

    const history = await loadManifestHistory(homeDir);
    expect(history.entries).toHaveLength(2);
    expect(history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skill: 'welcome',
          server: 'alpha',
          direction: 'remote'
        })
      ])
    );
  });

  it('pullFromServer imports remote-only skills and finalizes local state', async () => {
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

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: null,
            remote_hash: 'remote-hash',
            recorded_hash: null,
            direction: 'skip',
            status: 'in-sync'
          }
        }
      }),
      exportedSkills: {
        welcome: {
          'SKILL.md': '# welcome\n'
        }
      }
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T02:00:00.000Z'
    });

    expect(result).toMatchObject({
      server: 'alpha',
      pulled_skills: ['welcome'],
      conflicted_skills: []
    });

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.direction).toBe('skip');
    expect(manifest.skills.welcome.status).toBe('in-sync');
    expect(manifest.skills.welcome.local_hash).toBe(manifest.skills.welcome.remote_hash);
    expect(manifest.skills.welcome.recorded_hash).toBe(manifest.skills.welcome.remote_hash);
  });

  it('pushToServers leaves conflicts untouched for manual policy', async () => {
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

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# local version\n', 'utf8');

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: null,
            remote_hash: 'remote-version',
            recorded_hash: 'base-version',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      })
    });

    const [result] = await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T03:00:00.000Z'
    });

    expect(result.pushed_skills).toEqual([]);
    expect(result.conflicted_skills).toEqual(['welcome']);
    expect(runtime.calls.some((call) => call.file === 'rsync')).toBe(false);

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.direction).toBe('conflict');
    expect(manifest.skills.welcome.status).toBe('conflict');
  });

  it('pullFromServer resolves conflicts toward push when keep-local policy is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'keep-local',
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

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# local version\n', 'utf8');

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: null,
            remote_hash: 'remote-version',
            recorded_hash: 'base-version',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T04:00:00.000Z'
    });

    expect(result.pulled_skills).toEqual([]);
    expect(result.conflicted_skills).toEqual([]);

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.direction).toBe('push');
    expect(manifest.skills.welcome.status).toBe('local-changed');
  });

  it('pullFromServer resolves conflicts toward pull when keep-remote policy is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'keep-remote',
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

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# local version\n', 'utf8');

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: null,
            remote_hash: 'remote-version',
            recorded_hash: 'base-version',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      }),
      exportedSkills: {
        welcome: {
          'SKILL.md': '# remote version\n'
        }
      }
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T05:00:00.000Z'
    });

    expect(result.pulled_skills).toEqual(['welcome']);
    expect(result.conflicted_skills).toEqual([]);

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.direction).toBe('skip');
    expect(manifest.skills.welcome.status).toBe('in-sync');
    expect(manifest.skills.welcome.local_hash).toBe(manifest.skills.welcome.remote_hash);
  });
});
