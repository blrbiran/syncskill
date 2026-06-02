// tests/end2end/cases/link/link-wildcard-change.test.ts
/**
 * E2E tests for changing link config from wildcard (*) to specific agents.
 *
 * Scenario 6: A skill previously linked to all agents (*) is changed to
 * link only to specific agents. The stale symlinks in other agent directories
 * should be removed, but real directories and unmanaged symlinks should be preserved.
 */
import { mkdir, symlink, writeFile, lstat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('link wildcard to specific', () => {
  e2eTest('link removes stale symlinks when changing from * to specific agents', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen', 'aone_copilot')
      .withSkill('algorithmic-art', '# Algorithmic Art Skill\n')
      .withLinks({ 'algorithmic-art': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // First link with wildcard - should link to all agents
      const linkResult1 = await ctx.run('syncskill', 'link', 'build');
      expect(linkResult1.success).toBe(true);

      // Verify linked to all agents
      await ctx.assertLinked('algorithmic-art', ['claude', 'agents', 'qwen', 'aone_copilot']);
      await ctx.assertIsSymlink('algorithmic-art', 'claude');
      await ctx.assertIsSymlink('algorithmic-art', 'qwen');
      await ctx.assertIsSymlink('algorithmic-art', 'aone_copilot');

      // Change config to only link to claude
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'algorithmic-art': ['claude'] };
      await ctx.writeConfig(config);

      // Run link build again (should clean up stale symlinks)
      const linkResult2 = await ctx.run('syncskill', 'link', 'build', '-y');
      expect(linkResult2.success).toBe(true);

      // Verify only claude has the link now
      await ctx.assertLinked('algorithmic-art', ['claude']);
      await ctx.assertIsSymlink('algorithmic-art', 'claude');

      // Verify stale symlinks removed from other agents
      await ctx.assertNotLinked('algorithmic-art', ['agents', 'qwen', 'aone_copilot']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link single skill removes its stale symlinks from other agents', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen')
      .withSkill('my-skill', '# My Skill\n')
      .withLinks({ 'my-skill': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Link with wildcard
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('my-skill', ['claude', 'agents', 'qwen']);

      // Change to claude only
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'my-skill': ['claude'] };
      await ctx.writeConfig(config);

      // Run link set for a single skill
      const result = await ctx.run('syncskill', 'link', 'set', 'my-skill', 'claude', '-y');
      expect(result.success).toBe(true);

      // Verify claude has link, others do not
      await ctx.assertLinked('my-skill', ['claude']);
      await ctx.assertNotLinked('my-skill', ['agents', 'qwen']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves real directories when removing stale links', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'qwen')
      .withSkill('shared-skill', '# Shared Skill\n')
      .withLinks({ 'shared-skill': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Link with wildcard
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('shared-skill', ['claude', 'qwen']);

      // Replace qwen symlink with real directory (user's own version)
      const qwenSkillPath = ctx.getPath('.qwen', 'skills', 'shared-skill');
      const { rm } = await import('node:fs/promises');
      await rm(qwenSkillPath, { recursive: true });
      await mkdir(qwenSkillPath, { recursive: true });
      await writeFile(join(qwenSkillPath, 'SKILL.md'), '# Qwen Custom Version\n', 'utf8');

      // Verify qwen now has real directory
      await ctx.assertIsRealDir('shared-skill', 'qwen');

      // Change config to claude only
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'shared-skill': ['claude'] };
      await ctx.writeConfig(config);

      // Run link build
      const result = await ctx.run('syncskill', 'link', 'build', '-y');
      expect(result.success).toBe(true);

      // Verify claude still linked
      await ctx.assertLinked('shared-skill', ['claude']);

      // Verify qwen's real directory is PRESERVED (not deleted)
      await ctx.assertIsRealDir('shared-skill', 'qwen');
      const qwenContent = await ctx.readFile('.qwen/skills/shared-skill/SKILL.md');
      expect(qwenContent).toBe('# Qwen Custom Version\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves unmanaged symlinks when removing stale links', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'qwen')
      .withSkill('managed-skill', '# Managed Skill\n')
      .withLinks({ 'managed-skill': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Link with wildcard
      await ctx.run('syncskill', 'link', 'build');
      await ctx.assertLinked('managed-skill', ['claude', 'qwen']);

      // Create unmanaged symlink in qwen pointing to external location
      const externalDir = ctx.getPath('external-skills', 'external-skill');
      await mkdir(externalDir, { recursive: true });
      await writeFile(join(externalDir, 'SKILL.md'), '# External Skill\n', 'utf8');

      const qwenSkillsDir = ctx.getPath('.qwen', 'skills');
      await symlink(externalDir, join(qwenSkillsDir, 'external-skill'));

      // Replace managed-skill symlink in qwen with unmanaged symlink
      const qwenManagedPath = join(qwenSkillsDir, 'managed-skill');
      const { rm, readlink } = await import('node:fs/promises');
      await rm(qwenManagedPath);

      // Create symlink to some other location (not .syncskill)
      const otherDir = ctx.getPath('other-skills', 'managed-skill');
      await mkdir(otherDir, { recursive: true });
      await writeFile(join(otherDir, 'SKILL.md'), '# Other Version\n', 'utf8');
      await symlink(otherDir, qwenManagedPath);

      // Change config to claude only
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'managed-skill': ['claude'] };
      await ctx.writeConfig(config);

      // Run link build
      const result = await ctx.run('syncskill', 'link', 'build', '-y');
      expect(result.success).toBe(true);

      // Verify claude still linked
      await ctx.assertLinked('managed-skill', ['claude']);

      // Verify external-skill symlink is preserved
      await ctx.assertLinked('external-skill', ['qwen']);

      // The unmanaged symlink for managed-skill should also be preserved
      // because it doesn't point to .syncskill (syncskill doesn't manage it)
      const target = await readlink(qwenManagedPath);
      expect(target).toBe(otherDir);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link does not remove symlinks from agents not in config', async () => {
    // If an agent directory exists but is not in the agents list,
    // syncskill should not touch symlinks there
    const ctx = await new E2EScenario()
      .withAgents('claude') // Only claude configured
      .withSkill('my-skill', '# My Skill\n')
      .withLinks({ 'my-skill': ['claude'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Manually create qwen directory with symlink
      // (simulating user has qwen installed but not configured in syncskill)
      const qwenSkillsDir = ctx.getPath('.qwen', 'skills');
      await mkdir(qwenSkillsDir, { recursive: true });

      // Create symlink pointing to .syncskill (as if previously linked)
      const skillPath = join(ctx.syncskillDir, 'skills', 'my-skill');
      await symlink(skillPath, join(qwenSkillsDir, 'my-skill'));

      // Run link build
      const result = await ctx.run('syncskill', 'link', 'build');
      expect(result.success).toBe(true);

      // Claude should have the link
      await ctx.assertLinked('my-skill', ['claude']);

      // Qwen's symlink should still exist (syncskill doesn't manage unconfigured agents)
      const qwenSymlink = join(qwenSkillsDir, 'my-skill');
      const stats = await lstat(qwenSymlink);
      expect(stats.isSymbolicLink()).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
