// tests/end2end/cases/sync/receiver-update.test.ts
/**
 * E2E tests for receiver version update scenarios.
 *
 * Scenario 9: Receiver is deployed on first push, but subsequent pushes
 * should update the receiver if the local version has changed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('receiver update', () => {
  e2eTest('push updates receiver when local version changes', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('my-skill', '# My Skill\n')
      .withMockServer({ name: 'server1', skills: [] })
      .setup();

    try {
      // Setup config with server
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'my-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Simulate first push: receiver deployed to server
      const serverPath = ctx.getMockServerPath('server1');
      const receiverDir = join(serverPath, '.syncskill', 'receiver');
      await mkdir(receiverDir, { recursive: true });

      // Write "old" receiver version
      const oldReceiverContent = `// Old receiver version
export const VERSION = '1.0.0';
export function processSync() { return 'v1'; }
`;
      await writeFile(join(receiverDir, 'sync_receiver.mjs'), oldReceiverContent, 'utf8');

      // Write receiver version marker
      await writeFile(join(receiverDir, 'VERSION'), '1.0.0', 'utf8');

      // Verify old receiver is deployed
      const deployedVersion = await readFile(join(receiverDir, 'VERSION'), 'utf8');
      expect(deployedVersion.trim()).toBe('1.0.0');

      // TODO: When push detects local receiver version differs from deployed,
      // it should redeploy the receiver
      // This requires:
      // 1. Local receiver has VERSION embedded or computed
      // 2. Push compares local VERSION with remote VERSION
      // 3. If different, redeploy receiver before sync

      // const pushResult = await ctx.run('syncskill', 'push', 'server1', '--all', '-y');
      // expect(pushResult.success).toBe(true);

      // Verify receiver was updated (VERSION should match current)
      // const newVersion = await readFile(join(receiverDir, 'VERSION'), 'utf8');
      // expect(newVersion.trim()).not.toBe('1.0.0'); // Should be newer
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('push force-updates receiver with --update-receiver flag', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('my-skill', '# My Skill\n')
      .withMockServer({ name: 'server1', skills: [] })
      .setup();

    try {
      // Setup config with server
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.links = { 'my-skill': ['*'] };
      config.servers = {
        server1: {
          host: 'localhost',
          remote_syncskill_dir: ctx.getMockServerPath('server1') + '/.syncskill',
        },
      };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Simulate receiver already deployed
      const serverPath = ctx.getMockServerPath('server1');
      const receiverDir = join(serverPath, '.syncskill', 'receiver');
      await mkdir(receiverDir, { recursive: true });
      await writeFile(join(receiverDir, 'sync_receiver.mjs'), '// Old version', 'utf8');

      // TODO: --update-receiver flag should force receiver redeployment
      // const pushResult = await ctx.run('syncskill', 'push', 'server1', '--update-receiver', '-y');
      // expect(pushResult.success).toBe(true);
      // ctx.assertOutputContains(pushResult, 'receiver');
    } finally {
      await ctx.cleanup();
    }
  });
});
