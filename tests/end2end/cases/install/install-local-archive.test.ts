// tests/end2end/cases/install/install-local-archive.test.ts
// TODO: CLI doesn't auto-add skills to links for local archives yet
// These tests document expected behavior per spec - unskip when CLI is fixed
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('install local archive', () => {
  e2eTest.skip('install local zip extracts and links', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
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

      // Verify config has source with type: local and archive_path
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, {
          type: string;
          archive_path?: string;
          path: string;
        }>;
        links?: Record<string, string[]>;
      };

      const source = config.sources?.['my-skills'];
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
      expect(source?.archive_path).toBe(archivePath);

      // Verify skills are in links
      expect(config.links?.['skill-alpha']).toEqual(['*']);
      expect(config.links?.['skill-beta']).toEqual(['*']);

      // Verify skills-registry.json records correct info
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { origin: string; type: string; status: string }>;
      };
      expect(registry.skills['skill-alpha']?.origin).toBe('my-skills');
      expect(registry.skills['skill-alpha']?.type).toBe('local');
      expect(registry.skills['skill-alpha']?.status).toBe('active');

      // Verify skills are linked
      await ctx.assertLinked('skill-alpha', ['claude', 'agents']);
      await ctx.assertLinked('skill-beta', ['claude', 'agents']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest.skip('source add local archive equivalent to install', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('other-skills.zip', {
        skills: ['tool-one', 'tool-two'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('other-skills.zip');
      const result = await ctx.run('syncskill', 'source', 'add', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify same structure as install
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; archive_path?: string }>;
        links?: Record<string, string[]>;
      };

      const source = config.sources?.['other-skills'];
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
      expect(source?.archive_path).toBe(archivePath);

      // Skills should be in links
      expect(config.links?.['tool-one']).toBeDefined();
      expect(config.links?.['tool-two']).toBeDefined();

      // Verify skills-registry.json records correct info
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { origin: string; type: string; status: string }>;
      };
      expect(registry.skills['tool-one']?.origin).toBe('other-skills');
      expect(registry.skills['tool-one']?.type).toBe('local');

      // Verify skills are linked
      await ctx.assertLinked('tool-one', ['claude']);
      await ctx.assertLinked('tool-two', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });
});
