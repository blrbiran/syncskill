// tests/end2end/cases/sync/pull-target.test.ts
/**
 * Pull target path resolution tests.
 *
 * These tests verify that skills from different sources are stored in the
 * correct locations and can be linked properly after simulated "pull" updates.
 *
 * Note: These tests use partial mocking (directly setting up state) since
 * full sync operations require SSH which is not available in E2E tests.
 * The tests simulate the state that would exist after a successful sync.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('pull target paths', () => {
  e2eTest('manual skill in skills dir can be updated and relinked', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withSkill('manual-skill', '# Original Content\n')
      .withLinks({ 'manual-skill': ['*'] })
      .setup();

    try {
      // Link the manual skill first
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('manual-skill', ['claude']);

      // Simulate "pulled" content by directly writing to the expected location
      const skillPath = join(ctx.syncskillDir, 'skills', 'manual-skill');
      await writeFile(
        join(skillPath, 'SKILL.md'),
        '# Updated from server\n',
        'utf8'
      );

      // Verify link command still works with the updated content
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('manual-skill', ['claude']);

      // Verify content is at expected path
      const content = await ctx.readFile('.syncskill/skills/manual-skill/SKILL.md');
      expect(content).toBe('# Updated from server\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('source skill in .sources checkout dir can be updated and relinked', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('http-pack.zip', { skills: ['http-skill'] })
      .setup();

    try {
      // Install from archive - this extracts to .sources/<name>/checkout/
      const archivePath = ctx.getArchivePath('http-pack.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify archive was extracted to .sources directory
      await ctx.assertFileExists('.syncskill/.sources/http-pack/checkout/http-skill/SKILL.md');

      // Manually add the skill to links config (simulating what sync would do)
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'http-skill': ['*'] };
      await ctx.writeConfig(config);

      // Link the skill
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('http-skill', ['claude']);

      // Simulate "pulled" content update
      const sourcePath = join(ctx.syncskillDir, '.sources', 'http-pack', 'checkout', 'http-skill');
      await writeFile(
        join(sourcePath, 'SKILL.md'),
        '# Pulled from server\n',
        'utf8'
      );

      // Verify link still works after update
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('http-skill', ['claude']);

      // Verify content was updated
      const content = await ctx.readFile('.syncskill/.sources/http-pack/checkout/http-skill/SKILL.md');
      expect(content).toBe('# Pulled from server\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('multiple skills from same source share checkout directory', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('multi-skills.zip', { skills: ['skill-a', 'skill-b', 'skill-c'] })
      .setup();

    try {
      // Install from archive
      const archivePath = ctx.getArchivePath('multi-skills.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify all skills share the same source checkout directory
      await ctx.assertFileExists('.syncskill/.sources/multi-skills/checkout/skill-a/SKILL.md');
      await ctx.assertFileExists('.syncskill/.sources/multi-skills/checkout/skill-b/SKILL.md');
      await ctx.assertFileExists('.syncskill/.sources/multi-skills/checkout/skill-c/SKILL.md');

      // Manually add skills to links config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'skill-a': ['*'], 'skill-b': ['*'], 'skill-c': ['*'] };
      await ctx.writeConfig(config);

      // Link all skills
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('skill-a', ['claude']);
      await ctx.assertLinked('skill-b', ['claude']);
      await ctx.assertLinked('skill-c', ['claude']);

      // Update one skill
      const skillAPath = join(ctx.syncskillDir, '.sources', 'multi-skills', 'checkout', 'skill-a');
      await writeFile(join(skillAPath, 'SKILL.md'), '# Updated A\n', 'utf8');

      // Relink just skill-a
      await ctx.run('syncskill', 'link', 'build');

      // Verify all skills are still linked
      await ctx.assertLinked('skill-a', ['claude']);
      await ctx.assertLinked('skill-b', ['claude']);
      await ctx.assertLinked('skill-c', ['claude']);

      // Verify only skill-a content changed
      const contentA = await ctx.readFile('.syncskill/.sources/multi-skills/checkout/skill-a/SKILL.md');
      expect(contentA).toBe('# Updated A\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('symlink target points to correct skill directory', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withSkill('target-skill', '# Target Skill\n')
      .withLinks({ 'target-skill': ['*'] })
      .setup();

    try {
      // Link the skill
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('target-skill', ['claude']);

      // Verify symlink points to the correct directory in .syncskill/skills/
      const expectedTarget = join(ctx.syncskillDir, 'skills', 'target-skill');
      await ctx.assertSymlinkTarget('target-skill', 'claude', expectedTarget);

      // Simulate content update
      await writeFile(
        join(expectedTarget, 'SKILL.md'),
        '# Updated Target Skill\n',
        'utf8'
      );

      // Verify the symlink still points to correct location after content update
      await ctx.assertSymlinkTarget('target-skill', 'claude', expectedTarget);

      // Reading via the symlink should return updated content
      const linkedContent = await ctx.readFile('.claude/skills/target-skill/SKILL.md');
      expect(linkedContent).toBe('# Updated Target Skill\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places git source skill in sources dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('my-repo', { skills: ['git-skill'] })
      .setup();

    try {
      // Simulate post-pull state: skill exists in sources directory
      const sourcesDir = join(ctx.syncskillDir, '.sources', 'my-repo', 'checkout');
      const skillSourcePath = join(sourcesDir, 'git-skill');
      await mkdir(skillSourcePath, { recursive: true });
      await writeFile(join(skillSourcePath, 'SKILL.md'), '# Git Skill Content\n', 'utf8');

      // Create symlink in skills dir pointing to sources dir (simulates what pull does)
      const skillsDir = join(ctx.syncskillDir, 'skills');
      const { symlink } = await import('node:fs/promises');
      await symlink(skillSourcePath, join(skillsDir, 'git-skill'));

      // Manually add link config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'git-skill': ['*'] };
      await ctx.writeConfig(config);

      // Link the skill
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('git-skill', ['claude']);

      // Simulate pulled content update
      await writeFile(join(skillSourcePath, 'SKILL.md'), '# Pulled from git\n', 'utf8');

      // Relink after update
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('git-skill', ['claude']);

      // Verify content via symlink
      const content = await ctx.readFile('.claude/skills/git-skill/SKILL.md');
      expect(content).toBe('# Pulled from git\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places local source skill in external path', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Create external directory with skill
      const externalPath = join(ctx.homeDir, 'external-tools');
      const skillExternalPath = join(externalPath, 'local-skill');
      await mkdir(skillExternalPath, { recursive: true });
      await writeFile(join(skillExternalPath, 'SKILL.md'), '# External Local Skill\n', 'utf8');

      // Create symlink in skills dir pointing to external path (simulates local source linking)
      const skillsDir = join(ctx.syncskillDir, 'skills');
      const skillsSymlink = join(skillsDir, 'local-skill');
      const { symlink, readlink } = await import('node:fs/promises');
      await symlink(skillExternalPath, skillsSymlink);

      // Manually write config with source type: 'local' pointing to the external root
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'external-source': {
          type: 'local',
          url: externalPath,
          path: '.',
        },
      };
      config.links = { 'local-skill': ['*'] };
      await ctx.writeConfig(config);

      // Link the skill
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('local-skill', ['claude']);

      // Verify agent symlink points to .syncskill/skills/local-skill
      await ctx.assertSymlinkTarget('local-skill', 'claude', skillsSymlink);

      // Verify the intermediate symlink points to external path
      const intermediateTarget = await readlink(skillsSymlink);
      expect(intermediateTarget).toBe(skillExternalPath);
    } finally {
      await ctx.cleanup();
    }
  });
});
