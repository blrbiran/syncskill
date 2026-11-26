import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import {
  deployReceiver,
  listRemoteSkills,
  pullSkillDirectory,
  pushSkillDirectory,
  refreshRemoteManifestFromServer,
  scanRemoteAgents,
  takeOverRemoteSkill,
  type TransportRuntime
} from '../../src/core/transport.js';

import { createEmptyManifest } from '../../src/core/manifest.js';

function createRuntime(remoteHome?: string): TransportRuntime & { calls: Array<{ file: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];
  return {
    calls,
    async exec(file, args, options = {}) {
      calls.push({ file, args, stdin: typeof options.stdin === 'string' ? options.stdin : undefined });
      const scriptIndex = args.indexOf('-lc');
      if (remoteHome && file === 'ssh' && scriptIndex !== -1) {
        const command = args.slice(scriptIndex - 1).join(' ');
        // OpenSSH joins remote argv with spaces before the remote shell parses it.
        const result = spawnSync('/bin/sh', ['-c', command], {
          cwd: remoteHome, encoding: 'utf8', input: options.stdin ?? ''
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return { stdout: result.stdout, stderr: result.stderr };
      }
      if (file === 'ssh' && args.at(-1) === 'manifest') {
        return { stdout: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} }), stderr: '' };
      }
      if (file === 'ssh' && args.includes('scan-agents')) {
        return { stdout: JSON.stringify({ discovered_agents: [], remote_only_skills: [] }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  };
}

const shellCalls = (runtime: { calls: Array<{ file: string; args: string[] }> }) =>
  runtime.calls.filter((call) => call.file === 'ssh' || call.file === 'rsync').map((call) => call.args.join(' '));

describe('server transport configuration', () => {
  const tempDirs = useTempDirs();

  it('routes every remote path through remote_repo (issue 405)', async () => {
    const runtime = createRuntime();
    const server = { name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/syncskill', remote_agents: {} };

    await deployReceiver(server, runtime);
    await listRemoteSkills(server, runtime);
    await scanRemoteAgents(server, runtime);

    const joined = shellCalls(runtime).join('\n');
    expect(joined).toContain('/srv/syncskill/sync_receiver.mjs');
    expect(joined).toContain('/srv/syncskill/receiver_config.json');
    expect(joined).toContain('/srv/syncskill/skills');
    expect(joined).not.toContain('~/.syncskill');
    expect(joined).not.toContain('$HOME/.syncskill');
  });

  it('uses node_bin and unattended ssh options (issue 408)', async () => {
    const runtime = createRuntime();
    const server = {
      name: 'alpha',
      host: 'alpha.example.com',
      node_bin: '/home/u/.nvm/versions/node/v22.23.4/bin/node',
      connect_timeout_ms: 5_000,
      remote_agents: {}
    };

    await scanRemoteAgents(server, runtime, { deploy: false });

    const call = runtime.calls.at(-1)!;
    expect(call.args).toContain('/home/u/.nvm/versions/node/v22.23.4/bin/node');
    expect(call.args).toContain('-o');
    expect(call.args).toContain('BatchMode=yes');
    expect(call.args).toContain('ConnectTimeout=5');
    expect(call.args).not.toContain('node');
  });

  it('bootstraps with a configured node outside the remote PATH', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'syncskill-bootstrap-node-'));
    tempDirs.push(remoteHome);
    const pathDir = join(remoteHome, 'path');
    const nodeBin = join(remoteHome, 'nvm', 'bin', 'node');
    const root = join(remoteHome, 'syncskill');
    await mkdir(pathDir, { recursive: true });
    await mkdir(join(remoteHome, 'nvm', 'bin'), { recursive: true });
    await writeFile(nodeBin, `#!/bin/sh
printf 'v22.0.0\\n'
`, 'utf8');
    await chmod(nodeBin, 0o755);
    await symlink('/bin/mkdir', join(pathDir, 'mkdir'));
    await symlink('/usr/bin/touch', join(pathDir, 'touch'));
    await symlink('/bin/rm', join(pathDir, 'rm'));
    const bootstrap = await readFile(new URL('../../src/receiver/bootstrap_remote.sh', import.meta.url), 'utf8');

    const result = spawnSync('/bin/sh', ['-s', '--', root], {
      cwd: remoteHome,
      encoding: 'utf8',
      env: { PATH: pathDir, SYNCSKILL_NODE_BIN: nodeBin },
      input: bootstrap
    });

    expect(result.status, result.stderr).toBe(0);
    expect((await stat(join(root, 'skills'))).isDirectory()).toBe(true);
  });

  it('passes the configured node_bin into the remote bootstrap', async () => {
    const runtime = createRuntime();
    const nodeBin = '/home/deploy/.nvm/versions/node/v22.23.4/bin/node';

    await deployReceiver({
      name: 'alpha',
      host: 'alpha.example.com',
      node_bin: nodeBin,
      remote_agents: {}
    }, runtime);

    const bootstrapCall = runtime.calls.find((call) => call.file === 'ssh' && call.args.includes('-s'));
    expect(bootstrapCall?.args.slice(bootstrapCall.args.indexOf('alpha.example.com') + 1).join(' ')).toBe(
      'env SYNCSKILL_NODE_BIN=/home/deploy/.nvm/versions/node/v22.23.4/bin/node sh -s -- "$HOME/.syncskill"'
    );
  });

  it('pull removes files the remote no longer has (issue 407)', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const targetDir = join(homeDir, 'target');
    await mkdir(targetDir, { recursive: true });

    await pullSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, 'welcome', targetDir, runtime);

    const rsync = runtime.calls.find((call) => call.file === 'rsync')!;
    expect(rsync.args).toContain('--delete');
  });

  it('push still carries --delete and the configured root', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    await pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/root', remote_agents: {} }, sourceDir, 'welcome', runtime);

    const rsync = runtime.calls.find((call) => call.file === 'rsync')!;
    expect(rsync.args).toContain('--delete');
    expect(rsync.args.at(-1)).toContain('/srv/root/skills/.welcome.staging-');
  });

  it('quotes a remote root with spaces so rsync keeps one destination (issue 421)', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    await pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/My Skills', remote_agents: {} }, sourceDir, 'welcome', runtime);
    await pullSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/My Skills', remote_agents: {} }, 'welcome', join(homeDir, 'target'), runtime);

    const rsyncCalls = runtime.calls.filter((call) => call.file === 'rsync');
    expect(rsyncCalls[0].args.at(-1)).toContain('/srv/My Skills/skills/.welcome.staging-');
    expect(rsyncCalls[1].args.at(-2)).toBe('alpha.example.com:"/srv/My Skills/skills/welcome/"');
  });

  it('escapes dollar signs instead of letting the remote shell expand them (issue 421)', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    await pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/$HOME', remote_agents: {} }, sourceDir, 'welcome', runtime);

    const rsync = runtime.calls.find((call) => call.file === 'rsync')!;
    expect(rsync.args.at(-1)).toContain('/srv/\\$HOME/skills/.welcome.staging-');
  });

  it('keeps the default root as the remote home (issue 421 regression)', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# welcome\n', 'utf8');

    await pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, sourceDir, 'welcome', runtime);

    const rsync = runtime.calls.find((call) => call.file === 'rsync')!;
    expect(rsync.args.at(-1)).toContain('"$HOME/.syncskill/skills/.welcome.staging-');
  });

  it('refresh creates a non-default remote root and uploads both files after SSH shell parsing', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'syncskill-remote-shell-'));
    tempDirs.push(remoteHome);
    const root = join(remoteHome, "My Skill's Root");
    const runtime = createRuntime(remoteHome);
    const server = { name: 'alpha', host: 'alpha.example.com', remote_repo: root, remote_agents: {} };
    const updatedAt = '2026-05-01T00:00:00.000Z';

    await refreshRemoteManifestFromServer(server, runtime, createEmptyManifest(server.name, updatedAt), updatedAt);

    await expect(readFile(join(root, 'sync_receiver.mjs'), 'utf8')).resolves.toBe(
      await readFile(new URL('../../src/receiver/sync_receiver.mjs', import.meta.url), 'utf8')
    );
    await expect(readFile(join(root, 'receiver_config.json'), 'utf8')).resolves.toBe('{\n  "remote_agents": {}\n}\n');
    expect((await stat(join(root, 'skills'))).isDirectory()).toBe(true);
    expect(runtime.calls.some((call) => call.args.slice(-4).join(' ') === `sh -s -- "${root}"`)).toBe(true);
  });

  it('distinguishes symlink, directory, file, and missing paths after SSH shell parsing', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'syncskill-remote-shell-'));
    tempDirs.push(remoteHome);
    const root = join(remoteHome, 'remote root');
    const runtime = createRuntime(remoteHome);
    const remote_agents = Object.fromEntries(['directory', 'file', 'missing', 'symlink'].map(
      (type) => [type, join(remoteHome, `${type} agent`)]
    ));
    const server = { name: 'alpha', host: 'alpha.example.com', remote_repo: root, remote_agents };
    const skillDir = join(root, 'skills', 'welcome');
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(remote_agents.directory, 'welcome'), { recursive: true });
    await mkdir(remote_agents.file);
    await writeFile(join(remote_agents.file, 'welcome'), 'file');
    await mkdir(remote_agents.symlink);
    await symlink(skillDir, join(remote_agents.symlink, 'welcome'));

    const result = await takeOverRemoteSkill(server, 'welcome', { dryRun: true, runtime });

    expect(result.takeovers.map(({ agent, remote_type }) => [agent, remote_type])).toEqual([
      ['directory', 'directory'], ['file', 'file']
    ]);
    expect(result.skipped.map(({ agent, reason }) => [agent, reason])).toEqual([
      ['missing', 'not present'], ['symlink', 'already symlink']
    ]);
  });

  it('names the remote root when it cannot be created (issue 422)', async () => {
    const runtime: TransportRuntime = {
      async exec(_file, args) {
        if (args.some((arg) => arg.includes('mkdir -p'))) {
          throw new Error('Permission denied');
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(
      deployReceiver({ name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/My Skills', remote_agents: {} }, runtime)
    ).rejects.toThrow('E_REMOTE_ROOT: cannot create /srv/My Skills on alpha');
  });

  it('does not blame the root when ssh itself failed (issue 422 review)', async () => {
    const runtime: TransportRuntime = {
      async exec() {
        throw new Error('ssh exited with code 255: Permission denied (publickey)');
      }
    };

    await expect(
      deployReceiver({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, runtime)
    ).rejects.toThrow('E_REMOTE_TRANSPORT: cannot reach alpha');
  });

  it('refuses a skill name that would reach the remote shell as more than one word (issue 421 review)', async () => {
    const runtime = createRuntime();
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-transport-config-'));
    tempDirs.push(homeDir);
    const sourceDir = join(homeDir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await expect(
      pushSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, sourceDir, 'a;id', runtime)
    ).rejects.toThrow('Invalid skill name: a;id');
    await expect(
      pullSkillDirectory({ name: 'alpha', host: 'alpha.example.com', remote_agents: {} }, 'my skill', join(homeDir, 'target'), runtime)
    ).rejects.toThrow('Invalid skill name: my skill');
    expect(runtime.calls).toHaveLength(0);
  });
});