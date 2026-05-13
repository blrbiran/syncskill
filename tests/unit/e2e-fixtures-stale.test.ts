import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaleGitCheckout, createStaleNonGitDir } from '../end2end/framework/fixtures/stale.js';

describe('stale fixtures', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('createStaleGitCheckout creates git repo with wrong remote', async () => {
    const parentDir = join(tmpdir(), `stale-test-${Date.now()}`);
    tempDirs.push(parentDir);
    await mkdir(parentDir, { recursive: true });

    const stalePath = await createStaleGitCheckout(parentDir, 'my-repo', 'https://wrong.url/repo.git');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('git', ['-C', stalePath, 'remote', 'get-url', 'origin']);
    expect(stdout.trim()).toBe('https://wrong.url/repo.git');
  });

  it('createStaleNonGitDir creates directory that is not a git repo', async () => {
    const parentDir = join(tmpdir(), `stale-test-${Date.now()}`);
    tempDirs.push(parentDir);
    await mkdir(parentDir, { recursive: true });

    const stalePath = await createStaleNonGitDir(parentDir, 'my-repo');

    const { access } = await import('node:fs/promises');
    await expect(access(stalePath)).resolves.toBeUndefined();

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    await expect(
      execFileAsync('git', ['-C', stalePath, 'rev-parse', '--git-dir'])
    ).rejects.toThrow();
  });
});
