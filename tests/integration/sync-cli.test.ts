import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config/config.js';
import { createProgram } from '../../src/index.js';

describe('sync CLI', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.SYNCSKILL_TRANSPORT_RUNTIME;
  });

  it('push <server> prints one tab-separated line per pushed skill', async () => {
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

    const skillDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pushToServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['welcome', 'docs'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: {
          version: 1,
          server: 'alpha',
          updated_at: '2026-05-01T01:00:00.000Z',
          skills: {}
        }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', 'alpha'], { from: 'node' });

    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['welcome\talpha\tpush\tin-sync'],
      ['docs\talpha\tpush\tin-sync']
    ]);
  });

  it('sync --all prints pull-all then push-all skill rows for the main path', async () => {
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
    const syncServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'syncServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pull: {
          server: 'alpha',
          pulled_skills: ['remote-docs'],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'alpha',
            updated_at: '2026-05-01T02:00:00.000Z',
            skills: {}
          }
        },
        push: {
          server: 'alpha',
          pushed_skills: ['welcome'],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'alpha',
            updated_at: '2026-05-01T02:00:00.000Z',
            skills: {}
          }
        }
      },
      {
        server: 'beta',
        pull: {
          server: 'beta',
          pulled_skills: [],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'beta',
            updated_at: '2026-05-01T02:00:00.000Z',
            skills: {}
          }
        },
        push: {
          server: 'beta',
          pushed_skills: [],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'beta',
            updated_at: '2026-05-01T02:00:00.000Z',
            skills: {}
          }
        }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'sync', '--all'], { from: 'node' });

    expect(syncServersSpy).toHaveBeenCalledWith(homeDir, undefined, { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['remote-docs\talpha\tpull\tin-sync'],
      ['welcome\talpha\tpush\tin-sync']
    ]);
  });

  it('pull with -y flag pulls from all servers without prompting', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} },
          beta: { host: 'beta.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pulled_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      },
      {
        server: 'beta',
        pulled_skills: ['skill-b'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'beta', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull', '-y'], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpull\tin-sync'],
      ['skill-b\tbeta\tpull\tin-sync']
    ]);
  });

  it('pull with specific server pulls from that server only', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} },
          beta: { host: 'beta.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pulled_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull', 'alpha'], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpull\tin-sync']
    ]);
  });

  it('pull --all pulls from all servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => []);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull', '--all'], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], { dryRun: undefined });
  });

  it('pull with single server auto-selects that server without prompting', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pulled_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    // No server arg, no -y flag, but single server - should auto-select
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull'], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpull\tin-sync']
    ]);
  });

  it('push -y skips prompts and pushes to all servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} },
          beta: { host: 'beta.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pushToServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      },
      {
        server: 'beta',
        pushed_skills: ['skill-b'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'beta', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', '-y'], { from: 'node' });

    // -y flag should push to all servers without prompting
    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpush\tin-sync'],
      ['skill-b\tbeta\tpush\tin-sync']
    ]);
  });

  it('push --dry-run shows what would be pushed without actually pushing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} },
          beta: { host: 'beta.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pushToServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: [],
        skipped_skills: ['skill-a'],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      },
      {
        server: 'beta',
        pushed_skills: [],
        skipped_skills: ['skill-b'],
        conflicted_skills: [],
        manifest: { version: 1, server: 'beta', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', '-y', '--dry-run'], { from: 'node' });

    // --dry-run should call pushToServers with dryRun: true
    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], { dryRun: true });
  });

  it('push with single server configured does not prompt', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pushToServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    // No -y flag, but only one server configured - should not prompt
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push'], { from: 'node' });

    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], { dryRun: undefined });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpush\tin-sync']
    ]);
  });

  it('push with no servers configured exits with error', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {}
      },
      homeDir
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push'], { from: 'node' });

    expect(consoleError.mock.calls).toEqual([
      ['No servers configured.']
    ]);
    expect(processExit).toHaveBeenCalledWith(1);
  });
});
