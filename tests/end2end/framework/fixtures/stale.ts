import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    cwd === undefined ? args : ['-C', cwd, ...args]
  );
  return stdout;
}

/**
 * Create a stale git checkout with a mismatched remote URL.
 * Used to test that install detects and handles URL mismatch.
 */
export async function createStaleGitCheckout(
  parentDir: string,
  name: string,
  wrongRemoteUrl: string
): Promise<string> {
  const repoPath = join(parentDir, name);
  await mkdir(repoPath, { recursive: true });

  await git(['init'], repoPath);
  await git(['remote', 'add', 'origin', wrongRemoteUrl], repoPath);

  await writeFile(join(repoPath, 'stale.txt'), 'This is stale content\n', 'utf8');
  await git(['add', '.'], repoPath);
  await git(
    ['-c', 'user.name=Stale', '-c', 'user.email=stale@test.local', 'commit', '-m', 'Stale commit'],
    repoPath
  );

  return repoPath;
}

/**
 * Create a stale non-git directory.
 * Used to test that install detects and handles non-git directories.
 */
export async function createStaleNonGitDir(
  parentDir: string,
  name: string
): Promise<string> {
  const dirPath = join(parentDir, name);
  await mkdir(dirPath, { recursive: true });

  await writeFile(join(dirPath, 'stale.txt'), 'This is not a git repo\n', 'utf8');
  await mkdir(join(dirPath, 'some-skill'), { recursive: true });
  await writeFile(join(dirPath, 'some-skill', 'SKILL.md'), '# Stale Skill\n', 'utf8');

  return dirPath;
}
