import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { deleteRemoteSkills, listRemoteSkills, receiverNeedsUpdate, takeOverRemoteSkill, type TransportRuntime } from '../../src/core/transport.js';

const receiverPath = new URL('../../src/receiver/sync_receiver.mjs', import.meta.url).pathname;

function createRuntime(stdoutByCommand: Record<string, string> = {}, errorByCommand: Record<string, Error> = {}): TransportRuntime {
  return {
    async exec(file, args) {
      const key = [file, ...args].join(' ');

      if (key in errorByCommand) {
        throw errorByCommand[key];
      }

      if (key in stdoutByCommand) {
        return { stdout: stdoutByCommand[key], stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }
  };
}

const testServer = {
  name: 'test-server',
  host: 'example.com',
  user: 'testuser'
};

describe('receiverNeedsUpdate', () => {
  it('returns true when remote file does not exist (md5sum throws)', async () => {
    const runtime = createRuntime(
      {},
      { 'ssh testuser@example.com md5sum ~/.syncskill/sync_receiver.mjs': new Error('md5sum: file not found') }
    );

    const result = await receiverNeedsUpdate(testServer, runtime);

    expect(result).toBe(true);
  });

  it('returns true when hash differs', async () => {
    const runtime = createRuntime({
      'ssh testuser@example.com md5sum ~/.syncskill/sync_receiver.mjs': 'differenthash123456789012  ~/.syncskill/sync_receiver.mjs'
    });

    const result = await receiverNeedsUpdate(testServer, runtime);

    expect(result).toBe(true);
  });

  it('returns false when hash matches', async () => {
    // Compute actual hash from local file
    const localContent = await readFile(receiverPath, 'utf8');
    const localHash = createHash('md5').update(localContent).digest('hex');

    const runtime = createRuntime({
      'ssh testuser@example.com md5sum ~/.syncskill/sync_receiver.mjs': `${localHash}  ~/.syncskill/sync_receiver.mjs`
    });

    const result = await receiverNeedsUpdate(testServer, runtime);

    expect(result).toBe(false);
  });
});

const mockServer = {
  name: 'mock-server',
  host: 'mock.example.com',
  user: 'mockuser'
};

describe('listRemoteSkills', () => {
  it('returns skill names from remote skills directory', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          return { stdout: 'skill-a\nskill-b\nskill-c\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await listRemoteSkills(mockServer, runtime);
    expect(result).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('returns empty array when directory is empty or missing', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          throw new Error('No such file or directory');
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await listRemoteSkills(mockServer, runtime);
    expect(result).toEqual([]);
  });
});

describe('takeOverRemoteSkill', () => {
  it('takes over directories and skips missing or managed paths', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime: TransportRuntime = {
      calls,
      async exec(file, args) {
        calls.push({ file, args });
        const script = args.at(-1) ?? '';

        if (script.includes('$HOME/.syncskill/skills/welcome')) {
          return { stdout: 'directory', stderr: '' };
        }
        if (script.includes('$HOME/.claude/skills/welcome')) {
          return { stdout: 'directory', stderr: '' };
        }
        if (script.includes('$HOME/.cursor/skills/welcome')) {
          return { stdout: 'symlink', stderr: '' };
        }
        if (script.includes('$HOME/.zed/skills/welcome')) {
          return { stdout: 'missing', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await takeOverRemoteSkill(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '~/.claude/skills',
          cursor: '~/.cursor/skills',
          zed: '~/.zed/skills'
        }
      },
      'welcome',
      { runtime }
    );

    expect(result).toEqual({
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
      skipped: [
        {
          agent: 'cursor',
          path: '~/.cursor/skills/welcome',
          reason: 'already symlink'
        },
        {
          agent: 'zed',
          path: '~/.zed/skills/welcome',
          reason: 'not present'
        }
      ]
    });
    expect(calls.some((call) => call.file === 'ssh' && (call.args.at(-1) ?? '').includes('rm -rf "$HOME/.claude/skills/welcome" && ln -s "$HOME/.syncskill/skills/welcome" "$HOME/.claude/skills/welcome"'))).toBe(true);
  });

  it('supports dry-run without executing takeover commands', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime: TransportRuntime = {
      calls,
      async exec(file, args) {
        calls.push({ file, args });
        return { stdout: 'directory', stderr: '' };
      }
    };

    await takeOverRemoteSkill(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '~/.claude/skills'
        }
      },
      'welcome',
      { runtime, dryRun: true }
    );

    expect(calls.some((call) => call.file === 'ssh' && (call.args.at(-1) ?? '').includes('rm -rf'))).toBe(false);
  });
});

describe('deleteRemoteSkills', () => {
  it('deletes specified skills from remote', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    };

    await deleteRemoteSkills(mockServer, ['skill-a', 'skill-b'], runtime);

    const rmCalls = runtime.calls?.filter(c =>
      c.args.some(a => a === 'rm')
    ) ?? [];
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0].args.join(' ')).toContain('skill-a');
    expect(rmCalls[0].args.join(' ')).toContain('skill-b');
  });

  it('does nothing when skill list is empty', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    };

    await deleteRemoteSkills(mockServer, [], runtime);
    expect(runtime.calls?.length).toBe(0);
  });

  it('throws on invalid skill names', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    };

    await expect(deleteRemoteSkills(mockServer, ['valid', '; rm -rf /'], runtime))
      .rejects.toThrow('Invalid skill name');

    await expect(deleteRemoteSkills(mockServer, ['$(whoami)'], runtime))
      .rejects.toThrow('Invalid skill name');

    // Verify no SSH calls were made
    expect(runtime.calls?.length).toBe(0);
  });
});
