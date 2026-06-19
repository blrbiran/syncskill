import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('install local source derived', () => {
  e2eTest('install local source keeps doctor and link status aligned', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const sourceRoot = join(ctx.homeDir, 'llmfusion');
      await mkdir(join(sourceRoot, 'skills', 'llmfusion'), { recursive: true });
      await writeFile(join(sourceRoot, 'skills', 'llmfusion', 'SKILL.md'), '# llmfusion', 'utf8');

      const installResult = await ctx.run('syncskill', 'install', sourceRoot, '-y');
      expect(installResult.success).toBe(true);

      await ctx.assertFileExists('.syncskill/skills/llmfusion/SKILL.md');
      await ctx.assertLinked('llmfusion', ['claude', 'agents']);

      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; url: string; path: string }>;
      };
      expect(config.sources?.llmfusion).toEqual({
        type: 'local',
        url: sourceRoot,
        path: '.'
      });

      const doctorResult = await ctx.run('syncskill', 'doctor');
      expect(doctorResult.success).toBe(true);
      expect(doctorResult.stdout + doctorResult.stderr).not.toContain('links.llmfusion');

      const linkLsResult = await ctx.run('syncskill', 'link', 'ls');
      expect(linkLsResult.success).toBe(true);
      ctx.assertOutputContains(linkLsResult, 'llmfusion');
    } finally {
      await ctx.cleanup();
    }
  });
});
