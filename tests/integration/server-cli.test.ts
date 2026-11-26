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

  it('remote list --json emits one name-only result line (#491)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-list-json-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: { host: 'beta.example.com', remote_agents: {} },
          alpha: {
            host: 'alpha.example.com',
            user: 'deploy',
            identity_file: '/secret/path/id_syncskill',
            remote_agents: {}
          }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'remote', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toHaveLength(1);
    const event = JSON.parse(consoleLog.mock.calls[0][0] as string);
    expect(event).toMatchObject({ type: 'result', command: 'remote list', ok: true });
    expect(event.summary).toEqual({ servers: ['alpha', 'beta'] });

    const raw = JSON.stringify(event);
    expect(raw).not.toContain('deploy');
    expect(raw).not.toContain('/secret/path');
    expect(raw).not.toContain('example.com');
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

  it('remote add stores node_bin and keeps it when later fields are merged', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(
      { version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {} },
      homeDir
    );

    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'alpha',
      '--host', 'alpha.example.com', '--node-bin', '/opt/node/bin/node'
    ], { from: 'node' });
    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'alpha', '--port', '2222'
    ], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      servers: {
        alpha: {
          host: 'alpha.example.com',
          port: 2222,
          node_bin: '/opt/node/bin/node'
        }
      }
    });
  });

  // Tester #457: `remote add` rebuilt `config.servers[name]` from the flags it was given, so a call that changed one
  // field silently wiped every field it did not repeat -- including `skills.include`, which is what limits what a
  // later `--yes-destructive` push may delete.
  const fullServer = {
    host: 'alpha.example.com',
    user: 'deploy',
    port: 2222,
    identity_file: '/Users/demo/.ssh/id_syncskill',
    remote_repo: '/srv/syncskill',
    node_bin: '/home/deploy/.nvm/versions/node/v22.23.4/bin/node',
    connect_timeout_ms: 30_000,
    skills: { include: ['alpha', 'beta'] },
    remote_agents: { claude: '/srv/.claude/skills' }
  };

  const seedFullServer = async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: { alpha: fullServer },
        sources: {}
      },
      homeDir
    );
    return homeDir;
  };

  it('remote add amends an existing remote instead of rebuilding it (#457)', async () => {
    const homeDir = await seedFullServer();

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'alpha', '--host', 'alpha.example.com'
    ], { from: 'node' });

    // mutation: rebuild `config.servers[name]` from the flags -> everything except host/remote_agents is gone, red
    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      servers: { alpha: fullServer }
    });
    expect(consoleLog).toHaveBeenCalled();
  });

  it('remote add can change one field without repeating --host (#457)', async () => {
    const homeDir = await seedFullServer();

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'alpha', '--port', '3333'
    ], { from: 'node' });

    // mutation: keep `--host` a requiredOption -> commander refuses the call before it runs, red
    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      servers: { alpha: { ...fullServer, port: 3333 } }
    });
  });

  it('remote add still requires --host when the remote is new (#457)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(
      { version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {} },
      homeDir
    );

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'beta', '--user', 'deploy'
    ], { from: 'node' });

    // mutation: make --host optional unconditionally -> this call writes a hostless entry and exits 0, red
    expect(processExit).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
    await expect(loadConfig(homeDir)).resolves.toMatchObject({ servers: {} });
  });

  it('remote add reports the fields it changed in text and JSON (#457)', async () => {
    const homeDir = await seedFullServer();

    const textLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'remote', 'add', 'alpha', '--port', '3333'
    ], { from: 'node' });
    // mutation: print the bare name as before -> the person cannot see which field was written, red
    expect(textLog.mock.calls.map((call) => String(call[0])).join('\n')).toContain('port');
    textLog.mockRestore();

    const jsonLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--json', '--no-refresh', 'remote', 'add', 'alpha', '--user', 'ops'
    ], { from: 'node' });
    const result = jsonLog.mock.calls
      .map((call) => String(call[0]))
      .map((line) => JSON.parse(line) as { type: string; summary?: { changed_fields?: string[] } })
      .find((event) => event.type === 'result');

    // mutation: omit changed_fields from the JSON summary -> a script cannot tell what an update touched, red
    expect(result?.summary?.changed_fields).toEqual(['user']);
  });

  // Tester #456: an unreadable remote must end the command with the network exit code, not a stack trace.
  it('push exits with NETWORK_ERROR when the remote cannot be read (#456)', async () => {
    const homeDir = await seedFullServer();
    const engine = await import('../../src/core/sync_engine.js');
    vi.spyOn(engine, 'pushToServers').mockRejectedValue(
      new Error('E_REMOTE_TRANSPORT: cannot list the skills on alpha: ssh exited with code 255')
    );
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync([
      'node', 'syncskill', '--no-refresh', 'push', 'alpha', '--dry-run'
    ], { from: 'node' });

    // mutation: drop the E_REMOTE_TRANSPORT branch from handleSyncCommandError -> the error is rethrown, red
    expect(processExit).toHaveBeenCalledWith(ExitCode.NETWORK_ERROR);
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

  it('remote agent rm emits JSON no-op result when receiver backup is missing', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', '--no-refresh', 'remote', 'agent', 'rm', 'alpha', 'claude'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['{"type":"info","message":"Receiver backup does not exist for alpha; no-op."}'],
      ['{"type":"result","command":"remote agent rm","ok":true,"data_schema_version":1,"summary":{"server":"alpha","op":"agent.rm","noop":true,"reason":"receiver-backup-missing"}}']
    ]);
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

  it('remote link add rejects unknown remote agents', async () => {
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
        claude: '~/.claude/skills'
      },
      links: {}
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'link', 'add', 'alpha', 'welcome', 'cursor'], {
        from: 'node'
      })
    ).rejects.toThrow(`process.exit:${ExitCode.USAGE_ERROR}`);

    expect(consoleError).toHaveBeenCalledWith('✗ Remote agent not configured: cursor');
    expect(exitMock).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
  });

  it('remote takeover rejects an unlinked --agent', async () => {
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
      links: { welcome: ['claude'] }
    });

    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const takeoverSpy = vi.spyOn(await import('../../src/core/transport.js'), 'takeOverRemoteSkill').mockResolvedValue({
      server: 'alpha',
      skill: 'welcome',
      takeovers: [],
      skipped: []
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'remote', 'takeover', 'alpha', 'welcome', '--agent', 'codex'], {
      from: 'node'
    });

    expect(processExit).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
    expect(consoleError).toHaveBeenCalledWith('✗ Remote agent not configured for welcome: codex');
    expect(takeoverSpy).not.toHaveBeenCalled();
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
