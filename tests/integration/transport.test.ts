import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../../src/config.js';
import { createEmptyManifest } from '../../src/manifest.js';

const receiverPath = new URL('../../src/receiver/sync_receiver.mjs', import.meta.url).pathname;

async function importReceiverModule() {
  return import(`${pathToFileURL(receiverPath).href}?t=${Date.now()}-${Math.random()}`);
}

async function withMockedHomeDir(homeDir: string, run: () => Promise<void>) {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

async function runReceiverApply(homeDir: string) {
  await withMockedHomeDir(homeDir, async () => {
    const argv = process.argv.slice();
    process.argv = ['node', receiverPath, 'apply'];

    try {
      await importReceiverModule();
    } finally {
      process.argv = argv;
    }
  });
}

function createReceiverManifest(updatedAt: string) {
  return createEmptyManifest('remote', updatedAt);
}


import {
  deployReceiver,
  fetchRemoteManifest,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
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
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
