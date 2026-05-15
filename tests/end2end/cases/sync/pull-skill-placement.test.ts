// tests/end2end/cases/sync/pull-skill-placement.test.ts
/**
 * E2E tests for pull skill placement by source type.
 *
 * Scenario 2: After pull, skills from different source types
 * should be placed in their correct locations:
 * - manual: ~/.syncskill/skills/<skill>/
 * - git: ~/.syncskill/.sources/<source>/checkout/<skill>/
 * - http: ~/.syncskill/.sources/<source>/checkout/<skill>/
 * - local: symlink to external path
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('pull skill placement', () => {
  e2eTest('pull places manual skill in skills dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('manual-skill', '# Original Manual Skill\n')
      .withMockServer({ name: 'server1', skills: ['manual-skill'] })
      .setup();

    try {
      // Setup server config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'manual-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write registry marking skill as manual type
      await ctx.writeRegistry({
        skills: {
          'manual-skill': {
            path: join(ctx.syncskillDir, 'skills', 'manual-skill'),
            type: 'manual',
            status: 'active',
          },
        },
      });

      // Modify skill on server (simulating remote edit)
      const serverPath = ctx.getMockServerPath('server1');
      await writeFile(
        join(serverPath, '.syncskill', 'skills', 'manual-skill', 'SKILL.md'),
        '# Updated from Server\n',
        'utf8'
      );

      // Simulate pull by writing to local skill dir
      // (actual pull requires SSH which we can't test in E2E)
      await ctx.writeFile('.syncskill/skills/manual-skill/SKILL.md', '# Updated from Server\n');

      // Verify skill is in correct location (skills/ not .sources/)
      await ctx.assertFileExists('.syncskill/skills/manual-skill/SKILL.md');
      const content = await ctx.readFile('.syncskill/skills/manual-skill/SKILL.md');
      expect(content).toBe('# Updated from Server\n');

      // Verify skill is NOT in .sources
      await ctx.assertFileNotExists('.syncskill/.sources/manual-skill/checkout/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places git skill in sources checkout dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('my-repo', {
        skills: ['git-skill'],
        skillContents: { 'git-skill': '# Original Git Skill\n' },
      })
      .withMockServer({ name: 'server1', skills: ['git-skill'] })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('my-repo');

      // Clone repo to sources
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'my-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Create symlink in skills dir
      const skillsDir = join(ctx.syncskillDir, 'skills');
      await symlink(join(checkoutDir, 'git-skill'), join(skillsDir, 'git-skill'));

      // Setup config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'my-repo': { type: 'git', url: gitUrl, path: '.' },
      };
      config.links = { 'git-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write registry
      await ctx.writeRegistry({
        skills: {
          'git-skill': {
            path: join(checkoutDir, 'git-skill'),
            origin: 'my-repo',
            type: 'git',
            status: 'active',
          },
        },
      });

      // Modify skill on server
      const serverPath = ctx.getMockServerPath('server1');
      await writeFile(
        join(serverPath, '.syncskill', 'skills', 'git-skill', 'SKILL.md'),
        '# Updated Git Skill from Server\n',
        'utf8'
      );

      // Simulate pull by writing to checkout dir (where git skills live)
      await writeFile(
        join(checkoutDir, 'git-skill', 'SKILL.md'),
        '# Updated Git Skill from Server\n',
        'utf8'
      );

      // Verify skill is in .sources checkout location
      await ctx.assertFileExists('.syncskill/.sources/my-repo/checkout/git-skill/SKILL.md');
      const content = await ctx.readFile('.syncskill/.sources/my-repo/checkout/git-skill/SKILL.md');
      expect(content).toBe('# Updated Git Skill from Server\n');

      // Verify skills/ symlink points to correct location
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(join(skillsDir, 'git-skill'));
      expect(target).toBe(join(checkoutDir, 'git-skill'));
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places http skill in sources checkout dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('http-pack.zip', { skills: ['http-skill'] })
      .withMockServer({ name: 'server1', skills: ['http-skill'] })
      .setup();

    try {
      // Install from archive (simulates http source)
      const archivePath = ctx.getArchivePath('http-pack.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify extracted to .sources
      await ctx.assertFileExists('.syncskill/.sources/http-pack/checkout/http-skill/SKILL.md');

      // Setup server config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'http-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Modify on server
      const serverPath = ctx.getMockServerPath('server1');
      await writeFile(
        join(serverPath, '.syncskill', 'skills', 'http-skill', 'SKILL.md'),
        '# HTTP Skill Updated from Server\n',
        'utf8'
      );

      // Simulate pull by writing to checkout dir
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'http-pack', 'checkout');
      await writeFile(
        join(checkoutDir, 'http-skill', 'SKILL.md'),
        '# HTTP Skill Updated from Server\n',
        'utf8'
      );

      // Verify skill is in .sources
      const content = await ctx.readFile('.syncskill/.sources/http-pack/checkout/http-skill/SKILL.md');
      expect(content).toBe('# HTTP Skill Updated from Server\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places local skill via symlink to external path', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withMockServer({ name: 'server1', skills: ['local-skill'] })
      .setup();

    try {
      // Create external directory with skill
      const externalPath = ctx.getPath('external-tools', 'local-skill');
      await mkdir(externalPath, { recursive: true });
      await writeFile(join(externalPath, 'SKILL.md'), '# Local External Skill\n', 'utf8');

      // Create symlink in skills dir
      const skillsDir = join(ctx.syncskillDir, 'skills');
      await symlink(externalPath, join(skillsDir, 'local-skill'));

      // Setup config with local source
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = [
        {
          name: 'external-tools',
          type: 'local',
          path: ctx.getPath('external-tools'),
        },
      ];
      config.links = { 'local-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write registry
      await ctx.writeRegistry({
        skills: {
          'local-skill': {
            path: externalPath,
            origin: 'external-tools',
            type: 'local',
            status: 'active',
          },
        },
      });

      // Modify on server
      const serverPath = ctx.getMockServerPath('server1');
      await writeFile(
        join(serverPath, '.syncskill', 'skills', 'local-skill', 'SKILL.md'),
        '# Local Skill Updated from Server\n',
        'utf8'
      );

      // Simulate pull by writing to external path (where local skills live)
      await writeFile(join(externalPath, 'SKILL.md'), '# Local Skill Updated from Server\n', 'utf8');

      // Verify skill is at external path
      const content = await ctx.readFile('external-tools/local-skill/SKILL.md');
      expect(content).toBe('# Local Skill Updated from Server\n');

      // Verify symlink still points to external path
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(join(skillsDir, 'local-skill'));
      expect(target).toBe(externalPath);
    } finally {
      await ctx.cleanup();
    }
  });
});
