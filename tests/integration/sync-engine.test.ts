import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config/config.js';
import { loadManifestHistory, loadServerManifest } from '../../src/core/manifest.js';
import { saveReceiverBackup } from '../../src/core/server.js';
import { pullFromServer, pushToServers } from '../../src/core/sync_engine.js';
import { type TransportRuntime } from '../../src/core/transport.js';

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
  const tempDirs = useTempDirs();

  it('pushToServers preserves configured server order when targeting all servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: {
            host: 'beta.example.com',
            remote_agents: {}
          },
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
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
    });

    const results = await pushToServers(homeDir, undefined, {
      runtime,
      now: '2026-05-01T00:30:00.000Z',
      yes: false
    });

    expect(results.map((result) => result.server)).toEqual(['beta', 'alpha']);
  });

  it('pushToServers uploads local-only changes, applies receiver links, and persists finalized manifest state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {
          welcome: ['claude']
        },
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {
              stale: '/srv/stale'
            }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:30:00.000Z',
      remote_agents: {
        claude: '/srv/claude'
      },
      links: {}
    });

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
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.at(-1) === 'apply')).toBe(true);
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.at(-1) === 'cat > ~/.syncskill/receiver_config.json' && call.stdin?.includes('"claude"') && call.stdin?.includes('"links"') && call.stdin?.includes('"welcome"') && !call.stdin?.includes('"stale"'))).toBe(true);

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

  it('pushToServers only seeds missing backup links for skills included on that server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-engine-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {
          alpha: ['claude'],
          beta: ['claude']
        },
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {},
            skills: {
              include: ['alpha']
            }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:30:00.000Z',
      remote_agents: {
        claude: '/srv/claude'
      },
      links: {}
    });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
    });

    await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T01:30:00.000Z'
    });

    const receiverConfigWrites = runtime.calls.filter((call) => call.file === 'ssh' && call.args.at(-1) === 'cat > ~/.syncskill/receiver_config.json');
    const finalReceiverConfigWrite = receiverConfigWrites.at(-1);
    expect(finalReceiverConfigWrite?.stdin).toContain('"alpha"');
    expect(finalReceiverConfigWrite?.stdin).not.toContain('"beta"');
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

  it('pushToServers deletes remote-only leftovers without uploading missing local directories', async () => {
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
            remote_hash: 'remote-version',
            recorded_hash: 'remote-version',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      })
    });

    const [result] = await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T02:30:00.000Z'
    });

    expect(result).toMatchObject({
      server: 'alpha',
      pushed_skills: [],
      conflicted_skills: []
    });
    expect(runtime.calls.some((call) => call.file === 'rsync')).toBe(false);
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'ssh',
          args: expect.arrayContaining(['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'write-manifest'])
        })
      ])
    );
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.includes('rm'))).toBe(false);

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.local_hash).toBeNull();
    expect(manifest.skills.welcome.remote_hash).toBe('remote-version');
    expect(manifest.skills.welcome.recorded_hash).toBeNull();
    expect(manifest.skills.welcome.direction).toBe('pull');
    expect(manifest.skills.welcome.status).toBe('new');
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

  it('pullFromServer backs up local content before deleting on remote deletion', async () => {
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
    const backupDir = join(homeDir, '.syncskill', '.backups', 'skills', 'welcome', 'pre-pull');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# latest local copy\n', 'utf8');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# stale backup\n', 'utf8');

    await pushToServers(homeDir, ['alpha'], {
      runtime: createRuntime({
        remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
      }),
      now: '2026-05-01T05:15:00.000Z'
    });

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T05:30:00.000Z', skills: {} })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T05:45:00.000Z',
      onDeletion: 'delete'
    });

    expect(result.deleted_skills).toEqual(['welcome']);
    await expect(access(skillDir)).rejects.toBeDefined();
    await expect(readFile(join(backupDir, 'SKILL.md'), 'utf8')).resolves.toBe('# latest local copy\n');
  });

  it('pullFromServer skips pre-pull backup when config pull_backup is false', async () => {
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
        sources: {},
        pull_backup: false
      },
      homeDir
    );

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    const backupDir = join(homeDir, '.syncskill', '.backups', 'skills', 'welcome', 'pre-pull');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# latest local copy\n', 'utf8');

    await pushToServers(homeDir, ['alpha'], {
      runtime: createRuntime({
        remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
      }),
      now: '2026-05-01T05:25:00.000Z'
    });

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T05:40:00.000Z', skills: {} })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T05:55:00.000Z',
      onDeletion: 'delete'
    });

    expect(result.deleted_skills).toEqual(['welcome']);
    await expect(access(skillDir)).rejects.toBeDefined();
    await expect(access(backupDir)).rejects.toBeDefined();
  });

  it('pullFromServer skips pre-pull backup when pullBackup is false', async () => {
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
    const backupDir = join(homeDir, '.syncskill', '.backups', 'skills', 'welcome', 'pre-pull');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# latest local copy\n', 'utf8');

    await pushToServers(homeDir, ['alpha'], {
      runtime: createRuntime({
        remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
      }),
      now: '2026-05-01T05:30:00.000Z'
    });

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T06:00:00.000Z', skills: {} })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T06:30:00.000Z',
      onDeletion: 'delete',
      pullBackup: false
    });

    expect(result.deleted_skills).toEqual(['welcome']);
    await expect(access(skillDir)).rejects.toBeDefined();
    await expect(access(backupDir)).rejects.toBeDefined();
  });

  it('pullFromServer deletes locally when remote deletion policy is delete', async () => {
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

    await pushToServers(homeDir, ['alpha'], {
      runtime: createRuntime({
        remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
      }),
      now: '2026-05-01T05:30:00.000Z'
    });

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T06:00:00.000Z', skills: {} })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T06:30:00.000Z',
      onDeletion: 'delete'
    });

    expect(result.pulled_skills).toEqual([]);
    expect(result.deleted_skills).toEqual(['welcome']);
    expect(result.skipped_skills).not.toContain('welcome');
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.includes('export-skill'))).toBe(false);
    await expect(access(skillDir)).rejects.toBeDefined();

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.local_hash).toBeNull();
    expect(manifest.skills.welcome.remote_hash).toBeNull();
    expect(manifest.skills.welcome.recorded_hash).toBeNull();
    expect(manifest.skills.welcome.direction).toBe('skip');
    expect(manifest.skills.welcome.status).toBe('in-sync');
  });

  it('pullFromServer keeps local files when remote deletion policy is keep-local', async () => {
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

    await pushToServers(homeDir, ['alpha'], {
      runtime: createRuntime({
        remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} })
      }),
      now: '2026-05-01T06:30:00.000Z'
    });

    const runtime = createRuntime({
      remoteManifest: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T07:00:00.000Z', skills: {} })
    });

    const result = await pullFromServer(homeDir, 'alpha', {
      runtime,
      now: '2026-05-01T07:30:00.000Z',
      onDeletion: 'keep-local'
    });

    expect(result.pulled_skills).toEqual([]);
    expect(result.deleted_skills).toEqual([]);
    expect(result.skipped_skills).toContain('welcome');
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.includes('export-skill'))).toBe(false);
    await expect(access(skillDir)).resolves.toBeUndefined();

    const manifest = await loadServerManifest(homeDir, 'alpha');
    expect(manifest.skills.welcome.local_hash).not.toBeNull();
    expect(manifest.skills.welcome.remote_hash).toBeNull();
    expect(manifest.skills.welcome.recorded_hash).not.toBeNull();
    expect(manifest.skills.welcome.direction).toBe('pull');
    expect(manifest.skills.welcome.status).toBe('remote-changed');
  });

  it('pushToServers prints warning for skills with direction=pull', async () => {
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

    // Remote has a skill that local doesn't have (direction=pull scenario)
    const runtime = createRuntime({
      remoteManifest: JSON.stringify({
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          'remote-only-skill': {
            local_hash: null,
            remote_hash: 'remote-hash-123',
            recorded_hash: null,
            direction: 'skip',
            status: 'in-sync'
          }
        }
      })
    });

    const consoleSpy = vi.spyOn(console, 'log');

    const [result] = await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T06:00:00.000Z'
    });

    // Verify warning was printed for the pull-direction skill
    const calls = consoleSpy.mock.calls.map((c) => c[0]);
    const hasWarning = calls.some(
      (c) => typeof c === 'string' && c.includes('Skipping remote-only-skill') && c.includes('remote has changes')
    );
    expect(hasWarning).toBe(true);

    consoleSpy.mockRestore();

    // The skill should not be in pushed_skills (it has direction=pull)
    expect(result.pushed_skills).toEqual([]);
    expect(result.skipped_skills).toEqual(['remote-only-skill']);
  });

  describe('pushToServers --no-refresh safety net', () => {
    it('forces push for skip skills missing remotely when noRefresh=true', async () => {
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

      // Create a local skill with known content
      const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

      // First do a normal push to establish a synced state
      const initialRuntime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T00:00:00.000Z',
          skills: {}
        })
      });

      await pushToServers(homeDir, ['alpha'], {
        runtime: initialRuntime,
        now: '2026-05-01T06:00:00.000Z'
      });

      // Now the skill is synced. Simulate a scenario where:
      // - Manifest says everything is in-sync
      // - But remote directory doesn't have the skill (e.g., manual deletion)
      const { loadServerManifest } = await import('../../src/core/manifest.js');
      const syncedManifest = await loadServerManifest(homeDir, 'alpha');
      const syncedHash = syncedManifest.skills.welcome.local_hash;

      const safetyNetRuntime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T06:30:00.000Z',
          skills: {
            welcome: {
              local_hash: null,
              remote_hash: syncedHash,
              recorded_hash: syncedHash,
              direction: 'skip',
              status: 'in-sync'
            }
          }
        })
      });

      // Override the ls command to return empty (skill doesn't exist remotely)
      const originalExec = safetyNetRuntime.exec.bind(safetyNetRuntime);
      safetyNetRuntime.exec = async (file, args, options) => {
        if (file === 'ssh' && args.includes('ls')) {
          return { stdout: '', stderr: '' };
        }
        return originalExec(file, args, options);
      };

      const consoleSpy = vi.spyOn(console, 'log');

      const [result] = await pushToServers(homeDir, ['alpha'], {
        runtime: safetyNetRuntime,
        now: '2026-05-01T07:00:00.000Z',
        noRefresh: true
      });

      // Verify safety net message was logged
      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      const hasSafetyNetMessage = calls.some(
        (c) => typeof c === 'string' && c.includes('Safety net')
      );
      expect(hasSafetyNetMessage).toBe(true);

      consoleSpy.mockRestore();

      // The skill should have been force-pushed because it was missing remotely
      expect(result.pushed_skills).toContain('welcome');
    });

    it('does not apply safety net when noRefresh=false (default)', async () => {
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

      // Create a local skill
      const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

      // First do a normal push to establish a synced state
      const initialRuntime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T00:00:00.000Z',
          skills: {}
        })
      });

      await pushToServers(homeDir, ['alpha'], {
        runtime: initialRuntime,
        now: '2026-05-01T07:00:00.000Z'
      });

      // Now get the synced hash
      const { loadServerManifest } = await import('../../src/core/manifest.js');
      const syncedManifest = await loadServerManifest(homeDir, 'alpha');
      const syncedHash = syncedManifest.skills.welcome.local_hash;

      // Runtime returns manifest showing skill as in-sync
      const runtime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T07:30:00.000Z',
          skills: {
            welcome: {
              local_hash: null,
              remote_hash: syncedHash,
              recorded_hash: syncedHash,
              direction: 'skip',
              status: 'in-sync'
            }
          }
        })
      });

      const consoleSpy = vi.spyOn(console, 'log');

      const [result] = await pushToServers(homeDir, ['alpha'], {
        runtime,
        now: '2026-05-01T08:00:00.000Z'
        // noRefresh is not set (defaults to false/undefined)
      });

      // Verify safety net message was NOT logged
      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      const hasSafetyNetMessage = calls.some(
        (c) => typeof c === 'string' && c.includes('Safety net')
      );
      expect(hasSafetyNetMessage).toBe(false);

      consoleSpy.mockRestore();

      // Without noRefresh, the skill stays as skip (in-sync)
      expect(result.pushed_skills).not.toContain('welcome');
    });
  });

  describe('pushToServers remote cleanup', () => {
    it('identifies and lists orphan remote skills without deleting when yes=false', async () => {
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

      // Create a local skill
      const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

      // Remote has "welcome" plus an orphan skill "old-skill"
      const runtime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T00:00:00.000Z',
          skills: {}
        })
      });

      // Override ls to return both welcome and old-skill (orphan)
      const originalExec = runtime.exec.bind(runtime);
      runtime.exec = async (file, args, options) => {
        if (file === 'ssh' && args.includes('ls')) {
          return { stdout: 'welcome\nold-skill\n', stderr: '' };
        }
        return originalExec(file, args, options);
      };

      const consoleSpy = vi.spyOn(console, 'log');

      // Push with yes=false explicitly - should list orphans but not delete
      // yes=false means skip confirmation (don't prompt), just skip cleanup
      await pushToServers(homeDir, ['alpha'], {
        runtime,
        now: '2026-05-01T09:00:00.000Z',
        noRefresh: true,
        yes: false  // Explicit false skips cleanup without prompting
      });

      const calls = consoleSpy.mock.calls.map((c) => c[0]);

      // Should list the orphan skill
      const hasOrphanList = calls.some(
        (c) => typeof c === 'string' && c.includes('old-skill')
      );
      expect(hasOrphanList).toBe(true);

      // Should show "Skipped remote cleanup" since yes=false
      const hasSkippedMessage = calls.some(
        (c) => typeof c === 'string' && c.includes('Skipped remote cleanup')
      );
      expect(hasSkippedMessage).toBe(true);

      // Should NOT have called rm
      const hasRmCall = runtime.calls.some(
        (call) => call.file === 'ssh' && call.args.includes('rm')
      );
      expect(hasRmCall).toBe(false);

      consoleSpy.mockRestore();
    });

    it('deletes orphan skills when yes=true and yesDestructive=true', async () => {
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

      // Create a local skill
      const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

      const runtime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T00:00:00.000Z',
          skills: {}
        })
      });

      // Override ls to return welcome plus orphan skill
      const originalExec = runtime.exec.bind(runtime);
      runtime.exec = async (file, args, options) => {
        if (file === 'ssh' && args.includes('ls')) {
          return { stdout: 'welcome\norphan-skill\n', stderr: '' };
        }
        return originalExec(file, args, options);
      };

      const consoleSpy = vi.spyOn(console, 'log');

      // Push with yes=true - should delete orphan
      await pushToServers(homeDir, ['alpha'], {
        runtime,
        now: '2026-05-01T10:00:00.000Z',
        noRefresh: true,
        yes: true,
        yesDestructive: true
      });

      // Should have called rm with the orphan skill
      const rmCall = runtime.calls.find(
        (call) => call.file === 'ssh' && call.args.includes('rm')
      );
      expect(rmCall).toBeDefined();
      expect(rmCall?.args).toContain('~/.syncskill/skills/orphan-skill');

      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      const hasRemovedMessage = calls.some(
        (c) => typeof c === 'string' && c.includes('Removed') && c.includes('remote skill')
      );
      expect(hasRemovedMessage).toBe(true);

      consoleSpy.mockRestore();
    });

    it('skips cleanup in dry-run mode', async () => {
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

      // Create a local skill
      const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

      const runtime = createRuntime({
        remoteManifest: JSON.stringify({
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T00:00:00.000Z',
          skills: {}
        })
      });

      // Override ls to return orphan skill
      const originalExec = runtime.exec.bind(runtime);
      runtime.exec = async (file, args, options) => {
        if (file === 'ssh' && args.includes('ls')) {
          return { stdout: 'welcome\norphan-skill\n', stderr: '' };
        }
        return originalExec(file, args, options);
      };

      // Push with dryRun=true and yes=true - should NOT delete
      await pushToServers(homeDir, ['alpha'], {
        runtime,
        now: '2026-05-01T11:00:00.000Z',
        noRefresh: true,
        dryRun: true,
        yes: true
      });

      // Should NOT have called rm even with yes=true
      const hasRmCall = runtime.calls.some(
        (call) => call.file === 'ssh' && call.args.includes('rm')
      );
      expect(hasRmCall).toBe(false);
    });
  });
});
