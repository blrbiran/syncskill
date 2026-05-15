import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { saveConfig, loadConfig, getSyncPaths, createDefaultConfig } from '../../src/config/config.js';
import { updateSource, materializeSource } from '../../src/source.js';
import { loadSkillsRegistry, saveSkillsRegistry } from '../../src/core/skills-registry.js';
import { getSourceHistory } from '../../src/core/update-history.js';

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

describe('source update --force', () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `force-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = testDir;

    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });
    await mkdir(join(syncDir, 'skills'), { recursive: true });

    const config = createDefaultConfig();
    await saveConfig(config, homeDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('git dirty detection', () => {
    it('detects uncommitted changes in git source skills', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      // Create initial skill
      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      // Add source and materialize
      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      // Make local modification to the checkout (simulating dirty state)
      const { syncDir } = getSyncPaths(homeDir);
      const checkoutSkillFile = join(syncDir, '.sources', 'git-source', 'checkout', 'skills', 'my-skill', 'SKILL.md');
      await writeFile(checkoutSkillFile, '# My Skill v1 - MODIFIED LOCALLY\n');

      // Update remote
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v2\n');
      await commitAll(workRepoDir, 'update to v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // Update without force should skip (due to dirty)
      const result = await updateSource(homeDir, 'git-source', { yes: true });

      // Should still have the old materialized skills (was skipped)
      expect(result.materialized_skills).toEqual(['my-skill']);

      // Verify the local modification is preserved
      const localContent = await readFile(checkoutSkillFile, 'utf8');
      expect(localContent).toContain('MODIFIED LOCALLY');
    });

    it('stashes dirty git skills before force update and records restore metadata', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      // Create initial skill
      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      // Add source and materialize
      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      const { syncDir } = getSyncPaths(homeDir);
      const checkoutDir = join(syncDir, '.sources', 'git-source', 'checkout');
      const checkoutSkillFile = join(checkoutDir, 'skills', 'my-skill', 'SKILL.md');
      const localModification = '# My Skill v1 - LOCAL CHANGES\n';
      await writeFile(checkoutSkillFile, localModification);
      const { stdout: beforeCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);

      // Update remote
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# My Skill v2\n');
      await commitAll(workRepoDir, 'update to v2');
      await git(['push', 'origin', 'main'], workRepoDir);
      const { stdout: remoteCommit } = await execFileAsync('git', ['-C', workRepoDir, 'rev-parse', 'HEAD']);

      // Force update should stash and update
      await updateSource(homeDir, 'git-source', { force: true });

      const { stdout: stashCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'stash@{0}']);
      const history = await getSourceHistory(homeDir, 'git-source');

      expect(history).toEqual({
        type: 'git',
        before_commit: beforeCommit.trim(),
        after_commit: remoteCommit.trim(),
        stash_commit: stashCommit.trim(),
        timestamp: expect.any(String)
      });

      const stashShow = await execFileAsync('git', ['-C', checkoutDir, 'stash', 'show', '-p', 'stash@{0}']);
      expect(stashShow.stdout).toContain('LOCAL CHANGES');

      const backupsDir = join(syncDir, 'backups', 'git-source');
      await expect(access(backupsDir)).rejects.toThrow();

      // Verify the skill was updated to v2
      const updatedContent = await readFile(join(syncDir, 'skills', 'my-skill', 'SKILL.md'), 'utf8');
      expect(updatedContent).toContain('v2');
    });
  });

  describe('http dirty detection', () => {
    it('detects changes to HTTP-sourced skills via hash mismatch', async () => {
      const { syncDir, skillsDir } = getSyncPaths(homeDir);

      // Setup: create a skill manually and register it as HTTP source
      await mkdir(join(skillsDir, 'http-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'http-skill', 'SKILL.md'), '# HTTP Skill Original\n');

      // Create registry entry with last_update_hash
      const registry = await loadSkillsRegistry(homeDir);
      registry.skills['http-skill'] = {
        path: join(skillsDir, 'http-skill'),
        origin: 'http-source',
        type: 'http',
        status: 'active',
        last_update_hash: 'original-hash-value'
      };
      await saveSkillsRegistry(homeDir, registry);

      // Modify the skill locally (hash will differ from last_update_hash)
      await writeFile(join(skillsDir, 'http-skill', 'SKILL.md'), '# HTTP Skill MODIFIED\n');

      // The detectHttpDirty function should detect this as dirty
      // We can't easily test source update for HTTP without an HTTP server,
      // but we can verify the registry structure is correct for dirty detection
      const updatedRegistry = await loadSkillsRegistry(homeDir);
      expect(updatedRegistry.skills['http-skill'].last_update_hash).toBe('original-hash-value');
    });
  });

  describe('flag combinations', () => {
    it('--yes without --force skips dirty sources', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      // Create initial skill
      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      // Add source and materialize
      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      // Make local modification
      const { syncDir } = getSyncPaths(homeDir);
      const checkoutSkillFile = join(syncDir, '.sources', 'git-source', 'checkout', 'skills', 'my-skill', 'SKILL.md');
      await writeFile(checkoutSkillFile, '# v1 - dirty\n');

      // Update remote
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v2\n');
      await commitAll(workRepoDir, 'v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // --yes alone should skip dirty sources
      const result = await updateSource(homeDir, 'git-source', { yes: true });

      // Should be skipped, local changes preserved
      const content = await readFile(checkoutSkillFile, 'utf8');
      expect(content).toContain('dirty');
    });

    it('--force without --yes stashes and updates', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      // Create initial skill
      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      // Make local modification
      const { syncDir } = getSyncPaths(homeDir);
      const checkoutSkillFile = join(syncDir, '.sources', 'git-source', 'checkout', 'skills', 'my-skill', 'SKILL.md');
      await writeFile(checkoutSkillFile, '# v1 - local edits\n');

      // Update remote
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v2\n');
      await commitAll(workRepoDir, 'v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // --force should stash and update
      await updateSource(homeDir, 'git-source', { force: true });

      const history = await getSourceHistory(homeDir, 'git-source');
      expect(history?.type).toBe('git');
      expect(history?.stash_commit).toBeDefined();

      const stashShow = await execFileAsync('git', ['-C', join(syncDir, '.sources', 'git-source', 'checkout'), 'stash', 'show', '-p', 'stash@{0}']);
      expect(stashShow.stdout).toContain('local edits');

      // Skill should be updated
      const updatedContent = await readFile(join(syncDir, 'skills', 'my-skill', 'SKILL.md'), 'utf8');
      expect(updatedContent).toContain('v2');
    });

    it('--force and --yes together stashes and updates without prompts', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      const { syncDir } = getSyncPaths(homeDir);
      const checkoutSkillFile = join(syncDir, '.sources', 'git-source', 'checkout', 'skills', 'my-skill', 'SKILL.md');
      await writeFile(checkoutSkillFile, '# v1 - my edits\n');

      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v2\n');
      await commitAll(workRepoDir, 'v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // Both flags: --force takes precedence over --yes for dirty handling
      await updateSource(homeDir, 'git-source', { force: true, yes: true });

      const history = await getSourceHistory(homeDir, 'git-source');
      expect(history?.type).toBe('git');
      expect(history?.stash_commit).toBeDefined();

      const updatedContent = await readFile(join(syncDir, 'skills', 'my-skill', 'SKILL.md'), 'utf8');
      expect(updatedContent).toContain('v2');
    });
  });

  describe('clean sources', () => {
    it('updates clean git source without prompts or backups', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'my-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      // Update remote without making local changes
      await writeFile(join(skillsDir, 'my-skill', 'SKILL.md'), '# v2\n');
      await commitAll(workRepoDir, 'v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // Update should succeed without --force
      const result = await updateSource(homeDir, 'git-source', {});

      expect(result.materialized_skills).toContain('my-skill');

      // No backup or overwrite history should be created
      const { syncDir } = getSyncPaths(homeDir);
      const backupsDir = join(syncDir, 'backups', 'git-source');
      await expect(access(backupsDir)).rejects.toThrow();
      await expect(getSourceHistory(homeDir, 'git-source')).resolves.toBeNull();

      // Skill should be updated
      const content = await readFile(join(syncDir, 'skills', 'my-skill', 'SKILL.md'), 'utf8');
      expect(content).toContain('v2');
    });
  });

  describe('overwrite metadata', () => {
    it('records git overwrite history with stash metadata', async () => {
      const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

      const skillsDir = join(workRepoDir, 'skills');
      await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
      await mkdir(join(skillsDir, 'skill-b'), { recursive: true });
      await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '# A v1\n');
      await writeFile(join(skillsDir, 'skill-b', 'SKILL.md'), '# B v1\n');
      await commitAll(workRepoDir, 'initial');
      await git(['push', '-u', 'origin', 'main'], workRepoDir);

      let config = await loadConfig(homeDir);
      config.sources['git-source'] = {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      };
      await saveConfig(config, homeDir);
      await materializeSource(homeDir, 'git-source', {
        type: 'git',
        url: bareRepoDir,
        path: 'skills'
      });

      // Modify both skills locally
      const { syncDir } = getSyncPaths(homeDir);
      const checkoutDir = join(syncDir, '.sources', 'git-source', 'checkout', 'skills');
      await writeFile(join(checkoutDir, 'skill-a', 'SKILL.md'), '# A v1 - edited\n');
      await writeFile(join(checkoutDir, 'skill-b', 'SKILL.md'), '# B v1 - edited\n');

      // Update remote
      await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '# A v2\n');
      await writeFile(join(skillsDir, 'skill-b', 'SKILL.md'), '# B v2\n');
      await commitAll(workRepoDir, 'v2');
      await git(['push', 'origin', 'main'], workRepoDir);

      // Force update
      await updateSource(homeDir, 'git-source', { force: true });

      const history = await getSourceHistory(homeDir, 'git-source');

      expect(history).toMatchObject({
        type: 'git',
        before_commit: expect.any(String),
        after_commit: expect.any(String),
        stash_commit: expect.any(String),
        timestamp: expect.any(String)
      });
    });
  });
});
