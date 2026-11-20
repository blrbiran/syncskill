import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import {
  deployReceiver,
  listRemoteSkills,
  pullSkillDirectory,
  pushSkillDirectory,
  scanRemoteAgents,
  type TransportRuntime
} from '../../src/core/transport.js';

function createRuntime(): TransportRuntime & { calls: Array<{ file: string; args: string[]; stdin?: string }> } {
  const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];
  return {
    calls,
    async exec(file, args, options = {}) {
      calls.push({ file, args, stdin: typeof options.stdin === 'string' ? options.stdin : undefined });
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
    expect(rsync.args.at(-1)).toBe('alpha.example.com:"/srv/root/skills/welcome/"');
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
    expect(rsyncCalls[0].args.at(-1)).toBe('alpha.example.com:"/srv/My Skills/skills/welcome/"');
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
    expect(rsync.args.at(-1)).toBe('alpha.example.com:"/srv/\\$HOME/skills/welcome/"');
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
    expect(rsync.args.at(-1)).toBe('alpha.example.com:"$HOME/.syncskill/skills/welcome/"');
  });

  it('creates a non-default remote root before deploying the receiver (issue 422)', async () => {
    const runtime = createRuntime();
    const server = { name: 'alpha', host: 'alpha.example.com', remote_repo: '/srv/My Skills', remote_agents: {} };

    await deployReceiver(server, runtime);

    const calls = runtime.calls.map((call) => call.args.join(' '));
    expect(calls.some((call) => call.includes('mkdir -p "/srv/My Skills" "/srv/My Skills/skills"'))).toBe(true);
    expect(runtime.calls.some((call) => call.args.join(' ').endsWith('sh -s -- "/srv/My Skills"'))).toBe(true);
    expect(calls.some((call) => call.includes('cat > "/srv/My Skills/sync_receiver.mjs"'))).toBe(true);
    expect(calls.some((call) => call.includes('cat > "/srv/My Skills/receiver_config.json"'))).toBe(true);
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
});