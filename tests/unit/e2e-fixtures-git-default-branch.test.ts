import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Issue 410: the bare fixture repo must not inherit the machine's `init.defaultBranch`. Forcing
// `master` here reproduces the machines where a fixture that pushes `main` cloned back empty.
const execFileAsync = promisify(execFile);
const saved: Record<string, string | undefined> = {};

describe('E2E Git Fixture with init.defaultBranch=master', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      saved[key] = process.env[key];
    }
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'init.defaultBranch';
    process.env.GIT_CONFIG_VALUE_0 = 'master';
  });

  afterEach(async () => {
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a clone of the fixture sees the skills pushed to main', async () => {
    const { createGitSourceFixture } = await import('../end2end/framework/fixtures/git.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-master-'));
    tempDirs.push(tempDir);

    const { bareRepoUrl } = await createGitSourceFixture(tempDir, 'my-repo', {
      skills: ['skill-a'],
      branch: 'main',
    });

    const cloneDir = join(tempDir, 'clone');
    await execFileAsync('git', ['clone', bareRepoUrl, cloneDir]);
    const skillA = await stat(join(cloneDir, 'skill-a', 'SKILL.md'));
    expect(skillA.isFile()).toBe(true);
  });
});