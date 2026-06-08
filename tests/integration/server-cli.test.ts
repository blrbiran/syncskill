import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { loadConfig, saveConfig } from '../../src/config/config.js';
import { saveReceiverBackup } from '../../src/core/server.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createProgram } from '../../src/index.js';

describe('remote CLI', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('remote list prints configured remote names', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([['alpha'], ['beta']]);
  });

  it('remote show prints receiver backup contents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
            user: 'deploy',
            port: 2222,
            identity_file: '/Users/demo/.ssh/id_syncskill',
            remote_agents: { claude: '/srv/skills' }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: { claude: '/srv/skills' },
      links: { welcome: ['claude'], archived: [] }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'show', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['version\t1'],
      ['server\talpha'],
      ['updated_at\t2026-06-03T09:01:00.000Z'],
      ['remote_agent\tclaude\t/srv/skills'],
      ['link\tarchived\t'],
      ['link\twelcome\tclaude']
    ]);
  });

  it('remote takeover --dry-run delegates to transport helper', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
            remote_agents: { claude: '~/.claude/skills' }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: { claude: '~/.claude/skills' },
      links: { welcome: ['claude'] }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const takeoverSpy = vi.spyOn(await import('../../src/core/transport.js'), 'takeOverRemoteSkill').mockResolvedValue({
      server: 'alpha',
      skill: 'welcome',
      takeovers: [
        {
          agent: 'claude',
          path: '~/.claude/skills/welcome',
          action: 'takeover',
          remote_type: 'directory'
        }
      ],
      skipped: []
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'takeover', 'alpha', 'welcome', '--dry-run'], {
      from: 'node'
    });

    expect(takeoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: { claude: '~/.claude/skills' }
      }),
      'welcome',
      { agent: undefined, dryRun: true }
    );
    expect(consoleLog.mock.calls).toEqual([
      ['would-takeover\tclaude\t~/.claude/skills/welcome\tdirectory']
    ]);
  });

  it('remote takeover delegates only linked agents to transport helper', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
              claude: '~/.claude/skills',
              codex: '~/.codex/skills'
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
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: {
        claude: '~/.claude/skills',
        codex: '~/.codex/skills'
      },
      links: {
        welcome: ['claude']
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const takeoverSpy = vi.spyOn(await import('../../src/core/transport.js'), 'takeOverRemoteSkill').mockResolvedValue({
      server: 'alpha',
      skill: 'welcome',
      takeovers: [
        {
          agent: 'claude',
          path: '~/.claude/skills/welcome',
          action: 'takeover',
          remote_type: 'directory'
        }
      ],
      skipped: []
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'takeover', 'alpha', 'welcome'], {
      from: 'node'
    });

    expect(takeoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '~/.claude/skills'
        }
      }),
      'welcome',
      { agent: undefined, dryRun: undefined }
    );
    expect(consoleLog.mock.calls).toEqual([
      ['takeover\tclaude\t~/.claude/skills/welcome\tdirectory']
    ]);
  });

  it('remote takeover requires --yes-destructive in non-interactive mode', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
            remote_agents: { claude: '~/.claude/skills' }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: { claude: '~/.claude/skills' },
      links: { welcome: ['claude'] }
    });

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const takeoverSpy = vi.spyOn(await import('../../src/core/transport.js'), 'takeOverRemoteSkill').mockResolvedValue({
      server: 'alpha',
      skill: 'welcome',
      takeovers: [],
      skipped: []
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', 'remote', 'takeover', 'alpha', 'welcome'], {
      from: 'node'
    });

    expect(processExit).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('remote add stores a configured remote endpoint', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await createProgram(homeDir).parseAsync([
      'node',
      'syncskill',
      '--no-refresh',
      'remote',
      'add',
      'alpha',
      '--host',
      'alpha.example.com',
      '--user',
      'deploy',
      '--port',
      '2222',
      '--identity-file',
      '/Users/demo/.ssh/id_syncskill',
      '--remote-repo',
      '/srv/syncskill'
    ], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      servers: {
        alpha: {
          host: 'alpha.example.com',
          user: 'deploy',
          port: 2222,
          identity_file: '/Users/demo/.ssh/id_syncskill',
          remote_repo: '/srv/syncskill',
          remote_agents: {}
        }
      }
    });
  });

  it('remote rm removes a configured remote endpoint', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'rm', 'alpha'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      servers: {
        beta: { host: 'beta.example.com', remote_agents: {} }
      }
    });
  });

  it('remote agent add and link add update local receiver backup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'agent', 'add', 'alpha', 'claude', '~/.claude/skills'], {
      from: 'node'
    });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'link', 'add', 'alpha', 'welcome', 'claude'], {
      from: 'node'
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'link', 'ls', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['link\twelcome\tclaude']
    ]);
  });

  it('remote agent rm removes linked agent references from local receiver backup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: {
        claude: '~/.claude/skills',
        codex: '~/.codex/skills'
      },
      links: {
        welcome: ['claude', 'codex'],
        archived: ['claude']
      }
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'agent', 'rm', 'alpha', 'claude'], {
      from: 'node'
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'show', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls.slice(0, 2)).toEqual([
      ['version\t1'],
      ['server\talpha']
    ]);
    expect(consoleLog.mock.calls[2]?.[0]).toMatch(/^updated_at\t/);
    expect(consoleLog.mock.calls.slice(3)).toEqual([
      ['remote_agent\tcodex\t~/.codex/skills'],
      ['link\tarchived\t'],
      ['link\twelcome\tcodex']
    ]);
  });

  it('remote link rm clears a single linked agent from local receiver backup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await saveReceiverBackup(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T09:01:00.000Z',
      remote_agents: {
        claude: '~/.claude/skills',
        codex: '~/.codex/skills'
      },
      links: {
        welcome: ['claude', 'codex']
      }
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'link', 'rm', 'alpha', 'welcome', 'claude'], {
      from: 'node'
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'link', 'ls', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['link\twelcome\tcodex']
    ]);
  });

  it('remote agent rm reports no-op when receiver backup is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'agent', 'rm', 'alpha', 'claude'], {
      from: 'node'
    });

    expect(consoleLog).toHaveBeenCalledWith('Receiver backup does not exist for alpha; no-op.');
  });

  it('remote link rm emits JSON no-op result when receiver backup is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'remote', 'link', 'rm', 'alpha', 'welcome', 'claude'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['{"type":"info","message":"Receiver backup does not exist for alpha; no-op."}'],
      ['{"type":"result","command":"remote link rm","ok":true,"data_schema_version":1,"summary":{"server":"alpha","op":"link.rm","noop":true,"reason":"receiver-backup-missing"}}']
    ]);
  });

  it('remote takeover requires receiver backup initialization', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const takeoverSpy = vi.spyOn(await import('../../src/core/transport.js'), 'takeOverRemoteSkill').mockResolvedValue({
      server: 'alpha',
      skill: 'welcome',
      takeovers: [],
      skipped: []
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'takeover', 'alpha', 'welcome'], {
      from: 'node'
    });

    expect(processExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

});
