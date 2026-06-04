import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config/config.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createProgram } from '../../src/index.js';

describe('sync CLI', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.SYNCSKILL_TRANSPORT_RUNTIME;
    delete process.env.SYNCSKILL_STRICT;
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

    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      noRefresh: true,
      timeout: undefined,
      yes: undefined,
      noInteractive: undefined,
      yesDestructive: false,
      json: false
    });
    expect(consoleLog.mock.calls).toEqual([
      ['welcome\talpha\tpush\tin-sync'],
      ['docs\talpha\tpush\tin-sync']
    ]);
  });

  it('sync --all preserves configured server order for execution', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
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

    expect(syncServersSpy).toHaveBeenCalledWith(homeDir, ['beta', 'alpha'], {
      dryRun: undefined,
      noRefresh: true,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: undefined,
      yesDestructive: false,
      json: false,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: undefined
    });
    expect(consoleLog.mock.calls).toEqual([
      ['remote-docs\talpha\tpull\tin-sync'],
      ['welcome\talpha\tpush\tin-sync']
    ]);
  });

  it('sync forwards on-remote-deletion to engine and prints delete rows', async () => {
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
    const syncServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'syncServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pull: {
          server: 'alpha',
          pulled_skills: [],
          deleted_skills: ['removed-skill'],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'alpha',
            updated_at: '2026-05-01T02:30:00.000Z',
            skills: {}
          }
        },
        push: {
          server: 'alpha',
          pushed_skills: [],
          skipped_skills: [],
          conflicted_skills: [],
          manifest: {
            version: 1,
            server: 'alpha',
            updated_at: '2026-05-01T02:30:00.000Z',
            skills: {}
          }
        }
      }
    ]);

    await createProgram(homeDir).parseAsync([
      'node',
      'syncskill',
      '--no-refresh',
      'sync',
      'alpha',
      '--on-remote-deletion',
      'delete'
    ], { from: 'node' });

    expect(syncServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      noRefresh: true,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: undefined,
      yesDestructive: false,
      json: false,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: 'delete'
    });
    expect(consoleLog.mock.calls).toEqual([
      ['removed-skill\talpha\tdelete\tin-sync']
    ]);
  });

  it('pull with -y flag forwards non-interactive cross-server defaults to engine', async () => {
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

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], {
      dryRun: undefined,
      timeout: undefined,
      pullBackup: undefined,
      yes: true,
      noInteractive: undefined,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: undefined
    });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpull\tin-sync'],
      ['skill-b\tbeta\tpull\tin-sync']
    ]);
  });

  it('pull forwards cross-server and per-server conflict flags to engine', async () => {
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

    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => []);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync([
      'node',
      'syncskill',
      '--no-interactive',
      '--no-refresh',
      'pull',
      '--all',
      '--cross-server-policy',
      'server:alpha',
      '--on-conflict',
      'abort',
      '--on-remote-deletion',
      'delete'
    ], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], {
      dryRun: undefined,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: true,
      crossServerPolicy: 'server:alpha',
      onConflict: 'abort',
      onDeletion: 'delete'
    });
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

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: undefined,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: undefined
    });
    expect(consoleLog.mock.calls).toEqual([
      ['skill-a\talpha\tpull\tin-sync']
    ]);
  });

  it('pull with unknown server exits with usage error', async () => {
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

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const pullFromServersSpy = vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => []);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull', 'beta'], { from: 'node' });

    expect(processExit).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
    expect(pullFromServersSpy).not.toHaveBeenCalled();
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

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: undefined,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: undefined
    });
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull'], { from: 'node' });

    expect(pullFromServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      timeout: undefined,
      pullBackup: undefined,
      yes: undefined,
      noInteractive: undefined,
      crossServerPolicy: undefined,
      onConflict: undefined,
      onDeletion: undefined
    });
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
    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], {
      dryRun: undefined,
      noRefresh: true,
      timeout: undefined,
      yes: true,
      noInteractive: undefined,
      yesDestructive: false,
      json: false
    });
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
    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha', 'beta'], {
      dryRun: true,
      noRefresh: true,
      timeout: undefined,
      yes: true,
      noInteractive: undefined,
      yesDestructive: false,
      json: false
    });
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

    expect(pushToServersSpy).toHaveBeenCalledWith(homeDir, ['alpha'], {
      dryRun: undefined,
      noRefresh: true,
      timeout: undefined,
      yes: undefined,
      noInteractive: undefined,
      yesDestructive: false,
      json: false
    });
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

  it('push --all keeps exit 0 on partial skip by default', async () => {
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

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['skill-a'],
        skipped_skills: [],
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', '--all'], { from: 'node' });

    expect(processExit).not.toHaveBeenCalledWith(ExitCode.DIRTY_SKIP);
  });

  it('push --all exits 6 on partial skip with SYNCSKILL_STRICT=1', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);
    process.env.SYNCSKILL_STRICT = '1';

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

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['skill-a'],
        skipped_skills: [],
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'push', '--all'], { from: 'node' });

    expect(processExit).toHaveBeenCalledWith(ExitCode.DIRTY_SKIP);
  });

  it('pull --all exits 6 on partial skip with SYNCSKILL_STRICT=1', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-sync-cli-'));
    tempDirs.push(homeDir);
    process.env.SYNCSKILL_STRICT = '1';

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

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pulled_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        backups: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      },
      {
        server: 'beta',
        pulled_skills: [],
        skipped_skills: ['skill-b'],
        conflicted_skills: [],
        backups: [],
        manifest: { version: 1, server: 'beta', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'pull', '--all'], { from: 'node' });

    expect(processExit).toHaveBeenCalledWith(ExitCode.DIRTY_SKIP);
  });

  it('push --json emits structured result summary', async () => {
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
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'pushToServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pushed_skills: ['skill-a'],
        skipped_skills: [],
        conflicted_skills: [],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      },
      {
        server: 'beta',
        pushed_skills: [],
        skipped_skills: ['skill-b'],
        conflicted_skills: ['skill-c'],
        manifest: { version: 1, server: 'beta', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'push', '--all'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('push');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary).toMatchObject({
      pushed: 1,
      pulled: 0,
      skipped: 1,
      conflicts: 1,
      warnings: 0,
      data: {
        servers: [
          { server: 'alpha', ok: true, pushed: 1, pulled: 0, skipped: 0, conflicts: 0 },
          { server: 'beta', ok: true, pushed: 0, pulled: 0, skipped: 1, conflicts: 1 }
        ],
        pushed: [{ skill: 'skill-a', server: 'alpha' }],
        skipped: [{ skill: 'skill-b', server: 'beta' }],
        conflicts: [{ skill: 'skill-c', server: 'beta' }],
        backups: []
      }
    });
  });

  it('pull --json emits structured result summary with backups', async () => {
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
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'pullFromServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pulled_skills: ['skill-a'],
        deleted_skills: ['skill-b'],
        skipped_skills: ['skill-c'],
        conflicted_skills: ['skill-d'],
        backups: [
          {
            skill: 'skill-a',
            server: 'alpha',
            backup_path: join(homeDir, '.syncskill', '.backups', 'skills', 'skill-a', 'pre-pull'),
            size_bytes: 4096
          }
        ],
        manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'pull', 'alpha'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('pull');
    expect(resultEvent.ok).toBe(true);
    expect(processExit).toHaveBeenCalledWith(ExitCode.DIRTY_SKIP);
    expect(resultEvent.summary).toMatchObject({
      pushed: 0,
      pulled: 1,
      skipped: 1,
      conflicts: 1,
      warnings: 0,
      data: {
        servers: [
          { server: 'alpha', ok: true, pushed: 0, pulled: 1, skipped: 1, conflicts: 1 }
        ],
        pulled: [{ skill: 'skill-a', server: 'alpha' }],
        deleted: [{ skill: 'skill-b', server: 'alpha' }],
        skipped: [{ skill: 'skill-c', server: 'alpha' }],
        conflicts: [{ skill: 'skill-d', server: 'alpha' }],
        backups: [
          {
            skill: 'skill-a',
            server: 'alpha',
            backup_path: join(homeDir, '.syncskill', '.backups', 'skills', 'skill-a', 'pre-pull'),
            size_bytes: 4096
          }
        ]
      }
    });
  });

  it('sync --json emits structured result summary', async () => {
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
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(await import('../../src/core/sync_engine.js'), 'syncServers').mockImplementation(async () => [
      {
        server: 'alpha',
        pull: {
          server: 'alpha',
          pulled_skills: ['skill-a'],
          deleted_skills: ['skill-b'],
          skipped_skills: ['skill-c'],
          conflicted_skills: ['skill-d'],
          backups: [
            {
              skill: 'skill-a',
              server: 'alpha',
              backup_path: join(homeDir, '.syncskill', '.backups', 'skills', 'skill-a', 'pre-pull'),
              size_bytes: 1024
            }
          ],
          manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
        },
        push: {
          server: 'alpha',
          pushed_skills: ['skill-e'],
          skipped_skills: ['skill-f'],
          conflicted_skills: ['skill-d'],
          manifest: { version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00Z', skills: {} }
        }
      }
    ]);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'sync', 'alpha'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('sync');
    expect(resultEvent.ok).toBe(true);
    expect(processExit).toHaveBeenCalledWith(ExitCode.DIRTY_SKIP);
    expect(resultEvent.summary).toMatchObject({
      pushed: 1,
      pulled: 1,
      skipped: 2,
      conflicts: 1,
      warnings: 0,
      data: {
        servers: [
          { server: 'alpha', ok: true, pushed: 1, pulled: 1, skipped: 2, conflicts: 1 }
        ],
        pushed: [{ skill: 'skill-e', server: 'alpha' }],
        pulled: [{ skill: 'skill-a', server: 'alpha' }],
        deleted: [{ skill: 'skill-b', server: 'alpha' }],
        backups: [
          {
            skill: 'skill-a',
            server: 'alpha',
            backup_path: join(homeDir, '.syncskill', '.backups', 'skills', 'skill-a', 'pre-pull'),
            size_bytes: 1024
          }
        ]
      }
    });
    expect(resultEvent.summary.data.skipped).toEqual([
      { skill: 'skill-c', server: 'alpha', phase: 'pull' },
      { skill: 'skill-f', server: 'alpha', phase: 'push' }
    ]);
    expect(resultEvent.summary.data.conflicts).toEqual([
      { skill: 'skill-d', server: 'alpha' }
    ]);
  });
});
