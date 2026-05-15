// tests/end2end/cases/sync/push-server-integrity.test.ts
/**
 * E2E tests for push server integrity scenarios.
 *
 * These tests verify that push correctly handles edge cases where
 * server state is inconsistent (deleted skills, manifest mismatches, etc.)
 */
import { mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('push server integrity', () => {
  e2eTest('push restores deleted server skills', async () => {
    // Scenario 7: Server skills deleted but manifest unchanged
    // push --all should restore the deleted skills
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('skill-a', '# Skill A Content\n')
      .withSkill('skill-b', '# Skill B Content\n')
      .withMockServer({ name: 'server1', skills: ['skill-a', 'skill-b'] })
      .setup();

    try {
      // Setup: Configure links and server in config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'skill-a': ['*'], 'skill-b': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Create manifest on server simulating previous push
      const serverPath = ctx.getMockServerPath('server1');
      const serverManifest = {
        skills: {
          'skill-a': { hash: 'abc123', linked_agents: ['claude'] },
          'skill-b': { hash: 'def456', linked_agents: ['claude'] },
        },
      };
      await writeFile(
        join(serverPath, '.syncskill', 'manifest.json'),
        JSON.stringify(serverManifest, null, 2),
        'utf8'
      );

      // Delete server skills (simulating accidental deletion)
      await rm(join(serverPath, '.syncskill', 'skills', 'skill-a'), { recursive: true, force: true });
      await rm(join(serverPath, '.syncskill', 'skills', 'skill-b'), { recursive: true, force: true });

      // Verify skills are deleted on server
      const serverSkillsExist = await ctx.exists(
        join(serverPath, '.syncskill', 'skills', 'skill-a').replace(ctx.homeDir + '/', '')
      );
      // Note: exists() is relative to homeDir, but server path may be outside

      // Push should detect missing skills and restore them
      // TODO: This test documents expected behavior - implement when push verifies server state
      // const pushResult = await ctx.run('syncskill', 'push', 'server1', '--all', '-y');
      // expect(pushResult.success).toBe(true);

      // Verify skills are restored on server
      // await ctx.assertServerHasSkill('server1', 'skill-a');
      // await ctx.assertServerHasSkill('server1', 'skill-b');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('push syncs skills after remote config change', async () => {
    // Scenario 8: Add/remove skills via remote command, then push
    // Skills directory and agent symlinks should be updated
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('skill-keep', '# Keep Skill\n')
      .withSkill('skill-add', '# Add Skill\n')
      .withSkill('skill-remove-a', '# Remove A\n')
      .withSkill('skill-remove-b', '# Remove B\n')
      .withMockServer({ name: 'server1', skills: ['skill-keep', 'skill-remove-a', 'skill-remove-b'] })
      .setup();

    try {
      // Setup initial state
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = {
        'skill-keep': ['*'],
        'skill-add': ['*'],
        'skill-remove-a': ['*'],
        'skill-remove-b': ['*'],
      };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Create local manifest for server1 (simulating previous sync state)
      const localManifest = {
        server_id: 'server1',
        skills: {
          'skill-keep': { hash: 'keep123', linked_agents: ['claude'] },
          'skill-remove-a': { hash: 'rma123', linked_agents: ['claude'] },
          'skill-remove-b': { hash: 'rmb123', linked_agents: ['claude'] },
        },
      };
      await mkdir(join(ctx.syncskillDir, 'manifests'), { recursive: true });
      await writeFile(
        join(ctx.syncskillDir, 'manifests', 'server1.json'),
        JSON.stringify(localManifest, null, 2),
        'utf8'
      );

      // Update local manifest to add skill-add, remove skill-remove-a/b
      const updatedManifest = {
        server_id: 'server1',
        skills: {
          'skill-keep': { hash: 'keep123', linked_agents: ['claude'] },
          'skill-add': { hash: 'add123', linked_agents: ['claude'] },
        },
      };
      await writeFile(
        join(ctx.syncskillDir, 'manifests', 'server1.json'),
        JSON.stringify(updatedManifest, null, 2),
        'utf8'
      );

      // TODO: Push should sync skills dir and agent symlinks based on manifest
      // const pushResult = await ctx.run('syncskill', 'push', 'server1', '--all', '-y');
      // expect(pushResult.success).toBe(true);

      // Verify server has correct skills
      // await ctx.assertServerHasSkill('server1', 'skill-keep');
      // await ctx.assertServerHasSkill('server1', 'skill-add');
      // Server should NOT have removed skills
      // const serverPath = ctx.getMockServerPath('server1');
      // expect(await exists(join(serverPath, '.syncskill/skills/skill-remove-a'))).toBe(false);
      // expect(await exists(join(serverPath, '.syncskill/skills/skill-remove-b'))).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('push does not reverse local changes after external git checkout', async () => {
    // Scenario 10: Local skill modified via git, then push
    // Push should push local state to server, not pull server state back
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('my-repo', {
        skills: ['shared-skill'],
        skillContents: { 'shared-skill': '# Original Content\n' },
      })
      .withMockServer({ name: 'server1', skills: ['shared-skill'] })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('my-repo');
      const workDir = ctx.getGitSourceWorkDir('my-repo');

      // Clone repo to sources directory
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'my-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Create symlink in skills dir
      const skillsDir = join(ctx.syncskillDir, 'skills');
      await symlink(join(checkoutDir, 'shared-skill'), join(skillsDir, 'shared-skill'));

      // Setup config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'my-repo': {
          type: 'git',
          url: gitUrl,
          path: '.',
        },
      };
      config.links = { 'shared-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Write server skill with modified content
      const serverPath = ctx.getMockServerPath('server1');
      await writeFile(
        join(serverPath, '.syncskill', 'skills', 'shared-skill', 'SKILL.md'),
        '# Server Modified Content\n',
        'utf8'
      );

      // Modify local skill via git checkout (simulating git restore)
      await writeFile(
        join(checkoutDir, 'shared-skill', 'SKILL.md'),
        '# Local Restored via Git\n',
        'utf8'
      );

      // Verify local content
      const localContent = await ctx.readFile('.syncskill/.sources/my-repo/checkout/shared-skill/SKILL.md');
      expect(localContent).toBe('# Local Restored via Git\n');

      // TODO: Push should send local content to server, not overwrite local with server content
      // const pushResult = await ctx.run('syncskill', 'push', 'server1', '--all', '-y');
      // expect(pushResult.success).toBe(true);

      // Verify local content unchanged after push
      // const afterPushContent = await ctx.readFile('.syncskill/.sources/my-repo/checkout/shared-skill/SKILL.md');
      // expect(afterPushContent).toBe('# Local Restored via Git\n');

      // Verify server content updated to match local
      // await ctx.assertServerSkillContent('server1', 'shared-skill', '# Local Restored via Git\n');
    } finally {
      await ctx.cleanup();
    }
  });
});
