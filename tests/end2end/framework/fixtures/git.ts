// tests/end2end/framework/fixtures/git.ts
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createSkillDir } from './skill.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    cwd === undefined ? args : ['-C', cwd, ...args]
  );
  return stdout;
}

async function gitCommit(repoDir: string, message: string): Promise<void> {
  await git(['add', '.'], repoDir);
  await git(
    [
      '-c', 'user.name=E2E Test',
      '-c', 'user.email=e2e@test.local',
      'commit', '-m', message,
    ],
    repoDir
  );
}

/**
 * Create a bare git repository.
 */
export async function createGitBareRepo(
  parentDir: string,
  name: string
): Promise<string> {
  const bareRepoPath = join(parentDir, `${name}.git`);
  await git(['init', '--bare', bareRepoPath]);
  return bareRepoPath;
}

export interface GitSourceConfig {
  skills: string[];
  branch?: string;
  skillContents?: Record<string, string>;
}

export interface GitSourceFixture {
  bareRepoUrl: string;
  workDir: string;
}

/**
 * Create a git source fixture with skills.
 */
export async function createGitSourceFixture(
  parentDir: string,
  name: string,
  config: GitSourceConfig
): Promise<GitSourceFixture> {
  const branch = config.branch ?? 'main';
  const bareRepoPath = await createGitBareRepo(parentDir, name);
  const workDir = join(parentDir, `${name}-work`);

  // Clone, add skills, push
  await git(['clone', bareRepoPath, workDir]);
  await git(['checkout', '-b', branch], workDir);

  // Create skills
  for (const skillName of config.skills) {
    await createSkillDir(workDir, skillName, config.skillContents?.[skillName]);
  }

  // Commit and push
  await gitCommit(workDir, 'Initial commit with skills');
  await git(['push', '-u', 'origin', branch], workDir);

  return {
    bareRepoUrl: bareRepoPath,
    workDir,
  };
}

/**
 * Add a new skill to an existing git repo and push.
 */
export async function addSkillToGitRepo(
  workDir: string,
  skillName: string,
  content?: string
): Promise<void> {
  await createSkillDir(workDir, skillName, content);
  await gitCommit(workDir, `Add skill: ${skillName}`);
  await git(['push'], workDir);
}

/**
 * Modify a skill in an existing git repo and push.
 */
export async function modifySkillInGitRepo(
  workDir: string,
  skillName: string,
  newContent: string
): Promise<void> {
  await writeFile(join(workDir, skillName, 'SKILL.md'), newContent, 'utf8');
  await gitCommit(workDir, `Modify skill: ${skillName}`);
  await git(['push'], workDir);
}

/**
 * Remove a skill from an existing git repo and push.
 */
export async function removeSkillFromGitRepo(
  workDir: string,
  skillName: string
): Promise<void> {
  await rm(join(workDir, skillName), { recursive: true, force: true });
  await gitCommit(workDir, `Remove skill: ${skillName}`);
  await git(['push'], workDir);
}
