import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, saveConfig } from '../../src/config/config.js';
import { createProgram } from '../../src/index.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', cwd === undefined ? args : ['-C', cwd, ...args]);
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await git(['add', '.'], repoDir);
  await git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', message], repoDir);
}

async function createGitSourceFixture(homeDir: string): Promise<{ bareRepoDir: string; workRepoDir: string }> {
  const bareRepoDir = join(homeDir, 'remote.git');
  const workRepoDir = join(homeDir, 'work');

  await git(['init', '--bare', bareRepoDir]);
  await git(['clone', bareRepoDir, workRepoDir]);
  await git(['branch', '-M', 'main'], workRepoDir);

  return { bareRepoDir, workRepoDir };
}

describe('update --dry-run', () => {
  let homeDir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('previews updates without modifying files and prints dry-run output', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-dry-run-'));

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const config = createDefaultConfig(homeDir, {});
    config.sources.team = { type: 'git', url: bareRepoDir, path: 'skills', branch: 'main' };
    await saveConfig(config, homeDir);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'update', 'team'], { from: 'node' });

    const skillPath = join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md');
    const checkoutPath = join(homeDir, '.syncskill', '.sources', 'team', 'checkout', 'skills', 'alpha', 'SKILL.md');

    await writeFile(checkoutPath, '# alpha local edit\n', 'utf8');
    await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'update', '--all', '--dry-run'], { from: 'node' });

    expect(await readFile(skillPath, 'utf8')).toBe('# alpha v1\n');
    expect(await readFile(checkoutPath, 'utf8')).toBe('# alpha local edit\n');

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('[dry-run] Updatable sources:');
    expect(output).toContain('[dry-run] Dirty sources:');
    expect(output).toContain('team');
    expect(output).toContain('alpha');
    expect(output).toContain('--force');
  });
});
