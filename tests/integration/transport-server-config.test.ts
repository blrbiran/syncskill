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
    expect(rsync.args.at(-1)).toBe('alpha.example.com:/srv/root/skills/welcome/');
  });
});