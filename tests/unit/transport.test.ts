import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { deleteRemoteSkills, listRemoteSkills, receiverNeedsUpdate, takeOverRemoteSkill, type TransportRuntime } from '../../src/core/transport.js';

const receiverPath = new URL('../../src/receiver/sync_receiver.mjs', import.meta.url).pathname;

/** Issue 408: ssh now carries `-o` options; the keys here name the remote command. */
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

function createRuntime(stdoutByCommand: Record<string, string> = {}, errorByCommand: Record<string, Error> = {}): TransportRuntime {
  return {
    async exec(file, args) {
      const key = lookupKey(file, args);

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
      { 'ssh testuser@example.com md5sum "$HOME/.syncskill/sync_receiver.mjs"': new Error('md5sum: file not found') }
    );

    const result = await receiverNeedsUpdate(testServer, runtime);

    expect(result).toBe(true);
  });

  it('returns true when hash differs', async () => {
    const runtime = createRuntime({
      'ssh testuser@example.com md5sum "$HOME/.syncskill/sync_receiver.mjs"': 'differenthash123456789012  ~/.syncskill/sync_receiver.mjs'
    });

    const result = await receiverNeedsUpdate(testServer, runtime);

    expect(result).toBe(true);
  });

  it('returns false when hash matches', async () => {
    // Compute actual hash from local file
    const localContent = await readFile(receiverPath, 'utf8');
    const localHash = createHash('md5').update(localContent).digest('hex');

    const runtime = createRuntime({
      'ssh testuser@example.com md5sum "$HOME/.syncskill/sync_receiver.mjs"': `${localHash}  ~/.syncskill/sync_receiver.mjs`
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

  it('returns empty array only when the remote says the directory does not exist', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          throw new Error('ssh exited with code 2: ls: /home/u/.syncskill/skills: No such file or directory');
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await listRemoteSkills(mockServer, runtime);
    expect(result).toEqual([]);
  });

  // Tester #456: `catch { return [] }` turned an unreachable remote into "the remote is empty", so a
  // dry run and a destructive push both reported `deleted_skills: []` with exit 0.
  it('propagates a transport failure instead of reporting an empty remote', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          throw new Error('ssh exited with code 255: Host key verification failed.');
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(listRemoteSkills(mockServer, runtime)).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it('propagates when ssh itself cannot be spawned', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec() {
        throw Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' });
      }
    };

    await expect(listRemoteSkills(mockServer, runtime)).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it('propagates a permission failure, which is not "the directory does not exist"', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          throw new Error("ssh exited with code 2: ls: cannot open directory '/home/u/.syncskill/skills': Permission denied");
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(listRemoteSkills(mockServer, runtime)).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it('reads an ssh failure as transport even when its stderr also says "No such file"', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a === 'ls')) {
          throw new Error("ssh exited with code 255: Warning: Identity file /home/u/.ssh/gone.pem not accessible: No such file or directory");
        }
        return { stdout: '', stderr: '' };
      }
    };

    // mutation: drop the `!isTransportFailure(...)` guard -> this is misread as an absent directory and resolved [], red
    await expect(listRemoteSkills(mockServer, runtime)).rejects.toThrow('E_REMOTE_TRANSPORT');
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
    const takeover = calls.find((call) => call.file === 'ssh' && call.args.at(-1)?.includes('ln -s'));
    expect(takeover).toBeDefined();
    // Capture the -c operand after the remote shell parses it, without running the replacement.
    const parsed = spawnSync('/bin/sh', ['-c', `sh() { printf '%s' "$2"; }; ln() { :; }; ${takeover!.args.slice(-3).join(' ')}`], { encoding: 'utf8' });
    expect(parsed.stdout).toBe('rm -rf "$HOME/.claude/skills/welcome" && ln -s "$HOME/.syncskill/skills/welcome" "$HOME/.claude/skills/welcome"');
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
