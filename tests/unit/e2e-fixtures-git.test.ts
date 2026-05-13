// tests/unit/e2e-fixtures-git.test.ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('E2E Git Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createGitBareRepo creates a bare git repository', async () => {
    const { createGitBareRepo } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const bareRepoPath = await createGitBareRepo(tempDir, 'test-repo');

    const stats = await stat(bareRepoPath);
    expect(stats.isDirectory()).toBe(true);
    expect(bareRepoPath).toContain('test-repo.git');
  });

  it('createGitSourceFixture creates bare repo with skills', async () => {
    const { createGitSourceFixture } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const { bareRepoUrl, workDir } = await createGitSourceFixture(tempDir, 'my-repo', {
      skills: ['skill-a', 'skill-b'],
      branch: 'main',
    });

    expect(bareRepoUrl).toContain('my-repo.git');

    // Clone and verify skills exist
    const cloneDir = join(tempDir, 'clone');
    await execFileAsync('git', ['clone', bareRepoUrl, cloneDir]);

    const skillA = await stat(join(cloneDir, 'skill-a', 'SKILL.md'));
    expect(skillA.isFile()).toBe(true);

    const skillB = await stat(join(cloneDir, 'skill-b', 'SKILL.md'));
    expect(skillB.isFile()).toBe(true);
  });

  it('addSkillToGitRepo adds a new skill and pushes', async () => {
    const { createGitSourceFixture, addSkillToGitRepo } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const { bareRepoUrl, workDir } = await createGitSourceFixture(tempDir, 'repo', {
      skills: ['existing'],
    });

    await addSkillToGitRepo(workDir, 'new-skill', '# New Skill\n');

    // Clone and verify new skill exists
    const cloneDir = join(tempDir, 'verify');
    await execFileAsync('git', ['clone', bareRepoUrl, cloneDir]);

    const content = await readFile(join(cloneDir, 'new-skill', 'SKILL.md'), 'utf8');
    expect(content).toBe('# New Skill\n');
  });
});
