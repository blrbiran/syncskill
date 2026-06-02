// tests/end2end/cases/link/link-reconcile.test.ts
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('link reconcile', () => {
  e2eTest('link all removes stale symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen')
      .withSkill('my-skill')
      .withLinks({ 'my-skill': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Run link build, should link to all agents
      const linkResult1 = await ctx.run('syncskill', 'link', 'build');
      expect(linkResult1.success).toBe(true);

      // Verify linked to all agents
      await ctx.assertLinked('my-skill', ['claude', 'agents', 'qwen']);

      // Change config to only link to claude
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'my-skill': ['claude'] };
      await ctx.writeConfig(config);

      // Run link build again with -y to auto-confirm removal
      const linkResult2 = await ctx.run('syncskill', 'link', 'build', '-y');
      expect(linkResult2.success).toBe(true);

      // Verify only claude has the link, others should be removed
      await ctx.assertLinked('my-skill', ['claude']);
      await ctx.assertNotLinked('my-skill', ['agents', 'qwen']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link single skill removes its stale symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen')
      .withSkills(['skill-one', 'skill-two'])
      .withLinks({ 'skill-one': ['*'], 'skill-two': ['*'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Run link build, both skills linked to all agents
      const linkResult1 = await ctx.run('syncskill', 'link', 'build');
      expect(linkResult1.success).toBe(true);

      // Verify both skills linked to all agents
      await ctx.assertLinked('skill-one', ['claude', 'agents', 'qwen']);
      await ctx.assertLinked('skill-two', ['claude', 'agents', 'qwen']);

      // Change skill-one config to only link to claude
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'skill-one': ['claude'], 'skill-two': ['*'] };
      await ctx.writeConfig(config);

      // Run link set for skill-one only with -y to auto-confirm stale removal
      const linkResult2 = await ctx.run('syncskill', 'link', 'set', 'skill-one', 'claude', '-y');
      expect(linkResult2.success).toBe(true);

      // Verify skill-one only in claude, removed from others
      await ctx.assertLinked('skill-one', ['claude']);
      await ctx.assertNotLinked('skill-one', ['agents', 'qwen']);

      // Verify skill-two unaffected (still linked to all)
      await ctx.assertLinked('skill-two', ['claude', 'agents', 'qwen']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves real directories', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withSkill('my-skill')
      .withLinks({ 'my-skill': ['claude'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Create a REAL directory (not symlink) for the skill in agents' skills folder
      const agentsSkillDir = ctx.getPath('.agents', 'skills', 'my-skill');
      await mkdir(agentsSkillDir, { recursive: true });
      await writeFile(join(agentsSkillDir, 'SKILL.md'), '# User created skill', 'utf8');

      // Run link build
      const linkResult = await ctx.run('syncskill', 'link', 'build');
      expect(linkResult.success).toBe(true);

      // Verify real directory in agents is preserved
      await ctx.assertIsRealDir('my-skill', 'agents');

      // Verify claude has symlink
      await ctx.assertLinked('my-skill', ['claude']);
      await ctx.assertIsSymlink('my-skill', 'claude');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves unmanaged symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withSkill('my-skill')
      .withLinks({ 'my-skill': ['claude'] })
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      // Create external directory outside .syncskill
      const externalDir = ctx.getPath('external-skills', 'external-skill');
      await mkdir(externalDir, { recursive: true });
      await writeFile(join(externalDir, 'SKILL.md'), '# External skill', 'utf8');

      // Create unmanaged symlink in agents pointing to external dir
      const agentsSkillsDir = ctx.getPath('.agents', 'skills');
      await mkdir(agentsSkillsDir, { recursive: true });
      await symlink(externalDir, join(agentsSkillsDir, 'external-skill'));

      // Also create a syncskill-managed symlink in agents that should be cleaned
      // (This simulates a previous link build when agents was in the link config)
      const managedSkillPath = ctx.getPath('.syncskill', 'skills', 'my-skill');
      await symlink(managedSkillPath, join(agentsSkillsDir, 'my-skill'));

      // Run link build with -y to auto-confirm removal
      const linkResult = await ctx.run('syncskill', 'link', 'build', '-y');
      expect(linkResult.success).toBe(true);

      // Verify external symlink is preserved
      await ctx.assertLinked('external-skill', ['agents']);
      await ctx.assertIsSymlink('external-skill', 'agents');

      // Verify syncskill-managed symlink is removed from agents
      await ctx.assertNotLinked('my-skill', ['agents']);

      // Verify claude has the proper symlink
      await ctx.assertLinked('my-skill', ['claude']);
      await ctx.assertIsSymlink('my-skill', 'claude');
    } finally {
      await ctx.cleanup();
    }
  });
});
