// tests/end2end/cases/smoke/init.test.ts
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('E2E Smoke Tests', () => {
  e2eTest('init creates syncskill directory structure', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .setup();

    try {
      await ctx.run('syncskill', 'init', '-y', '--skip-self');

      await ctx.assertFileExists('.syncskill/config.json');
      await ctx.assertFileExists('.syncskill/skills');

      const config = await ctx.readConfig() as { version: number; agents: Record<string, unknown> };
      expect(config.version).toBe(1);
      expect(config).toHaveProperty('agents');
      expect(config).toHaveProperty('links');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link creates symlinks in agent directories', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSelf: true })
      .withSkill('test-skill', '# Test Skill\n')
      .withLinks({ 'test-skill': ['*'] })
      .setup();

    try {
      await ctx.run('syncskill', 'link', '--all');

      await ctx.assertLinked('test-skill', ['claude', 'agents']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('help command works', async () => {
    const ctx = await new E2EScenario().setup();

    try {
      const result = await ctx.run('syncskill', '--help');

      expect(result.success).toBe(true);
      ctx.assertOutputContains(result, 'Usage: syncskill');
      ctx.assertOutputContains(result, 'init');
      ctx.assertOutputContains(result, 'install');
      ctx.assertOutputContains(result, 'link');
    } finally {
      await ctx.cleanup();
    }
  });
});
