import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config/config.js';
import { createProgram } from '../../src/index.js';
import { createEmptyManifest } from '../../src/core/manifest.js';

const receiverPath = new URL('../../src/receiver/sync_receiver.mjs', import.meta.url).pathname;

async function importReceiverModule() {
  return import(`${pathToFileURL(receiverPath).href}?t=${Date.now()}-${Math.random()}`);
}

async function withMockedHomeDir<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalSyncRoot = process.env.SYNCSKILL_ROOT;
  process.env.HOME = homeDir;
  // The receiver derives its root from the script location (issue 422 review); these tests
  // import the module from src/receiver, so name the temp root explicitly.
  process.env.SYNCSKILL_ROOT = join(homeDir, '.syncskill');

  try {
    return await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalSyncRoot === undefined) {
      delete process.env.SYNCSKILL_ROOT;
    } else {
      process.env.SYNCSKILL_ROOT = originalSyncRoot;
    }
  }
}

async function runReceiverCommandWithOutput(homeDir: string, command: string, extraArgs: string[] = [], stdinText?: string) {
  return withMockedHomeDir(homeDir, async () => {
    const argv = process.argv.slice();
    const originalStdin = process.stdin;
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let stdout = '';
    let stderr = '';
    process.argv = ['node', receiverPath, command, ...extraArgs];
    if (stdinText !== undefined) {
      Object.defineProperty(process, 'stdin', { value: Readable.from([stdinText]), configurable: true });
    }
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;

    try {
      await importReceiverModule();
      return { stdout, stderr };
    } finally {
      process.argv = argv;
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      if (stdinText !== undefined) {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    }
  });
}

async function runReceiverCommand(homeDir: string, command: string) {
  const { stdout } = await runReceiverCommandWithOutput(homeDir, command);
  return stdout;
}

async function runReceiverApply(homeDir: string) {
  return runReceiverCommandWithOutput(homeDir, 'apply');
}

function createReceiverManifest(updatedAt: string) {
  return createEmptyManifest('remote', updatedAt);
}


import {
  applyRemoteLinks,
  deployReceiver,
  fetchRemoteManifest,
  probeServerAccess,
  pruneRemoteStaging,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
  recoverRemoteBackups,
  refreshRemoteManifestFromServer,
  scanRemoteAgents,
  type TransportRuntime
} from '../../src/core/transport.js';

/**
 * Issue 408: ssh calls carry `-o BatchMode=yes -o ConnectTimeout=N`. The command keys below name the
 * remote command; the dedicated test asserts the options themselves.
 */
function lookupKey(file: string, args: string[]): string {
  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-o') {
      index += 1;
      continue;
    }
    cleaned.push(args[index]);
  }
  return [file, ...cleaned].join(' ');
}

function createRuntime(stdoutByCommand: Record<string, string> = {}): TransportRuntime & {
  calls: Array<{ file: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];

  return {
    calls,
    async exec(file, args, options = {}) {
      const key = lookupKey(file, args);
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

/** rsync parses its `-e` value with a shell-like tokenizer; this reads the same words back for assertions. */
function rshWords(rsh: string): string[] {
  const printed = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${rsh}`], { encoding: 'utf8' }).stdout;
  return printed.split('\0').slice(0, -1);
}

function rshOf(call: { file: string; args: string[] } | undefined): string {
  expect(call?.file).toBe('rsync');
  const index = call!.args.indexOf('-e');
  expect(index).toBeGreaterThanOrEqual(0);
  return call!.args[index + 1];
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
      runtime,
      {
        remote_agents: {
          claude: '~/.claude/skills'
        },
        links: {
          welcome: ['claude']
        }
      }
    );

    expect(runtime.calls.map((call) => [call.file, ...call.args])).toEqual(
      expect.arrayContaining([
        ['ssh', '-p', '2222', '-i', '/Users/demo/.ssh/id_syncskill', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'deploy@alpha.example.com', 'env', 'SYNCSKILL_NODE_BIN=node', 'sh', '-s', '--', '"$HOME/.syncskill"'],
        [
          'ssh',
          '-p',
          '2222',
          '-i',
          '/Users/demo/.ssh/id_syncskill',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          'deploy@alpha.example.com',
          'sh',
          '-lc',
          "'cat > \"$HOME/.syncskill/sync_receiver.mjs\"'"
        ],
        [
          'ssh',
          '-p',
          '2222',
          '-i',
          '/Users/demo/.ssh/id_syncskill',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          'deploy@alpha.example.com',
          'sh',
          '-lc',
          "'cat > \"$HOME/.syncskill/receiver_config.json\"'"
        ]
      ])
    );
    expect(runtime.calls.find((call) => call.file === 'ssh' && call.args.at(-1) === "'cat > \"$HOME/.syncskill/receiver_config.json\"'")).toMatchObject({
      stdin: expect.stringContaining('"links"')
    });
  });

  it('applyRemoteLinks runs receiver apply after uploading receiver config', async () => {
    const runtime = createRuntime();

    await applyRemoteLinks(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '/srv/skills'
        }
      },
      runtime,
      {
        remote_agents: {
          claude: '/srv/skills'
        },
        links: {
          welcome: ['claude']
        }
      }
    );

    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.at(-1) === "'cat > \"$HOME/.syncskill/receiver_config.json\"'" && call.stdin?.includes('"links"'))).toBe(true);
    expect(runtime.calls.some((call) => call.file === 'ssh' && call.args.at(-1) === 'apply')).toBe(true);
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
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" manifest': manifestJson
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
      args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'write-manifest'],
      stdin: `${JSON.stringify(manifest, null, 2)}\n`
    });
  });

  it.each([
    Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('rsync exited with code 12'), { code: 12, stderr: 'bash: line 1: rsync: command not found\n' })
  ])('pushSkillDirectory falls back to receiver import when rsync is unavailable (%s)', async (rsyncUnavailable) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
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
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'import-skill', '"welcome"'],
      expect.objectContaining({ stdin: expect.stringContaining('SKILL.md') })
    );
  });

  it('quotes an identity_file containing spaces in the rsync -e string', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    await pushSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        identity_file: '/tmp/My Keys/id_ed25519',
        remote_agents: {}
      },
      sourceDir,
      'welcome',
      runtime
    );

    const rsh = rshOf(runtime.calls[0]);
    expect(rsh).toBe("ssh -i '/tmp/My Keys/id_ed25519' -o BatchMode=yes -o ConnectTimeout=15");
    expect(rshWords(rsh)).toContain('/tmp/My Keys/id_ed25519');
  });

  it('quotes an identity_file containing a single quote in the rsync -e string', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    await pushSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        identity_file: "/tmp/My Keys/o'brien",
        remote_agents: {}
      },
      sourceDir,
      'welcome',
      runtime
    );

    expect(rshWords(rshOf(runtime.calls[0]))).toContain("/tmp/My Keys/o'brien");
  });

  it('leaves an identity_file without shell metacharacters unquoted', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    await pushSkillDirectory(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        identity_file: '/Users/demo/.ssh/id_syncskill',
        remote_agents: {}
      },
      sourceDir,
      'welcome',
      runtime
    );

    expect(rshOf(runtime.calls[0])).toBe('ssh -i /Users/demo/.ssh/id_syncskill -o BatchMode=yes -o ConnectTimeout=15');
  });

  it('pushSkillDirectory transfers into a staging directory and promotes it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    await pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, sourceDir, 'welcome', runtime);

    expect(runtime.calls).toHaveLength(2);
    const rsync = runtime.calls[0]!;
    const destination = rsync.args[rsync.args.length - 1]!;
    // mutation: rsync straight to the live directory -> the destination has no `.welcome.staging-`, red
    expect(destination).toMatch(/^alpha\.example\.com:"?.+\.welcome\.staging-[0-9a-f-]+\/"?$/);
    const promote = runtime.calls[1]!;
    expect(promote.file).toBe('ssh');
    expect(promote.args).toContain('promote-skill');
    expect(promote.args).toContain('"welcome"');
    // The promote names the same staging directory the transfer wrote.
    expect(promote.args[promote.args.length - 1]).toContain('.welcome.staging-');
  });

  it.each([
    { code: 12, message: 'rsync: unexpected end of file' },
    Object.assign(new Error('rsync: source file not found'), { code: 23 })
  ])('pushSkillDirectory classifies rsync exit $code and discards the staging tree', async (transferError) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const runtime = createRuntime();
    const exec = vi.fn<TransportRuntime['exec']>()
      .mockRejectedValueOnce(transferError)
      .mockResolvedValue({ stdout: '', stderr: '' });
    runtime.exec = exec;

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
    ).rejects.toHaveProperty('message', `E_REMOTE_TRANSPORT: cannot send welcome to alpha: ${transferError.message}`);

    // Issue #426: the partial staging tree is cleaned up instead of being left on the remote. The
    // original transfer error still propagates and there is no import-skill fallback.
    expect(exec.mock.calls.map(([file]) => file)).toEqual(['rsync', 'ssh']);
    expect(exec.mock.calls[1]![1]).toContain('remove-staging');
    expect(exec.mock.calls[1]![1].at(-1)).toContain('.welcome.staging-');
    expect(exec.mock.calls.some(([, args]) => args.includes('import-skill'))).toBe(false);
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
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'export-skill', '"welcome"'],
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
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" manifest': JSON.stringify({
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
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" scan-skills': JSON.stringify({
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
          args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'manifest']
        },
        {
          file: 'ssh',
          args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'scan-skills']
        },
        {
          file: 'ssh',
          args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'alpha.example.com', 'node', '"$HOME/.syncskill/sync_receiver.mjs"', 'write-manifest'],
          stdin: expect.stringContaining('"docs":')
        }
      ])
    );
  });

  it('probeServerAccess reports transport, receiver, manifest, and remote agent checks', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com true': '',
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" manifest': JSON.stringify(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z')),
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" probe-access': JSON.stringify({
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
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ssh true (transport)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // mkdir remote root
      .mockRejectedValueOnce(new Error('file not found')) // md5sum (receiverNeedsUpdate returns true)
      .mockRejectedValueOnce(new Error('receiver bootstrap failed')); // bootstrap fails

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
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ssh true (transport)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // mkdir remote root
      .mockRejectedValueOnce(new Error('file not found')) // md5sum (receiverNeedsUpdate returns true)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // bootstrap
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // receiver upload
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // config upload
      .mockRejectedValueOnce(new Error('manifest unreadable')); // manifest read fails

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

  it('receiver scan-agents classifies managed, manual, and remote-only skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    const syncRoot = join(homeDir, '.syncskill');
    const receiverConfigPath = join(syncRoot, 'receiver_config.json');
    const receiverSkillsDir = join(syncRoot, 'skills');
    const agentDir = join(homeDir, 'agent-skills');

    await mkdir(join(receiverSkillsDir, 'welcome'), { recursive: true });
    await writeFile(join(receiverSkillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');
    await mkdir(join(receiverSkillsDir, 'detached'), { recursive: true });
    await writeFile(join(receiverSkillsDir, 'detached', 'SKILL.md'), '# detached\n', 'utf8');
    await mkdir(join(agentDir, 'manual'), { recursive: true });
    await writeFile(join(agentDir, 'manual', 'SKILL.md'), '# manual\n', 'utf8');
    await mkdir(syncRoot, { recursive: true });
    await symlink(join(receiverSkillsDir, 'welcome'), join(agentDir, 'welcome'), 'dir');
    await writeFile(receiverConfigPath, `${JSON.stringify({ remote_agents: { claude: agentDir } }, null, 2)}\n`, 'utf8');

    const output = await runReceiverCommand(homeDir, 'scan-agents');
    const parsed = JSON.parse(output) as {
      discovered_agents: Array<{ name: string; path: string; symlinked_skills: string[]; directory_skills: string[] }>;
      remote_only_skills: string[];
    };

    expect(parsed).toEqual({
      discovered_agents: [
        {
          name: 'claude',
          path: agentDir,
          symlinked_skills: ['welcome'],
          directory_skills: ['manual']
        }
      ],
      remote_only_skills: ['detached']
    });
  });

  it('scanRemoteAgents reads remote receiver scan output', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" scan-agents': JSON.stringify({
        discovered_agents: [
          {
            name: 'claude',
            path: '/srv/skills',
            symlinked_skills: ['welcome'],
            directory_skills: ['manual']
          }
        ],
        remote_only_skills: ['detached']
      })
    });

    await expect(
      scanRemoteAgents(
        {
          name: 'alpha',
          host: 'alpha.example.com',
          remote_agents: {
            claude: '/srv/skills'
          }
        },
        runtime,
        { deploy: false }
      )
    ).resolves.toEqual({
      discovered_agents: [
        {
          name: 'claude',
          path: '/srv/skills',
          symlinked_skills: ['welcome'],
          directory_skills: ['manual']
        }
      ],
      remote_only_skills: ['detached']
    });
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

  it('receiver import-skill leaves the old tree intact when the new one is rejected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillDir = join(syncRoot, 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# old\n', 'utf8');

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        const stdin = process.stdin;
        const stream = Readable.from([
          JSON.stringify({ files: {
            'good.md': Buffer.from('new\n').toString('base64'),
            '../escape.txt': Buffer.from('nope').toString('base64')
          } })
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
    ).rejects.toThrow('Invalid skill entry: ../escape.txt');

    // mutation: delete the live tree before writing the new one -> SKILL.md is gone, red
    await expect(readFile(join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# old\n');
    await expect(readdir(join(syncRoot, 'skills'))).resolves.toEqual(['welcome']);
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
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" manifest': JSON.stringify(createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z')),
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" probe-access': '{broken-json'
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

  it('receiver apply preserves existing directories and emits takeover warnings', async () => {
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
    await mkdir(join(agentDir, 'welcome'), { recursive: true });
    await writeFile(join(agentDir, 'welcome', 'LOCAL.md'), 'keep me\n', 'utf8');

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

    const { stdout, stderr } = await runReceiverApply(homeDir);

    expect(stderr).toContain('W_TAKEOVER_NEEDED: claude/welcome is not a syncskill-managed symlink; use `remote takeover` to replace');
    expect(JSON.parse(stdout)).toMatchObject({
      skills: {
        welcome: {
          status: 'in-sync',
          direction: 'skip'
        }
      }
    });
    await expect(readFile(join(agentDir, 'welcome', 'LOCAL.md'), 'utf8')).resolves.toBe('keep me\n');
    await expect(readFile(join(agentDir, 'welcome', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('receiver apply honors links matrix and removes unlinked symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);

    const syncRoot = join(homeDir, '.syncskill');
    const skillsDir = join(syncRoot, 'skills');
    const receiverConfigPath = join(syncRoot, 'receiver_config.json');
    const manifestPath = join(syncRoot, 'manifest.json');
    const claudeDir = join(homeDir, 'claude-skills');
    const codexDir = join(homeDir, 'codex-skills');

    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');
    await mkdir(join(skillsDir, 'shared'), { recursive: true });
    await writeFile(join(skillsDir, 'shared', 'SKILL.md'), '# shared\n', 'utf8');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await symlink(join(skillsDir, 'welcome'), join(codexDir, 'welcome'), 'dir');
    await mkdir(syncRoot, { recursive: true });

    const manifest = createReceiverManifest('2026-05-01T00:00:00.000Z');
    manifest.skills.welcome = {
      local_hash: null,
      remote_hash: 'welcome-hash',
      recorded_hash: 'welcome-hash',
      direction: 'skip',
      status: 'in-sync'
    };
    manifest.skills.shared = {
      local_hash: null,
      remote_hash: 'shared-hash',
      recorded_hash: 'shared-hash',
      direction: 'skip',
      status: 'in-sync'
    };

    await writeFile(receiverConfigPath, `${JSON.stringify({
      remote_agents: {
        claude: claudeDir,
        codex: codexDir
      },
      links: {
        welcome: ['claude'],
        shared: ['*']
      }
    }, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await runReceiverApply(homeDir);

    await expect(readFile(join(claudeDir, 'welcome', 'SKILL.md'), 'utf8')).resolves.toBe('# welcome\n');
    await expect(readFile(join(codexDir, 'welcome', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(claudeDir, 'shared', 'SKILL.md'), 'utf8')).resolves.toBe('# shared\n');
    await expect(readFile(join(codexDir, 'shared', 'SKILL.md'), 'utf8')).resolves.toBe('# shared\n');
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

  it('pushSkillDirectory discards the staging tree when promote-skill fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    const promoteError = new Error('promote-skill exited with code 1');
    const runtime = createRuntime();
    const exec = vi
      .fn<TransportRuntime['exec']>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // rsync
      .mockRejectedValueOnce(promoteError) // promote-skill
      .mockResolvedValue({ stdout: '', stderr: '' }); // cleanup
    runtime.exec = exec;

    await expect(
      pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, sourceDir, 'welcome', runtime)
    ).rejects.toBe(promoteError);

    // Issue #426: rsync wrote a staging tree that promote could not consume; the transport asks the
    // receiver to remove it and still surfaces the promote error.
    expect(exec.mock.calls.map(([file]) => file)).toEqual(['rsync', 'ssh', 'ssh']);
    expect(exec.mock.calls[1]![1]).toContain('promote-skill');
    expect(exec.mock.calls[2]![1]).toContain('remove-staging');
    expect(exec.mock.calls[2]![1].at(-1)).toContain('.welcome.staging-');
  });

  it('pruneRemoteStaging asks the receiver for stale staging trees and passes the flags through', async () => {
    const runtime = createRuntime({
      'ssh alpha.example.com node "$HOME/.syncskill/sync_receiver.mjs" prune-staging --apply --older-than-ms 86400000': JSON.stringify({
        applied: true,
        pruned: [{ skill: 'welcome', name: '.welcome.staging-x', path: '$HOME/.syncskill/skills/.welcome.staging-x', age_ms: 90000000, bytes: 12 }],
        skipped: []
      })
    });

    const result = await pruneRemoteStaging({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, runtime, {
      apply: true,
      olderThanMs: 86_400_000
    });

    expect(result.applied).toBe(true);
    expect(result.pruned.map((entry) => entry.name)).toEqual(['.welcome.staging-x']);
    const args = runtime.calls[0]!.args;
    expect(args).toContain('prune-staging');
    expect(args).toContain('--apply');
    expect(args).toContain('--older-than-ms');
    expect(args).toContain('86400000');
  });

  it.each([
    { mode: 'dry-run', args: [], expectedApplied: false },
    { mode: 'apply', args: ['--apply'], expectedApplied: true }
  ])('prune --recover-backups --json includes per-server backup outcomes in $mode mode', async ({ args, expectedApplied }) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-'));
    tempDirs.push(homeDir);
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: { alpha: { host: 'alpha.example.com', remote_agents: {} } },
        sources: {}
      },
      homeDir
    );

    const runtime = {
      async exec(_file: string, commandArgs: string[]) {
        const command = commandArgs.join(' ');
        if (command.includes('recover-backup')) {
          return {
            stdout: JSON.stringify({
              applied: expectedApplied,
              recovered: [{ skill: 'welcome', from: '.welcome.backup-crash', to: 'welcome' }],
              skipped: [{ skill: 'docs', reason: 'live-present', backups: ['.docs.backup-crash'] }]
            }),
            stderr: ''
          };
        }
        return { stdout: JSON.stringify({ applied: expectedApplied, pruned: [], skipped: [] }), stderr: '' };
      }
    };
    vi.spyOn(await import('../../src/core/transport.js'), 'createTransportRuntime').mockReturnValue(runtime);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', '--json', 'prune', ...args, 'alpha', '--recover-backups'],
      { from: 'node' }
    );

    const resultEvent = consoleLog.mock.calls
      .map(([line]) => JSON.parse(line as string))
      .find((event) => event.type === 'result');
    expect(resultEvent.summary.servers).toEqual([
      {
        server: 'alpha',
        applied: expectedApplied,
        pruned: [],
        skipped: [],
        backups: {
          applied: expectedApplied,
          recovered: [{ skill: 'welcome', from: '.welcome.backup-crash', to: 'welcome' }],
          skipped: [{ skill: 'docs', reason: 'live-present', backups: ['.docs.backup-crash'] }]
        }
      }
    ]);
  });

  it('receiver promote-skill removes the staging tree it could not consume', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const stagingDir = join(syncRoot, 'skills', '.welcome.staging-x');
    await mkdir(join(syncRoot, 'skills'), { recursive: true });
    // A file with the staging name fails the directory check after validation.
    await writeFile(stagingDir, 'not a directory', 'utf8');

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        process.argv = ['node', receiverPath, 'promote-skill', 'welcome', stagingDir];
        try {
          await importReceiverModule();
        } finally {
          process.argv = argv;
        }
      })
    ).rejects.toThrow('Staging directory is not a directory');

    // Issue #426: the failed promote leaves nothing behind.
    await expect(access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('receiver remove-staging only removes a staging tree', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const liveDir = join(syncRoot, 'skills', 'welcome');
    const stagingDir = join(syncRoot, 'skills', '.welcome.staging-x');
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'SKILL.md'), '# live\n', 'utf8');
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, 'SKILL.md'), '# half\n', 'utf8');

    await expect(runReceiverCommandWithOutput(homeDir, 'remove-staging', [liveDir])).rejects.toThrow(
      'Refusing to remove a non-staging path'
    );
    await expect(access(liveDir)).resolves.toBeUndefined();

    await runReceiverCommandWithOutput(homeDir, 'remove-staging', [stagingDir]);
    await expect(access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
    // Idempotent: the transport cleanup runs best-effort and may race the receiver's own cleanup.
    await runReceiverCommandWithOutput(homeDir, 'remove-staging', [stagingDir]);
  });

  it('receiver prune-staging lists only old staging trees and --apply removes them', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillsDir = join(syncRoot, 'skills');
    const oldStaging = join(skillsDir, '.gone.staging-old');
    const freshStaging = join(skillsDir, '.busy.staging-new');
    const liveDir = join(skillsDir, 'gone');
    const backupDir = join(skillsDir, '.gone.backup-x');
    for (const [dir, contents] of [
      [oldStaging, 'stale'],
      [freshStaging, 'busy'],
      [liveDir, 'live'],
      [backupDir, 'backup']
    ] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), contents, 'utf8');
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    await utimes(oldStaging, twoDaysAgo, twoDaysAgo);

    const { stdout } = await runReceiverCommandWithOutput(homeDir, 'prune-staging', ['--older-than-ms', '86400000']);
    const listed = JSON.parse(stdout);
    expect(listed.applied).toBe(false);
    expect(listed.pruned.map((entry: { name: string }) => entry.name)).toEqual(['.gone.staging-old']);
    expect(listed.skipped.map((entry: { name: string }) => entry.name)).toEqual(['.busy.staging-new']);
    // Live and backup trees are never candidates.
    const mentioned = [...listed.pruned, ...listed.skipped].map((entry: { path: string }) => entry.path);
    expect(mentioned).not.toContain(liveDir);
    expect(mentioned).not.toContain(backupDir);

    const { stdout: appliedOut } = await runReceiverCommandWithOutput(homeDir, 'prune-staging', [
      '--older-than-ms',
      '86400000',
      '--apply'
    ]);
    expect(JSON.parse(appliedOut).applied).toBe(true);
    await expect(access(oldStaging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(freshStaging)).resolves.toBeUndefined();
    await expect(access(liveDir)).resolves.toBeUndefined();
    await expect(access(backupDir)).resolves.toBeUndefined();
  });

  it('receiver reports a corrupt manifest with a named error', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    await mkdir(syncRoot, { recursive: true });
    await writeFile(join(syncRoot, 'manifest.json'), '{"version": 1, "skills": {', 'utf8');

    await expect(
      withMockedHomeDir(homeDir, async () => {
        const argv = process.argv.slice();
        process.argv = ['node', receiverPath, 'manifest'];
        try {
          await importReceiverModule();
        } finally {
          process.argv = argv;
        }
      })
    ).rejects.toThrow(/manifest-invalid: .*restore .*manifest\.json\.bak/);
  });

  it('receiver write-manifest replaces atomically and keeps the previous manifest as .bak', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const manifestFile = join(syncRoot, 'manifest.json');
    const first = { version: 1, server: 'first', updated_at: '2026-11-21T00:00:00.000Z', skills: {} };
    const second = { version: 1, server: 'second', updated_at: '2026-11-22T00:00:00.000Z', skills: {} };

    await runReceiverCommandWithOutput(homeDir, 'write-manifest', [], JSON.stringify(first));
    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toMatchObject({ server: 'first' });

    await runReceiverCommandWithOutput(homeDir, 'write-manifest', [], JSON.stringify(second));
    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toMatchObject({ server: 'second' });
    // Issue #427: the previous good manifest is available for recovery.
    expect(JSON.parse(await readFile(`${manifestFile}.bak`, 'utf8'))).toMatchObject({ server: 'first' });
    // No half-written temp files survive a completed write.
    expect((await readdir(syncRoot)).some((name) => name.startsWith('manifest.json.tmp-'))).toBe(false);
  });

  it('receiver recover-backup restores the only backup when the live tree is gone', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillsDir = join(syncRoot, 'skills');
    const backupDir = join(skillsDir, '.welcome.backup-123-abc');
    const liveDir = join(skillsDir, 'welcome');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# recovered\n', 'utf8');

    // Dry run names the recovery and moves nothing.
    const { stdout: dry } = await runReceiverCommandWithOutput(homeDir, 'recover-backup');
    expect(JSON.parse(dry)).toEqual({ applied: false, recovered: [{ skill: 'welcome', from: backupDir, to: liveDir }], skipped: [] });
    await expect(access(liveDir)).rejects.toMatchObject({ code: 'ENOENT' });
    // With --apply it puts the only copy back.
    const { stdout: performed } = await runReceiverCommandWithOutput(homeDir, 'recover-backup', ['--apply']);
    const applied = JSON.parse(performed);
    expect(applied).toEqual({ applied: true, recovered: [{ skill: 'welcome', from: backupDir, to: liveDir }], skipped: [] });
    // The interrupted swap left the backup as the only copy; the live tree is the backup's tree again.
    expect(await readFile(join(liveDir, 'SKILL.md'), 'utf8')).toBe('# recovered\n');
    await expect(access(backupDir)).rejects.toMatchObject({ code: 'ENOENT' });

    // Nothing left to recover is a quiet no-op, so a repeat is safe.
    const { stdout: again } = await runReceiverCommandWithOutput(homeDir, 'recover-backup', ['--apply']);
    expect(JSON.parse(again)).toEqual({ applied: true, recovered: [], skipped: [] });
  });

  it('receiver recover-backup never touches a live tree and refuses an ambiguous backup set', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const skillsDir = join(syncRoot, 'skills');
    const liveDir = join(skillsDir, 'welcome');
    const one = join(skillsDir, '.welcome.backup-1-a');
    const two = join(skillsDir, '.welcome.backup-2-b');
    const orphan = join(skillsDir, '.lonely.backup-3-c');
    for (const dir of [liveDir, one, two, orphan]) await mkdir(dir, { recursive: true });
    await writeFile(join(liveDir, 'SKILL.md'), '# live\n', 'utf8');
    await writeFile(join(one, 'SKILL.md'), '# one\n', 'utf8');
    await writeFile(join(two, 'SKILL.md'), '# two\n', 'utf8');
    await writeFile(join(orphan, 'SKILL.md'), '# orphan\n', 'utf8');

    const { stdout: dry } = await runReceiverCommandWithOutput(homeDir, 'recover-backup', ['--apply']);
    const answer = JSON.parse(dry);
    // A live tree is never replaced, whatever backups sit beside it.
    expect(await readFile(join(liveDir, 'SKILL.md'), 'utf8')).toBe('# live\n');
    expect(answer.recovered.map((entry: { skill: string }) => entry.skill)).toEqual(['lonely']);
    expect(answer.skipped).toEqual([
      { skill: 'welcome', reason: 'live-present', backups: [one, two] }
    ]);
    await expect(access(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(liveDir, 'SKILL.md'), 'utf8')).toBe('# live\n');

    // Two backups and no live tree: which one is the truth is a guess, so it stays and is named.
    const homeDir2 = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir2);
    const skills2 = join(homeDir2, '.syncskill', 'skills');
    const a = join(skills2, '.welcome.backup-1-a');
    const b = join(skills2, '.welcome.backup-2-b');
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    const { stdout: ambiguous } = await runReceiverCommandWithOutput(homeDir2, 'recover-backup', ['--apply']);
    expect(JSON.parse(ambiguous)).toEqual({ applied: true, recovered: [], skipped: [{ skill: 'welcome', reason: 'ambiguous', backups: [a, b] }] });
    await expect(access(a)).resolves.toBeUndefined();
    await expect(access(b)).resolves.toBeUndefined();
  });

  it('receiver write-manifest does not overwrite a good .bak with a corrupt manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-receiver-'));
    tempDirs.push(homeDir);
    const syncRoot = join(homeDir, '.syncskill');
    const manifestFile = join(syncRoot, 'manifest.json');
    const first = { version: 1, server: 'first', updated_at: '2026-11-21T00:00:00.000Z', skills: {} };
    const second = { version: 1, server: 'second', updated_at: '2026-11-22T00:00:00.000Z', skills: {} };
    const third = { version: 1, server: 'third', updated_at: '2026-11-22T01:00:00.000Z', skills: {} };

    await runReceiverCommandWithOutput(homeDir, 'write-manifest', [], JSON.stringify(first));
    await runReceiverCommandWithOutput(homeDir, 'write-manifest', [], JSON.stringify(second));
    await writeFile(manifestFile, '{"version": 1, "server": "trunc', 'utf8');

    await runReceiverCommandWithOutput(homeDir, 'write-manifest', [], JSON.stringify(third));
    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toMatchObject({ server: 'third' });
    // The last parseable manifest is still recoverable.
    expect(JSON.parse(await readFile(`${manifestFile}.bak`, 'utf8'))).toMatchObject({ server: 'first' });
  });
});
