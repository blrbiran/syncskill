// tests/unit/e2e-scenario.test.ts
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2EScenario', () => {
  const contexts: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      await ctx.cleanup();
    }
  });

  it('setup creates temp directory and returns context', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario().setup();
    contexts.push(ctx);

    expect(ctx.homeDir).toContain('syncskill-e2e-');
    const stats = await stat(ctx.homeDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('withAgents creates agent directories', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .setup();
    contexts.push(ctx);

    const claudeStats = await stat(join(ctx.homeDir, '.claude', 'skills'));
    expect(claudeStats.isDirectory()).toBe(true);

    const agentsStats = await stat(join(ctx.homeDir, '.agents', 'skills'));
    expect(agentsStats.isDirectory()).toBe(true);
  });

  it('withSkill creates skill in syncskill dir', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withSkill('my-skill', '# My Skill\n')
      .setup();
    contexts.push(ctx);

    const skillStats = await stat(join(ctx.syncskillDir, 'skills', 'my-skill', 'SKILL.md'));
    expect(skillStats.isFile()).toBe(true);
  });

  it('withInit runs syncskill init', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .setup();
    contexts.push(ctx);

    await ctx.assertFileExists('.syncskill/config.json');
  });

  it('withGitSource creates git repository', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withGitSource('test-repo', { skills: ['skill-a'] })
      .setup();
    contexts.push(ctx);

    const url = ctx.getGitSourceUrl('test-repo');
    expect(url).toContain('test-repo.git');
  });

  it('withArchive creates archive file', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withArchive('skills.zip', { skills: ['skill-x'], format: 'zip' })
      .setup();
    contexts.push(ctx);

    const archivePath = ctx.getArchivePath('skills.zip');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);
  });

  it('withMockServer creates server directory', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withMockServer({ name: 'dev' })
      .setup();
    contexts.push(ctx);

    const serverPath = ctx.getMockServerPath('dev');
    const stats = await stat(serverPath);
    expect(stats.isDirectory()).toBe(true);
  });
});
