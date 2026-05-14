import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { listRemoteSkills, receiverNeedsUpdate, type TransportRuntime } from '../../src/core/transport.js';

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
