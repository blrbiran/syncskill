import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config.js';
import { createEmptyManifest } from '../../src/manifest.js';

const receiverPath = new URL('../../src/receiver/sync_receiver.mjs', import.meta.url).pathname;

async function importReceiverModule() {
  return import(`${pathToFileURL(receiverPath).href}?t=${Date.now()}-${Math.random()}`);
}

async function withMockedHomeDir<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    return await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

async function runReceiverCommand(homeDir: string, command: string) {
  return withMockedHomeDir(homeDir, async () => {
    const argv = process.argv.slice();
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.argv = ['node', receiverPath, command];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    try {
      await importReceiverModule();
      return stdout;
    } finally {
      process.argv = argv;
      process.stdout.write = stdoutWrite;
    }
  });
}

async function runReceiverApply(homeDir: string) {
  await runReceiverCommand(homeDir, 'apply');
}

function createReceiverManifest(updatedAt: string) {
  return createEmptyManifest('remote', updatedAt);
}


import {
  deployReceiver,
  fetchRemoteManifest,
  pullSkillDirectory,
  probeServerAccess,
  pushManifest,
  pushSkillDirectory,
  refreshRemoteManifestFromServer,
  type TransportRuntime
} from '../../src/transport.js';

function createRuntime(stdoutByCommand: Record<string, string> = {}): TransportRuntime & {
  calls: Array<{ file: string; args: string[]; stdin?: string }>;
} {
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

      return { stdout: '', stderr: '' };
    }
  };
}

describe('transport', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

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
        ['ssh', '-p', '2222', '-i', '/Users/demo/.ssh/id_syncskill', 'deploy@alpha.example.com', 'sh', '-s'],
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

  it('deployReceiver propagates bootstrap script errors', async () => {
    const runtime: TransportRuntime = {
      async exec(_file, args, _options) {
        // Simulate bootstrap script failure (e.g., permission denied)
        if (args.includes('sh') && args.includes('-s')) {
          throw new Error('syncskill: cannot write to /home/user/.syncskill');
        }
        return { stdout: '', stderr: '' };
      }
    };

    const server = {
      name: 'test-server',
      host: 'test.example.com',
      remote_agents: {}
    };

    await expect(deployReceiver(server, runtime)).rejects.toThrow('cannot write');
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
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValue({ stdout: '', stderr: '' });

    await pushSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {}
      },
      sourceDir,
      'welcome',
      runtime
    );

    expect(runtime.exec).toHaveBeenCalledWith('rsync', expect.any(Array), {});
    expect(runtime.exec).toHaveBeenCalledWith(
      'ssh',
      ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'import-skill', 'welcome'],
      expect.objectContaining({ stdin: expect.stringContaining('SKILL.md') })
    );
  });

  it('pushSkillDirectory does not fall back for rsync transfer errors', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const transferError = new Error('rsync exited with code 23');
    const runtime = createRuntime();
    runtime.exec = vi.fn<TransportRuntime['exec']>().mockRejectedValueOnce(transferError);

    await expect(
      pushSkillDirectory(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {}
        },
        sourceDir,
        'welcome',
        runtime
      )
    ).rejects.toBe(transferError);

    expect(runtime.exec).toHaveBeenCalledTimes(1);
  });


  it('pullSkillDirectory falls back to receiver export when rsync is unavailable', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
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
      targetDir,
      runtime
    );

    expect(runtime.exec).toHaveBeenCalledWith(
      'ssh',
      ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'export-skill', 'welcome'],
      {}
    );
    await expect(readFile(join(targetDir, 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
  });

  it('pullSkillDirectory rejects exported files that escape the target directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ '../escape.txt': Buffer.from('nope').toString('base64') }),
        stderr: ''
      });

    await expect(
      pullSkillDirectory(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {}
        },
        'welcome',
        targetDir,
        runtime
      )
    ).rejects.toThrow('Refusing to write exported file outside target directory');
  });

  it('pullSkillDirectory does not fall back for rsync transfer errors', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const transferError = new Error('rsync exited with code 23');
    const runtime = createRuntime();
    runtime.exec = vi.fn<TransportRuntime['exec']>().mockRejectedValueOnce(transferError);

    await expect(
      pullSkillDirectory(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {}
        },
        'welcome',
        targetDir,
        runtime
      )
    ).rejects.toBe(transferError);

    expect(runtime.exec).toHaveBeenCalledTimes(1);
  });

  it('refreshRemoteManifestFromServer reads remote manifest before rebuilding from receiver remote hashes', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs manifest': JSON.stringify({
        version: 1,
        server: 'remote',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          docs: {
            local_hash: null,
            remote_hash: 'old-docs',
            recorded_hash: 'old-docs',
            direction: 'skip',
            status: 'in-sync'
          },
          stale: {
            local_hash: null,
            remote_hash: 'stale-hash',
            recorded_hash: 'stale-hash',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      }),
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs scan-skills': JSON.stringify({
        remote_hashes: {
          docs: 'docs-hash',
          welcome: 'welcome-hash'
        }
      })
    });

    const manifest = await refreshRemoteManifestFromServer(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '/srv/skills'
        }
      },
      runtime,
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          docs: {
            local_hash: 'local-docs',
            remote_hash: 'local-old-docs',
            recorded_hash: 'local-old-docs',
            direction: 'push',
            status: 'local-changed'
          },
          stale: {
            local_hash: null,
            remote_hash: 'stale-hash',
            recorded_hash: 'stale-hash',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      },
      '2026-05-02T00:00:00.000Z'
    );

    expect(manifest).toEqual({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        docs: {
          local_hash: 'local-docs',
          remote_hash: 'docs-hash',
          recorded_hash: 'old-docs',
          direction: 'pull',
          status: 'remote-changed'
        },
        welcome: {
          local_hash: null,
          remote_hash: 'welcome-hash',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        {
          file: 'ssh',
          args: ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'manifest']
        },
        {
          file: 'ssh',
          args: ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'scan-skills']
        },
        {
          file: 'ssh',
          args: ['alpha.example.com', 'node', '~/.syncskill/sync_receiver.mjs', 'write-manifest'],
          stdin: expect.stringContaining('"docs":')
        }
      ])
    );
  });

  it('probeServerAccess reports transport, receiver, manifest, and remote agent checks', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com true': '',
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs manifest': JSON.stringify(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z')),
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs probe-access': JSON.stringify({
        checks: [
          { check: 'manifest', ok: true, detail: 'manifest readable' },
          { check: 'remote_agent:claude', ok: false, detail: 'missing: /srv/skills' }
        ]
      })
    });

    await expect(
      probeServerAccess(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {
            claude: '/srv/skills'
          }
        },
        runtime
      )
    ).resolves.toEqual([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      { check: 'manifest', ok: true, detail: 'manifest readable' },
      { check: 'remote_agent:claude', ok: false, detail: 'missing: /srv/skills' }
    ]);
  });

  it('probeServerAccess reports receiver failures separately from transport', async () => {
    const runtime = createRuntime();
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('receiver bootstrap failed'));

    await expect(
      probeServerAccess(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {
            claude: '/srv/skills'
          }
        },
        runtime
      )
    ).resolves.toEqual([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: false, detail: 'receiver bootstrap failed' }
    ]);
  });

  it('probeServerAccess reports manifest failures after receiver succeeds', async () => {
    const runtime = createRuntime();
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('manifest unreadable'));

    await expect(
      probeServerAccess(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {
            claude: '/srv/skills'
          }
        },
        runtime
      )
    ).resolves.toEqual([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      { check: 'manifest', ok: false, detail: 'manifest unreadable' }
    ]);
  });

  it('receiver scan-skills hashes configured remote agent roots', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    const syncRoot = join(homeDir, '.syncskill');
    const receiverConfigPath = join(syncRoot, 'receiver_config.json');
    const manifestPath = join(syncRoot, 'manifest.json');
    const agentDir = join(homeDir, 'agent-skills');

    await mkdir(join(agentDir, 'welcome'), { recursive: true });
    await writeFile(join(agentDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');
    await mkdir(join(syncRoot), { recursive: true });
    await writeFile(receiverConfigPath, `${JSON.stringify({ remote_agents: { claude: agentDir } }, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(createReceiverManifest('2026-05-01T00:00:00.000Z'), null, 2)}\n`, 'utf8');

    const output = await runReceiverCommand(homeDir, 'scan-skills');
    const parsed = JSON.parse(output) as { remote_hashes: Record<string, string> };

    expect(parsed.remote_hashes.welcome).toMatch(/^[a-f0-9]{32}$/);
  });

  it('receiver scan-skills fails when a configured remote agent root is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    const syncRoot = join(homeDir, '.syncskill');
    const receiverConfigPath = join(syncRoot, 'receiver_config.json');

    await mkdir(syncRoot, { recursive: true });
    await writeFile(
      receiverConfigPath,
      `${JSON.stringify({ remote_agents: { claude: join(homeDir, 'missing-agent-root') } }, null, 2)}\n`,
      'utf8'
    );

    await expect(runReceiverCommand(homeDir, 'scan-skills')).rejects.toThrow('Missing remote skill root for claude');
  });

  it('receiver import-skill rejects entries that escape the skill directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        const stdin = process.stdin;
        const stream = Readable.from([JSON.stringify({ '../escape.txt': Buffer.from('nope').toString('base64') })]);
        Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
        process.argv = ['node', receiverPath, 'import-skill', 'welcome'];

        try {
          await importReceiverModule();
        } finally {
          process.argv = argv;
          Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
        }
      })
    ).rejects.toThrow('Invalid skill entry: ../escape.txt');
  });

  it('receiver import-skill creates symlinks from the new format', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillDir = join(syncRoot, 'skills', 'welcome');

    await withMockedHomeDir(homeDir, async () => {
      const argv = process.argv.slice();
      const stdin = process.stdin;
      const stream = Readable.from([
        JSON.stringify({
          files: {
            'SKILL.md': Buffer.from('# welcome\n').toString('base64'),
            'main.ts': Buffer.from('export const x = 1;\n').toString('base64')
          },
          symlinks: {
            'index.ts': 'main.ts'
          }
        })
      ]);
      Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
      process.argv = ['node', receiverPath, 'import-skill', 'welcome'];

      try {
        await importReceiverModule();
      } finally {
        process.argv = argv;
        Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
      }
    });

    await expect(readFile(join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
    await expect(readFile(join(skillDir, 'main.ts'), 'utf8')).resolves.toBe('export const x = 1;\n');
    const { lstat, readlink } = await import('node:fs/promises');
    const linkStat = await lstat(join(skillDir, 'index.ts'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(readlink(join(skillDir, 'index.ts'))).resolves.toBe('main.ts');
  });

  it('receiver export-skill includes symlinks in the output', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillDir = join(syncRoot, 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# welcome\n', 'utf8');
    await writeFile(join(skillDir, 'main.ts'), 'export const x = 1;\n', 'utf8');
    await symlink('main.ts', join(skillDir, 'index.ts'));

    const output = await withMockedHomeDir(homeDir, async () => {
      const argv = process.argv.slice();
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      let stdout = '';
      process.argv = ['node', receiverPath, 'export-skill', 'welcome'];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write;

      try {
        await importReceiverModule();
        return stdout;
      } finally {
        process.argv = argv;
        process.stdout.write = stdoutWrite;
      }
    });

    const data = JSON.parse(output);
    expect(data.files).toBeDefined();
    expect(data.symlinks).toBeDefined();
    expect(data.files['SKILL.md']).toBe(Buffer.from('# welcome\n').toString('base64'));
    expect(data.files['main.ts']).toBe(Buffer.from('export const x = 1;\n').toString('base64'));
    expect(data.symlinks['index.ts']).toBe('main.ts');
  });

  it('receiver import-skill rejects symlinks with absolute target', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        const stdin = process.stdin;
        const stream = Readable.from([
          JSON.stringify({
            files: { 'SKILL.md': Buffer.from('# test\n').toString('base64') },
            symlinks: { 'config': '/etc/passwd' }
          })
        ]);
        Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
        process.argv = ['node', receiverPath, 'import-skill', 'welcome'];

        try {
          await importReceiverModule();
        } finally {
          process.argv = argv;
          Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
        }
      })
    ).rejects.toThrow('Invalid symlink target (absolute path)');
  });

  it('receiver import-skill rejects symlinks that escape skill directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        const stdin = process.stdin;
        const stream = Readable.from([
          JSON.stringify({
            files: { 'SKILL.md': Buffer.from('# test\n').toString('base64') },
            symlinks: { 'escape': '../../etc/passwd' }
          })
        ]);
        Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
        process.argv = ['node', receiverPath, 'import-skill', 'welcome'];

        try {
          await importReceiverModule();
        } finally {
          process.argv = argv;
          Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
        }
      })
    ).rejects.toThrow('Invalid symlink target (escapes skill directory)');
  });

  it('pullSkillDirectory rejects symlinks with absolute target', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          files: { 'SKILL.md': Buffer.from('# test\n').toString('base64') },
          symlinks: { 'config': '/etc/passwd' }
        }),
        stderr: ''
      });

    await expect(
      pullSkillDirectory(
        { name: 'alpha', host: 'alpha.example.com', remote_agents: {} },
        'welcome',
        targetDir,
        runtime
      )
    ).rejects.toThrow('Refusing to create symlink with absolute target');
  });

  it('pullSkillDirectory rejects symlinks that escape skill directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          files: { 'SKILL.md': Buffer.from('# test\n').toString('base64') },
          symlinks: { 'escape': '../../etc/passwd' }
        }),
        stderr: ''
      });

    await expect(
      pullSkillDirectory(
        { name: 'alpha', host: 'alpha.example.com', remote_agents: {} },
        'welcome',
        targetDir,
        runtime
      )
    ).rejects.toThrow('Refusing to create symlink that escapes skill directory');
  });

  it('probeServerAccess reports probe-access parse failures as probe failures', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com true': '',
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs manifest': JSON.stringify(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z')),
      'ssh alpha.example.com node ~/.syncskill/sync_receiver.mjs probe-access': '{broken-json'
    });

    await expect(
      probeServerAccess(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {
            claude: '/srv/skills'
          }
        },
        runtime
      )
    ).resolves.toEqual([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      { check: 'probe', ok: false, detail: expect.stringContaining('JSON') }
    ]);
  });

  it('receiver apply removes stale links that are no longer in the manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
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

    const syncRoot = join(homeDir, '.syncskill');
    const skillsDir = join(syncRoot, 'skills');
    const receiverConfigPath = join(syncRoot, 'receiver_config.json');
    const manifestPath = join(syncRoot, 'manifest.json');
    const agentDir = join(homeDir, 'agent-skills');

    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');
    await mkdir(join(skillsDir, 'stale'), { recursive: true });
    await writeFile(join(skillsDir, 'stale', 'SKILL.md'), '# stale\n', 'utf8');
    await mkdir(agentDir, { recursive: true });
    await symlink(join(skillsDir, 'stale'), join(agentDir, 'stale'), 'dir');

    const manifest = createReceiverManifest('2026-05-01T00:00:00.000Z');
    manifest.skills.welcome = {
      local_hash: null,
      remote_hash: 'placeholder',
      recorded_hash: 'placeholder',
      direction: 'skip',
      status: 'in-sync'
    };

    await writeFile(receiverConfigPath, `${JSON.stringify({ remote_agents: { claude: agentDir } }, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await runReceiverApply(homeDir);

    await expect(readFile(join(agentDir, 'welcome', 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
    await expect(readFile(join(agentDir, 'stale', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pushSkillDirectory fallback includes symlinks in the transmitted data', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');
    await writeFile(join(sourceDir, 'main.ts'), 'export const x = 1;\n', 'utf8');
    await symlink('main.ts', join(sourceDir, 'index.ts'));

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValue({ stdout: '', stderr: '' });

    await pushSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {}
      },
      sourceDir,
      'welcome',
      runtime
    );

    const importCall = (runtime.exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('import-skill')
    );
    expect(importCall).toBeDefined();
    const stdinData = JSON.parse((importCall![2] as { stdin: string }).stdin);
    expect(stdinData.files).toBeDefined();
    expect(stdinData.symlinks).toBeDefined();
    expect(stdinData.files['SKILL.md']).toBeDefined();
    expect(stdinData.files['main.ts']).toBeDefined();
    expect(stdinData.symlinks['index.ts']).toBe('main.ts');
  });

  it('pullSkillDirectory fallback creates symlinks from the new format', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          files: {
            'SKILL.md': Buffer.from('# welcome\n').toString('base64'),
            'main.ts': Buffer.from('export const x = 1;\n').toString('base64')
          },
          symlinks: {
            'index.ts': 'main.ts'
          }
        }),
        stderr: ''
      });

    await pullSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {}
      },
      'welcome',
      targetDir,
      runtime
    );

    await expect(readFile(join(targetDir, 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
    await expect(readFile(join(targetDir, 'main.ts'), 'utf8')).resolves.toBe('export const x = 1;\n');
    const { lstat, readlink } = await import('node:fs/promises');
    const linkStat = await lstat(join(targetDir, 'index.ts'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(readlink(join(targetDir, 'index.ts'))).resolves.toBe('main.ts');
  });

  it('pullSkillDirectory fallback handles legacy format without symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, '.syncskill', 'skills', 'welcome');

    const runtime = createRuntime();
    const rsyncUnavailable = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' });
    runtime.exec = vi
      .fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(rsyncUnavailable)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          'SKILL.md': Buffer.from('# welcome\n').toString('base64')
        }),
        stderr: ''
      });

    await pullSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {}
      },
      'welcome',
      targetDir,
      runtime
    );

    await expect(readFile(join(targetDir, 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
  });
});
