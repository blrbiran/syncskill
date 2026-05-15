import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, saveConfig, getSyncPaths } from '../../src/config/config.js';
import { createProgram } from '../../src/index.js';
import { materializeSource, updateSource } from '../../src/source.js';
import { getSourceHistory, recordHttpOverwrite } from '../../src/core/update-history.js';

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

describe('source restore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('restores git source to dirty state by checking out before commit and applying stash', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-restore-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    const skillsDir = join(workRepoDir, 'skills');
    await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v1\n');
    await commitAll(workRepoDir, 'initial');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    const config = createDefaultConfig(homeDir, {});
    config.sources['git-source'] = { type: 'git', url: bareRepoDir, path: 'skills' };
    await saveConfig(config, homeDir);
    await materializeSource(homeDir, 'git-source', config.sources['git-source']);

    const { syncDir } = getSyncPaths(homeDir);
    const checkoutDir = join(syncDir, '.sources', 'git-source', 'checkout');
    const checkoutSkillFile = join(checkoutDir, 'skills', 'my-skill', 'SKILL.md');
    await writeFile(checkoutSkillFile, '# My Skill v1 - LOCAL CHANGES\n');

    await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v2\n');
    await commitAll(workRepoDir, 'update');
    await git(['push', 'origin', 'main'], workRepoDir);

    await updateSource(homeDir, 'git-source', { force: true });

    vi.doMock('@inquirer/prompts', () => ({
      select: vi.fn(async () => 'restore-dirty-state')
    }));

    const historyBeforeRestore = await getSourceHistory(homeDir, 'git-source');
    const beforeCommit = historyBeforeRestore && historyBeforeRestore.type === 'git'
      ? historyBeforeRestore.before_commit
      : '';

    const { restoreSource } = await import('../../src/source-restore.js');
    const result = await restoreSource(homeDir, 'git-source');

    expect(result).toEqual({
      success: true,
      message: 'Restored git source "git-source" to dirty state.'
    });

    const restoredContent = await readFile(checkoutSkillFile, 'utf8');
    expect(restoredContent).toContain('LOCAL CHANGES');
    const { stdout: head } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);
    expect(head.trim()).toBe(beforeCommit);
    const stashList = await execFileAsync('git', ['-C', checkoutDir, 'stash', 'list']);
    expect(stashList.stdout).not.toContain(beforeCommit);
    expect(await getSourceHistory(homeDir, 'git-source')).toBeNull();
  });

  it('restores HTTP source backup by copying files back', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-restore-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    const { syncDir, skillsDir, backupsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'skill-pack'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-pack', 'SKILL.md'), '# Current\n');

    const backupDir = join(backupsDir, 'skill-pack');
    await mkdir(join(backupDir, 'skill-pack'), { recursive: true });
    await writeFile(join(backupDir, 'skill-pack', 'SKILL.md'), '# Backup\n');
    await recordHttpOverwrite(homeDir, 'skill-pack', {
      type: 'http',
      backup_path: backupDir,
      dirty_skills: ['skill-pack'],
      timestamp: new Date().toISOString()
    });

    vi.doMock('@inquirer/prompts', () => ({
      select: vi.fn(async () => 'restore-backup')
    }));

    const { restoreSource } = await import('../../src/source-restore.js');
    const result = await restoreSource(homeDir, 'skill-pack');

    expect(result).toEqual({
      success: true,
      message: 'Restored HTTP source "skill-pack" from backup.'
    });
    await expect(access(join(skillsDir, 'skill-pack', 'SKILL.md'))).resolves.toBeUndefined();
    expect(await readFile(join(skillsDir, 'skill-pack', 'SKILL.md'), 'utf8')).toBe('# Backup\n');
    expect(await getSourceHistory(homeDir, 'skill-pack')).toBeNull();
    void syncDir;
  });

  it('prints no-history message when restore metadata is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-restore-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code ?? ''}`);
    }) as never);

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'restore', 'unknown'], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    expect(logSpy).toHaveBeenCalledWith('No restore history for "unknown".');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
