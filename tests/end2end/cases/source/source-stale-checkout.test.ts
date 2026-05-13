// tests/end2end/cases/source/source-stale-checkout.test.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('stale checkout handling', () => {
  e2eTest('install handles stale checkout with url mismatch', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('correct-repo', {
        skills: ['my-skill'],
        skillContents: { 'my-skill': '# Correct Skill Content' },
      })
      .setup();

    try {
      const correctUrl = ctx.getGitSourceUrl('correct-repo');

      // Create a stale git checkout with wrong URL in the .sources directory
      // The CLI uses .syncskill/.sources/<name>/checkout structure
      const sourcesDir = join(ctx.syncskillDir, '.sources', 'correct-repo');
      const checkoutDir = join(sourcesDir, 'checkout');
      await mkdir(checkoutDir, { recursive: true });

      // Initialize as git repo with wrong remote
      await ctx.exec('git', ['init'], { cwd: checkoutDir });
      await ctx.exec('git', ['remote', 'add', 'origin', 'https://wrong.example.com/other.git'], { cwd: checkoutDir });

      // Add stale content
      await writeFile(join(checkoutDir, 'stale.txt'), 'This is stale content\n', 'utf8');
      await ctx.exec('git', ['add', '.'], { cwd: checkoutDir });
      await ctx.exec('git', ['-c', 'user.name=Stale', '-c', 'user.email=stale@test.local', 'commit', '-m', 'Stale commit'], { cwd: checkoutDir });

      // Verify stale directory exists with stale content
      await ctx.assertFileExists('.syncskill/.sources/correct-repo/checkout/stale.txt');
      const staleContent = await ctx.readFile('.syncskill/.sources/correct-repo/checkout/stale.txt');
      expect(staleContent).toContain('stale');

      // Update config to simulate a source that should be installed
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'correct-repo': {
          type: 'git',
          url: correctUrl,
          path: '.',
        },
      };
      config.links = { 'my-skill': ['*'] };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Run source update to trigger stale detection and re-clone
      const updateResult = await ctx.run('syncskill', 'update', 'correct-repo', '-y');
      expect(updateResult.success).toBe(true);

      // Verify stale content is gone and correct skill is installed
      await ctx.assertFileNotExists('.syncskill/.sources/correct-repo/checkout/stale.txt');
      await ctx.assertFileExists('.syncskill/.sources/correct-repo/checkout/my-skill/SKILL.md');

      const skillContent = await ctx.readFile('.syncskill/.sources/correct-repo/checkout/my-skill/SKILL.md');
      expect(skillContent).toBe('# Correct Skill Content');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('install handles stale checkout non-git dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('new-repo', {
        skills: ['fresh-skill'],
        skillContents: { 'fresh-skill': '# Fresh Skill Content' },
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('new-repo');

      // Create a stale non-git directory in the .sources location
      // The CLI uses .syncskill/.sources/<name>/checkout structure
      const sourcesDir = join(ctx.syncskillDir, '.sources', 'new-repo');
      const checkoutDir = join(sourcesDir, 'checkout');
      await mkdir(checkoutDir, { recursive: true });

      // Add stale content (NOT a git repo)
      await writeFile(join(checkoutDir, 'stale-file.txt'), 'This is not a git repo\n', 'utf8');
      await mkdir(join(checkoutDir, 'old-skill'), { recursive: true });
      await writeFile(join(checkoutDir, 'old-skill', 'SKILL.md'), '# Old Stale Skill\n', 'utf8');

      // Verify stale directory exists
      await ctx.assertFileExists('.syncskill/.sources/new-repo/checkout/stale-file.txt');
      await ctx.assertFileExists('.syncskill/.sources/new-repo/checkout/old-skill/SKILL.md');

      // Update config to simulate a source that should be installed
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'new-repo': {
          type: 'git',
          url: gitUrl,
          path: '.',
        },
      };
      config.links = { 'fresh-skill': ['*'] };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Run source update to trigger stale detection and cleanup
      const updateResult = await ctx.run('syncskill', 'update', 'new-repo', '-y');
      expect(updateResult.success).toBe(true);

      // Verify stale content is gone and new skill is installed
      await ctx.assertFileNotExists('.syncskill/.sources/new-repo/checkout/stale-file.txt');
      await ctx.assertFileNotExists('.syncskill/.sources/new-repo/checkout/old-skill/SKILL.md');
      await ctx.assertFileExists('.syncskill/.sources/new-repo/checkout/fresh-skill/SKILL.md');

      const skillContent = await ctx.readFile('.syncskill/.sources/new-repo/checkout/fresh-skill/SKILL.md');
      expect(skillContent).toBe('# Fresh Skill Content');
    } finally {
      await ctx.cleanup();
    }
  });
});
