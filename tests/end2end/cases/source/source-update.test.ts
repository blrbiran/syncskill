// tests/end2end/cases/source/source-update.test.ts
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario, modifySkillInGitRepo } from '../../framework/index.js';

describe('source update', () => {
  e2eTest('update git source fetches and resets', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('test-source', {
        skills: ['my-skill'],
        skillContents: { 'my-skill': '# Version 1' },
      })
      .setup();

    try {
      // Manually set up the git source (CLI requires GitHub URLs, so we simulate state)
      const gitUrl = ctx.getGitSourceUrl('test-source');

      // Clone the bare repo to the expected checkout location
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'test-source', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Create symlink in skills dir
      const skillsDir = join(ctx.syncskillDir, 'skills');
      await symlink(join(checkoutDir, 'my-skill'), join(skillsDir, 'my-skill'));

      // Update config to include the source
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'test-source': {
          type: 'git',
          url: gitUrl,
          path: '.',
        },
      };
      config.links = { 'my-skill': ['*'] };
      await ctx.writeConfig(config);

      // Write registry
      await ctx.writeRegistry({
        skills: {
          'my-skill': {
            path: join(checkoutDir, 'my-skill'),
            origin: 'test-source',
            type: 'git',
            status: 'active',
          },
        },
      });

      // Verify initial content
      const initialContent = await ctx.readFile('.syncskill/.sources/test-source/checkout/my-skill/SKILL.md');
      expect(initialContent).toBe('# Version 1');

      // Modify skill in bare repo to Version 2
      const workDir = ctx.getGitSourceWorkDir('test-source');
      await modifySkillInGitRepo(workDir, 'my-skill', '# Version 2');

      // Run update command
      const updateResult = await ctx.run('syncskill', 'update', 'test-source', '-y');
      expect(updateResult.success).toBe(true);

      // Verify content updated to Version 2
      const updatedContent = await ctx.readFile('.syncskill/.sources/test-source/checkout/my-skill/SKILL.md');
      expect(updatedContent).toBe('# Version 2');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update skips local and archive sources', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('local-skills.zip', {
        skills: ['archive-skill'],
        format: 'zip',
      })
      .setup();

    try {
      // Install local archive source
      const archivePath = ctx.getArchivePath('local-skills.zip');
      const installResult = await ctx.run('syncskill', 'install', archivePath, '-y');
      expect(installResult.success).toBe(true);

      // Verify source type is 'local' in config
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string }>;
      };
      const source = config.sources?.['local-skills'];
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');

      // Run update --all - should succeed (not error) but skip local sources
      const updateResult = await ctx.run('syncskill', 'update', '--all', '-y');
      expect(updateResult.success).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update is available as a top-level command', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const updateHelp = await ctx.run('syncskill', 'update', '--help');
      const sourceHelp = await ctx.run('syncskill', 'source', '--help');

      expect(updateHelp.success).toBe(true);
      expect(sourceHelp.success).toBe(true);
      expect(updateHelp.stdout).toContain('update');
      expect(sourceHelp.stdout).not.toContain('update [name]');
    } finally {
      await ctx.cleanup();
    }
  });
});
