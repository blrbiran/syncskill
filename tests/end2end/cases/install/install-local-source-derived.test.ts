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

  e2eTest('apply planned local source install with resolutions', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const sourceRoot = join(ctx.homeDir, 'planned-local-source');
      await mkdir(join(sourceRoot, 'skills', 'llmfusion'), { recursive: true });
      await writeFile(join(sourceRoot, 'skills', 'llmfusion', 'SKILL.md'), '# llmfusion', 'utf8');

      const planResult = await ctx.run('syncskill', ['--plan', 'install', sourceRoot]);
      expect(planResult.success).toBe(true);
      const plan = JSON.parse(planResult.stdout) as {
        actions: Array<{ op: string }>;
        unresolved: Array<{ kind: string; resolve_phase: string }>;
      };
      expect(plan.actions.some((action) => action.op === 'install-source')).toBe(true);
      expect(plan.unresolved).toEqual([
        expect.objectContaining({ kind: 'skill-selection', resolve_phase: 'execute' })
      ]);

      await ctx.writeFile('install-local-source.plan.json', planResult.stdout);
      const applyResult = await ctx.run(
        'syncskill',
        ['--json', '--apply', ctx.getPath('install-local-source.plan.json'), '--resolutions', '-', 'install', sourceRoot],
        {
          stdin: JSON.stringify({
            'skill-selection': {
              selected: ['llmfusion']
            }
          })
        }
      );
      expect(applyResult.success).toBe(true);

      const events = applyResult.stdout.trim().split('\n').map((line) => JSON.parse(line));
      const resultEvent = events.find((event) => event.type === 'result');
      expect(resultEvent.ok).toBe(true);

      await ctx.assertFileExists('.syncskill/skills/llmfusion/SKILL.md');
      await ctx.assertLinked('llmfusion', ['claude', 'agents']);
      await ctx.assertLinksConfig('llmfusion', ['agents', 'claude']);
    } finally {
      await ctx.cleanup();
    }
  });
});
