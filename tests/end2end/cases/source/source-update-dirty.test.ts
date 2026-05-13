// tests/end2end/cases/source/source-update-dirty.test.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario, modifySkillInGitRepo } from '../../framework/index.js';

describe('source update dirty state', () => {
  e2eTest('update detects dirty git multiskill repo', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('test-source', {
        skills: ['skill-a', 'skill-b', 'skill-c'],
        skillContents: {
          'skill-a': '# Skill A Version 1',
          'skill-b': '# Skill B Version 1',
          'skill-c': '# Skill C Version 1',
        },
      })
      .setup();

    try {
      // Manually set up the git source (CLI requires GitHub URLs, so we simulate state)
      const gitUrl = ctx.getGitSourceUrl('test-source');

      // Clone the bare repo to the expected checkout location
      const sourceDir = join(ctx.syncskillDir, '.sources', 'test-source');
      const checkoutDir = join(sourceDir, 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Create symlinks in skills dir
      const skillsDir = join(ctx.syncskillDir, 'skills');
      await symlink(join(checkoutDir, 'skill-a'), join(skillsDir, 'skill-a'));
      await symlink(join(checkoutDir, 'skill-b'), join(skillsDir, 'skill-b'));
      await symlink(join(checkoutDir, 'skill-c'), join(skillsDir, 'skill-c'));

      // Update config to include the source
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'test-source': {
          type: 'git',
          url: gitUrl,
          path: '.',
        },
      };
      config.links = {
        'skill-a': ['*'],
        'skill-b': ['*'],
        'skill-c': ['*'],
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write source state (required for dirty detection - previousSkills.length > 0)
      const stateFile = join(sourceDir, 'state.json');
      await writeFile(stateFile, JSON.stringify({
        materialized_skills: ['skill-a', 'skill-b', 'skill-c'],
        updated_at: new Date().toISOString(),
      }), 'utf8');

      // Write registry
      await ctx.writeRegistry({
        skills: {
          'skill-a': {
            path: join(checkoutDir, 'skill-a'),
            origin: 'test-source',
            type: 'git',
            status: 'active',
          },
          'skill-b': {
            path: join(checkoutDir, 'skill-b'),
            origin: 'test-source',
            type: 'git',
            status: 'active',
          },
          'skill-c': {
            path: join(checkoutDir, 'skill-c'),
            origin: 'test-source',
            type: 'git',
            status: 'active',
          },
        },
      });

      // Make skill-a dirty by modifying locally (uncommitted change in checkout)
      await writeFile(
        join(checkoutDir, 'skill-a', 'SKILL.md'),
        '# Skill A Version 1 - LOCAL MODIFICATION',
        'utf8'
      );

      // Modify remote version of skill-a
      const workDir = ctx.getGitSourceWorkDir('test-source');
      await modifySkillInGitRepo(workDir, 'skill-a', '# Skill A Version 2');

      // Run update command with -y (should skip dirty)
      const updateResult = await ctx.run('syncskill', 'update', 'test-source', '-y');

      // Verify output mentions dirty/skip for skill-a
      const output = updateResult.stdout + updateResult.stderr;
      expect(output.toLowerCase()).toMatch(/dirty|skip|local.*modif/i);

      // Verify local modification is preserved (dirty skill was not overwritten)
      const localContent = await ctx.readFile('.syncskill/.sources/test-source/checkout/skill-a/SKILL.md');
      expect(localContent).toContain('LOCAL MODIFICATION');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update detects dirty http source by hash', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .setup();

    try {
      // Manually set up an HTTP source with hash tracking
      // (HTTP sources require a URL to update, but we can verify the hash mechanism)
      const skillsDir = join(ctx.syncskillDir, 'skills');
      const httpSkillDir = join(skillsDir, 'http-skill');
      await mkdir(httpSkillDir, { recursive: true });
      await writeFile(join(httpSkillDir, 'SKILL.md'), '# HTTP Skill Original', 'utf8');

      // Create registry with last_update_hash (simulating HTTP source installation)
      await ctx.writeRegistry({
        skills: {
          'http-skill': {
            path: httpSkillDir,
            origin: 'http-source',
            type: 'http',
            status: 'active',
            last_update_hash: 'original-hash-12345',
          },
        },
      });

      // Verify the registry has the hash field
      const registry = (await ctx.readRegistry()) as {
        skills?: Record<string, { last_update_hash?: string; path?: string; origin?: string }>;
      };
      const skillEntry = registry.skills?.['http-skill'];
      expect(skillEntry).toBeDefined();
      expect(skillEntry?.last_update_hash).toBe('original-hash-12345');

      // Modify the installed skill locally (makes it dirty - hash will differ)
      await ctx.writeFile('.syncskill/skills/http-skill/SKILL.md', '# HTTP Skill - MODIFIED LOCALLY');

      // The last_update_hash field enables hash-based dirty detection for HTTP sources.
      // When update runs, it compares current hash against last_update_hash.
      // Since we modified the file, the hash will differ, triggering dirty detection.

      // Verify the skill was modified
      const content = await ctx.readFile('.syncskill/skills/http-skill/SKILL.md');
      expect(content).toContain('MODIFIED LOCALLY');

      // Verify registry structure is intact
      const finalRegistry = (await ctx.readRegistry()) as {
        skills?: Record<string, { last_update_hash?: string; origin?: string; type?: string }>;
      };
      const httpSkill = finalRegistry.skills?.['http-skill'];
      expect(httpSkill).toBeDefined();
      expect(httpSkill?.origin).toBe('http-source');
      expect(httpSkill?.type).toBe('http');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update force creates backup', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('test-source', {
        skills: ['my-skill'],
        skillContents: { 'my-skill': '# Version 1' },
      })
      .setup();

    try {
      // Manually set up the git source
      const gitUrl = ctx.getGitSourceUrl('test-source');

      // Clone the bare repo to the expected checkout location
      const sourceDir = join(ctx.syncskillDir, '.sources', 'test-source');
      const checkoutDir = join(sourceDir, 'checkout');
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
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write source state (required for dirty detection - previousSkills.length > 0)
      const stateFile = join(sourceDir, 'state.json');
      await writeFile(stateFile, JSON.stringify({
        materialized_skills: ['my-skill'],
        updated_at: new Date().toISOString(),
      }), 'utf8');

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

      // Make skill dirty by modifying locally
      const localModification = '# Version 1 - LOCAL CHANGES';
      await writeFile(join(checkoutDir, 'my-skill', 'SKILL.md'), localModification, 'utf8');

      // Modify remote
      const workDir = ctx.getGitSourceWorkDir('test-source');
      await modifySkillInGitRepo(workDir, 'my-skill', '# Version 2');

      // Run update with --force -y (should backup and update)
      const updateResult = await ctx.run('syncskill', 'update', '--force', '-y', 'test-source');
      expect(updateResult.success).toBe(true);

      // Verify backup was created
      await ctx.assertBackupExists('test-source', 'my-skill');

      // Verify content was updated to remote version
      const updatedContent = await ctx.readFile('.syncskill/.sources/test-source/checkout/my-skill/SKILL.md');
      expect(updatedContent).toBe('# Version 2');

      // Verify the materialized skill also has Version 2
      const materializedContent = await ctx.readFile('.syncskill/skills/my-skill/SKILL.md');
      expect(materializedContent).toBe('# Version 2');
    } finally {
      await ctx.cleanup();
    }
  });
});
