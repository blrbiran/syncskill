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

      // Ruling (#462, 2026-11-24 human 「同意你的建议」): a local source is linked straight to the source (b6f2bc1),
      // so nothing lands in .syncskill/skills and install must print the real location the links point to.
      const skillSourceDir = join(sourceRoot, 'skills', 'llmfusion');
      await ctx.assertFileNotExists('.syncskill/skills/llmfusion');
      await ctx.assertSymlinkTarget('llmfusion', 'claude', skillSourceDir);
      await ctx.assertSymlinkTarget('llmfusion', 'agents', skillSourceDir);
      ctx.assertOutputContains(installResult, `llmfusion → ${skillSourceDir}`);

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
      // Ruling (#462, 2026-11-24 human 「同意你的建议」): install followed by doctor reports no issues.
      ctx.assertOutputContains(doctorResult, 'No issues found');

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

      // Ruling (#462, 2026-11-24 human 「同意你的建议」): the local source is linked directly and the reported
      // target is the source directory, not an empty .syncskill/skills/<name>.
      const skillSourceDir = join(sourceRoot, 'skills', 'llmfusion');
      const changeEvent = events.find((event) => event.type === 'change' && event.name === 'llmfusion');
      expect(changeEvent?.target).toBe(skillSourceDir);
      await ctx.assertFileNotExists('.syncskill/skills/llmfusion');
      await ctx.assertSymlinkTarget('llmfusion', 'claude', skillSourceDir);
      await ctx.assertSymlinkTarget('llmfusion', 'agents', skillSourceDir);
      await ctx.assertLinksConfig('llmfusion', ['agents', 'claude']);
    } finally {
      await ctx.cleanup();
    }
  });

  // #462: in a home without ~/.agents/skills, init does not register `agents`, yet install links it by default.
  e2eTest('install local source into a home without the shared agents dir leaves doctor clean', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const sourceRoot = join(ctx.homeDir, 'llmfusion');
      await mkdir(join(sourceRoot, 'skills', 'llmfusion'), { recursive: true });
      await writeFile(join(sourceRoot, 'skills', 'llmfusion', 'SKILL.md'), '# llmfusion', 'utf8');

      const installResult = await ctx.run('syncskill', 'install', sourceRoot, '-y');
      expect(installResult.success).toBe(true);

      const config = (await ctx.readConfig()) as { agents: Record<string, string> };
      expect(Object.keys(config.agents)).not.toContain('agents');
      await ctx.assertLinksConfig('llmfusion', ['agents', 'claude']);

      const doctorResult = await ctx.run('syncskill', 'doctor');
      expect(doctorResult.success).toBe(true);
      expect(doctorResult.stdout + doctorResult.stderr).not.toContain('not configured in agents');
      ctx.assertOutputContains(doctorResult, 'No issues found');
    } finally {
      await ctx.cleanup();
    }
  });
});
