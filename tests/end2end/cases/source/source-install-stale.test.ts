// tests/end2end/cases/source/source-install-stale.test.ts
/**
 * E2E tests for install when stale checkout exists.
 *
 * Scenario 5: config.yaml has no source entry, but ~/.syncskill/sources/
 * already contains a git checkout. Re-running install should handle this
 * gracefully instead of failing with git clone error.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('install with stale checkout', () => {
  e2eTest.skip('install handles pre-existing git checkout not in config', async () => {
    // TODO: Scenario 5 - CLI should handle pre-existing checkout gracefully
    // Currently fails with git clone error when checkout already exists
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('stale-repo', {
        skills: ['stale-skill'],
        skillContents: { 'stale-skill': '# Stale Skill\n' },
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('stale-repo');

      // Pre-create the sources directory with a git checkout
      // This simulates a previous install that was partially cleaned up
      const sourcesDir = join(ctx.syncskillDir, '.sources', 'stale-repo');
      const checkoutDir = join(sourcesDir, 'checkout');
      await mkdir(sourcesDir, { recursive: true });

      // Clone the repo to create a real git checkout
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Verify checkout exists
      await ctx.assertFileExists('.syncskill/.sources/stale-repo/checkout/stale-skill/SKILL.md');

      // Config does NOT have this source (it was removed or never added)
      const config = (await ctx.readConfig()) as { sources?: Record<string, unknown> };
      expect(config.sources?.['stale-repo']).toBeUndefined();

      // Now try to install the same repo - should not fail with git clone error
      // It should detect existing checkout and either reuse it or clean and re-clone
      const installResult = await ctx.run('syncskill', ['install', gitUrl, '-y'], {
        expectedExitCode: null, // Don't fail on error, we're testing the behavior
      });

      // Should succeed without git clone error
      expect(installResult.success).toBe(true);

      // Skill should be available
      await ctx.assertFileExists('.syncskill/.sources/stale-repo/checkout/stale-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest.skip('install cleans non-git directory before cloning', async () => {
    // TODO: CLI should clean non-git directory and clone fresh
    // Currently fails because git clone fails when directory exists
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('clean-repo', {
        skills: ['new-skill'],
        skillContents: { 'new-skill': '# New Skill\n' },
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('clean-repo');

      // Pre-create a non-git directory where the checkout would go
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'clean-repo', 'checkout');
      await mkdir(checkoutDir, { recursive: true });
      await writeFile(join(checkoutDir, 'garbage.txt'), 'This should be cleaned\n', 'utf8');

      // Verify garbage exists
      await ctx.assertFileExists('.syncskill/.sources/clean-repo/checkout/garbage.txt');

      // Install should clean and clone fresh
      const installResult = await ctx.run('syncskill', ['install', gitUrl, '-y'], {
        expectedExitCode: null,
      });

      expect(installResult.success).toBe(true);

      // Garbage should be gone
      await ctx.assertFileNotExists('.syncskill/.sources/clean-repo/checkout/garbage.txt');

      // New skill should be there
      await ctx.assertFileExists('.syncskill/.sources/clean-repo/checkout/new-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest.skip('install detects url mismatch and re-clones', async () => {
    // TODO: CLI should detect URL mismatch and re-clone
    // Currently fails because install doesn't check remote URL of existing checkout
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('correct-repo', {
        skills: ['correct-skill'],
        skillContents: { 'correct-skill': '# Correct Skill\n' },
      })
      .setup();

    try {
      const correctUrl = ctx.getGitSourceUrl('correct-repo');

      // Pre-create a git checkout with WRONG remote URL
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'correct-repo', 'checkout');
      await mkdir(checkoutDir, { recursive: true });
      await ctx.exec('git', ['init'], { cwd: checkoutDir });
      await ctx.exec('git', ['remote', 'add', 'origin', 'https://wrong.example.com/wrong.git'], {
        cwd: checkoutDir,
      });

      // Create a fake skill in the wrong checkout
      await mkdir(join(checkoutDir, 'wrong-skill'), { recursive: true });
      await writeFile(join(checkoutDir, 'wrong-skill', 'SKILL.md'), '# Wrong Skill\n', 'utf8');

      // Install the correct repo - should detect URL mismatch and re-clone
      const installResult = await ctx.run('syncskill', ['install', correctUrl, '-y'], {
        expectedExitCode: null,
      });

      expect(installResult.success).toBe(true);

      // Wrong skill should be gone
      await ctx.assertFileNotExists('.syncskill/.sources/correct-repo/checkout/wrong-skill/SKILL.md');

      // Correct skill should be there
      await ctx.assertFileExists('.syncskill/.sources/correct-repo/checkout/correct-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });
});
