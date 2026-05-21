// tests/end2end/cases/install/install-local-archive.test.ts
/**
 * E2E tests for installing local archive files (.zip, .tar.gz).
 *
 * Scenario 1: Local archive files should be treated equivalently to
 * HTTP-downloaded archives. This enables offline installation and
 * avoids issues with complex URL parameters.
 */
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('install local archive', () => {
  e2eTest('install local zip extracts to sources dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('my-skills.zip', {
        skills: ['skill-alpha', 'skill-beta'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('my-skills.zip');
      const result = await ctx.run('syncskill', 'install', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify skills are extracted to .sources directory
      await ctx.assertFileExists('.syncskill/.sources/my-skills/checkout/skill-alpha/SKILL.md');
      await ctx.assertFileExists('.syncskill/.sources/my-skills/checkout/skill-beta/SKILL.md');

      // Verify config has source entry
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; path?: string }>;
      };
      const source = config.sources?.['my-skills'];
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('install local tar.gz extracts correctly', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('tarball-skills.tar.gz', {
        skills: ['tar-skill'],
        format: 'tar.gz',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('tarball-skills.tar.gz');
      const result = await ctx.run('syncskill', 'install', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify skill extracted
      await ctx.assertFileExists('.syncskill/.sources/tarball-skills/checkout/tar-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('install archive with complex filename works', async () => {
    // Simulates downloading archive with URL parameters stripped
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('downloaded-package.zip', {
        skills: ['downloaded-skill'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('downloaded-package.zip');
      const result = await ctx.run('syncskill', 'install', archivePath, '-y');

      expect(result.success).toBe(true);

      // Should work regardless of filename complexity
      await ctx.assertFileExists('.syncskill/.sources/downloaded-package/checkout/downloaded-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('install archive records source config correctly', async () => {
    // Local archives are stored as local source type
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('local-only.zip', {
        skills: ['local-skill'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('local-only.zip');
      const result = await ctx.run('syncskill', 'install', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify config has source entry
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; path?: string }>;
      };
      const source = config.sources?.['local-only'];
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
      // Source should have path field
      expect(source?.path).toBeDefined();

      // Skills should be extracted to .sources directory
      await ctx.assertFileExists('.syncskill/.sources/local-only/checkout/local-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });
});
