// tests/end2end/cases/source/source-update-http.test.ts
/**
 * E2E tests for HTTP source update behavior.
 *
 * Scenario 3: Update command for HTTP sources should:
 * - Download to temp directory first
 * - Verify skills exist before replacing
 * - Only then remove old and move new
 * - Handle URL expiration gracefully
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('source update http', () => {
  e2eTest('update skips local archive without url', async () => {
    // Scenario 3: Local archives without URL cannot be updated
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('local-only.zip', {
        skills: ['local-skill'],
        format: 'zip',
      })
      .setup();

    try {
      // Install from local archive
      const archivePath = ctx.getArchivePath('local-only.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify source type is 'local'
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; url?: string; path?: string }>;
      };
      const source = config.sources?.['local-only'];
      expect(source?.type).toBe('local');
      // Local sources have path, not url
      expect(source?.path).toBeDefined();

      // Update should skip this source (no URL to update from)
      const updateResult = await ctx.run('syncskill', 'update', '--all', '-y');
      expect(updateResult.success).toBe(true);

      // Skill should still exist (not broken by update)
      await ctx.assertFileExists('.syncskill/.sources/local-only/checkout/local-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update reports which sources will be updated', async () => {
    // Scenario 3.3: Update should first report what will be updated
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('git-repo', {
        skills: ['git-skill'],
        skillContents: { 'git-skill': '# Git Skill\n' },
      })
      .withArchive('local-archive.zip', {
        skills: ['local-skill'],
        format: 'zip',
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('git-repo');

      // Setup git source manually
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'git-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Install local archive
      const archivePath = ctx.getArchivePath('local-archive.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Update config with git source
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        ...((config.sources as Record<string, unknown>) ?? {}),
        'git-repo': { type: 'git', url: gitUrl, path: '.' },
      };
      await ctx.writeConfig(config);

      // Run update --all with dry-run or check output
      const updateResult = await ctx.run('syncskill', 'update', '--all', '-y');

      // Should mention git-repo being updated
      const output = updateResult.stdout + updateResult.stderr;
      expect(output).toMatch(/git-repo/i);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest.skip('update reports skills removed from source', async () => {
    // TODO: Update should report when skills are removed from upstream
    // Currently update doesn't report skill removal
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('shrinking-repo', {
        skills: ['keep-skill', 'remove-skill'],
        skillContents: {
          'keep-skill': '# Keep Skill\n',
          'remove-skill': '# Remove Skill\n',
        },
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('shrinking-repo');
      const workDir = ctx.getGitSourceWorkDir('shrinking-repo');

      // Setup git source
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'shrinking-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Setup config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'shrinking-repo': { type: 'git', url: gitUrl, path: '.' },
      };
      config.links = {
        'keep-skill': ['*'],
        'remove-skill': ['*'],
      };
      await ctx.writeConfig(config);

      // Write state file
      const stateFile = join(ctx.syncskillDir, '.sources', 'shrinking-repo', 'state.json');
      await writeFile(stateFile, JSON.stringify({
        materialized_skills: ['keep-skill', 'remove-skill'],
        updated_at: new Date().toISOString(),
      }), 'utf8');

      // Remove skill from upstream
      const { removeSkillFromGitRepo } = await import('../../framework/index.js');
      await removeSkillFromGitRepo(workDir, 'remove-skill');

      // Update should notify about removed skill
      const updateResult = await ctx.run('syncskill', 'update', 'shrinking-repo', '-y');
      expect(updateResult.success).toBe(true);

      // Should mention removed skill
      const output = updateResult.stdout + updateResult.stderr;
      expect(output.toLowerCase()).toMatch(/remove|missing|gone/i);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('update alias', () => {
  e2eTest('syncskill update is available as a top-level command', async () => {
    // Scenario 3.2: update should be top-level command
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const updateHelp = await ctx.run('syncskill', 'update', '--help');
      const sourceHelp = await ctx.run('syncskill', 'source', '--help');

      expect(updateHelp.success).toBe(true);
      expect(sourceHelp.success).toBe(true);
      expect(updateHelp.stdout).toMatch(/update/i);
      expect(sourceHelp.stdout).not.toContain('update [name]');
    } finally {
      await ctx.cleanup();
    }
  });
});
