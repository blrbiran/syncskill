import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'index.js');

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(homeDir: string, args: string[]): Promise<CliRun> {
  try {
    const result = await execFileAsync('node', [cliPath, ...args], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '', code: execError.code ?? 1 };
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', cwd === undefined ? args : ['-C', cwd, ...args]);
  return stdout;
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

describe('source resolved commit', () => {
  const tempDirs = useTempDirs();

  it('records the checkout HEAD after install and follows it after update', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-commit-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
      version: 1, agents: { claude: agentDir }, links: {}, servers: {}, sources: {}
    }));
    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v1');
    await commitAll(workRepoDir, 'v1');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const install = await runCli(homeDir, ['install', bareRepoDir, '--name', 'demo', '--type', 'git', '--path', 'skills', '--yes']);
    expect(install.code).toBe(0);
    const head1 = (await git(['rev-parse', 'HEAD'], workRepoDir)).trim();
    const state1 = JSON.parse(await readFile(join(homeDir, '.syncskill', '.sources', 'demo', 'state.json'), 'utf8'));
    expect(state1.resolved_commit).toBe(head1);

    await writeFile(join(workRepoDir, 'skills', 'alpha', 'SKILL.md'), '# alpha v2');
    await commitAll(workRepoDir, 'v2');
    await git(['push'], workRepoDir);
    const update = await runCli(homeDir, ['update', 'demo', '--yes']);
    expect(update.code).toBe(0);
    const head2 = (await git(['rev-parse', 'HEAD'], workRepoDir)).trim();
    expect(head2).not.toBe(head1);
    const state2 = JSON.parse(await readFile(join(homeDir, '.syncskill', '.sources', 'demo', 'state.json'), 'utf8'));
    expect(state2.resolved_commit).toBe(head2);
  });
});
