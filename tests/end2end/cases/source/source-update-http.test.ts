// tests/end2end/cases/source/source-update-http.test.ts
/**
 * E2E tests for top-level update behavior with HTTP/local sources.
 *
 * Scenario 3: Top-level update for HTTP sources should:
 * - Download to temp directory first
 * - Verify skills exist before replacing
 * - Only then remove old and move new
 * - Handle URL expiration gracefully
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { hashSkillDirectory } from '../../../../src/core/manifest.js';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('top-level update http', () => {
  e2eTest('update skips local archive without url', async () => {
    // Scenario 3: Local archives without URL cannot be updated
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('local-only.zip', {
        skills: ['local-skill'],
        format: 'zip',
      })
      .setup();

    try {
      // Install from local archive
      const archivePath = ctx.getArchivePath('local-only.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify source type is 'local'
      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type: string; url?: string; path?: string }>;
      };
      const source = config.sources?.['local-only'];
      expect(source?.type).toBe('local');
      // Local sources have path, not url
      expect(source?.path).toBeDefined();

      // Update should skip this source (no URL to update from)
      const updateResult = await ctx.run('syncskill', 'update', '--all', '-y');
      expect(updateResult.success).toBe(true);

      // Skill should still exist (not broken by update)
      await ctx.assertFileExists('.syncskill/.sources/local-only/checkout/local-skill/SKILL.md');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update reports which sources will be updated', async () => {
    // Scenario 3.3: Update should first report what will be updated
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('git-repo', {
        skills: ['git-skill'],
        skillContents: { 'git-skill': '# Git Skill\n' },
      })
      .withArchive('local-archive.zip', {
        skills: ['local-skill'],
        format: 'zip',
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('git-repo');

      // Setup git source manually
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'git-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Install local archive
      const archivePath = ctx.getArchivePath('local-archive.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Update config with git source
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        ...((config.sources as Record<string, unknown>) ?? {}),
        'git-repo': { type: 'git', url: gitUrl, path: '.' },
      };
      await ctx.writeConfig(config);

      // Run update --all with dry-run or check output
      const updateResult = await ctx.run('syncskill', 'update', '--all', '-y');

      // Should mention git-repo being updated
      const output = updateResult.stdout + updateResult.stderr;
      expect(output).toMatch(/git-repo/i);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update blocks dirty http sources unless forced and refreshes http baselines after force update', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withArchive('http-v1.tar.gz', {
        skills: ['http-skill'],
        format: 'tar.gz',
        skillContents: { 'http-skill': '# HTTP Skill V1\n' },
      })
      .withArchive('http-v2.tar.gz', {
        skills: ['http-skill'],
        format: 'tar.gz',
        skillContents: { 'http-skill': '# HTTP Skill V2\n' },
      })
      .setup();

    let closeServer: (() => Promise<void>) | undefined;

    try {
      const archiveV1 = await readFile(ctx.getArchivePath('http-v1.tar.gz'));
      const archiveV2 = await readFile(ctx.getArchivePath('http-v2.tar.gz'));
      let currentArchive = archiveV1;

      const httpServer = createServer((request, response) => {
        if (request.url !== '/source.tar.gz') {
          response.statusCode = 404;
          response.end('not found');
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/gzip');
        response.end(currentArchive);
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
        httpServer.once('error', reject);
      });

      closeServer = () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Failed to determine local HTTP archive server address');
      }

      const sourceUrl = `http://127.0.0.1:${address.port}/source.tar.gz`;
      const archivePath = ctx.getArchivePath('http-v1.tar.gz');
      const installResult = await ctx.run('syncskill', 'install', archivePath, '--name', 'http-pack', '-y');
      expect(installResult.success).toBe(true);

      const config = (await ctx.readConfig()) as {
        sources?: Record<string, { type?: string; url?: string; path?: string }>;
      };
      config.sources = {
        ...(config.sources ?? {}),
        'http-pack': {
          type: 'http',
          url: sourceUrl,
          path: '.',
        },
      };
      await ctx.writeConfig(config);

      const initialHash = await hashSkillDirectory(join(ctx.syncskillDir, 'skills', 'http-skill'));
      await ctx.writeRegistry({
        version: 2,
        http_baselines: {
          'http-skill': {
            hash: initialHash,
            source: 'http-pack',
          },
        },
      });

      const updatedConfig = (await ctx.readConfig()) as {
        sources?: Record<string, { type?: string; url?: string; path?: string }>;
      };
      expect(updatedConfig.sources?.['http-pack']?.type).toBe('http');
      expect(updatedConfig.sources?.['http-pack']?.url).toBe(sourceUrl);

      await ctx.writeFile('.syncskill/skills/http-skill/SKILL.md', '# HTTP Skill LOCAL EDIT\n');

      const dirtyResult = await ctx.run('syncskill', ['update', 'http-pack', '-y'], { expectedExitCode: null });
      expect(dirtyResult.exitCode).toBe(6);
      expect(dirtyResult.success).toBe(false);
      expect((dirtyResult.stdout + dirtyResult.stderr).toLowerCase()).toMatch(/dirty|skip|local/);
      await ctx.assertFileContains('.syncskill/skills/http-skill/SKILL.md', 'LOCAL EDIT');

      currentArchive = archiveV2;

      const forceResult = await ctx.run('syncskill', ['update', '--force', '-y', 'http-pack'], { expectedExitCode: null });
      expect(forceResult.success).toBe(true);

      await ctx.assertFileContains('.syncskill/.backups/sources/http-pack/pre-update/http-skill/SKILL.md', 'LOCAL EDIT');
      await ctx.assertFileContains('.syncskill/skills/http-skill/SKILL.md', 'HTTP Skill V2');
      await ctx.assertFileContains('.syncskill/.sources/http-pack/checkout/http-skill/SKILL.md', 'HTTP Skill V2');

      const updatedHash = await hashSkillDirectory(join(ctx.syncskillDir, 'skills', 'http-skill'));
      const registry = (await ctx.readRegistry()) as {
        version?: number;
        http_baselines?: Record<string, { hash?: string; source?: string }>;
      };
      expect(registry.version).toBe(2);
      expect(registry.http_baselines?.['http-skill']).toEqual({
        hash: updatedHash,
        source: 'http-pack',
      });
    } finally {
      if (closeServer) {
        await closeServer();
      }
      await ctx.cleanup();
    }
  });

  e2eTest.skip('update reports skills removed from source', async () => {
    // TODO: Update should report when skills are removed from upstream
    // Currently update doesn't report skill removal
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .withGitSource('shrinking-repo', {
        skills: ['keep-skill', 'remove-skill'],
        skillContents: {
          'keep-skill': '# Keep Skill\n',
          'remove-skill': '# Remove Skill\n',
        },
      })
      .setup();

    try {
      const gitUrl = ctx.getGitSourceUrl('shrinking-repo');
      const workDir = ctx.getGitSourceWorkDir('shrinking-repo');

      // Setup git source
      const checkoutDir = join(ctx.syncskillDir, '.sources', 'shrinking-repo', 'checkout');
      await ctx.exec('git', ['clone', gitUrl, checkoutDir]);

      // Setup config
      const config = (await ctx.readConfig()) as Record<string, unknown>;
      config.sources = {
        'shrinking-repo': { type: 'git', url: gitUrl, path: '.' },
      };
      config.links = {
        'keep-skill': ['*'],
        'remove-skill': ['*'],
      };
      await ctx.writeConfig(config);

      // Write state file
      const stateFile = join(ctx.syncskillDir, '.sources', 'shrinking-repo', 'state.json');
      await writeFile(stateFile, JSON.stringify({
        materialized_skills: ['keep-skill', 'remove-skill'],
        updated_at: new Date().toISOString(),
      }), 'utf8');

      // Remove skill from upstream
      const { removeSkillFromGitRepo } = await import('../../framework/index.js');
      await removeSkillFromGitRepo(workDir, 'remove-skill');

      // Update should notify about removed skill
      const updateResult = await ctx.run('syncskill', 'update', 'shrinking-repo', '-y');
      expect(updateResult.success).toBe(true);

      // Should mention removed skill
      const output = updateResult.stdout + updateResult.stderr;
      expect(output.toLowerCase()).toMatch(/remove|missing|gone/i);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('update alias', () => {
  e2eTest('syncskill update is available as a top-level command', async () => {
    // Scenario 3.2: update should be top-level command
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSelf: true })
      .setup();

    try {
      const updateHelp = await ctx.run('syncskill', 'update', '--help');
      const sourceHelp = await ctx.run('syncskill', 'source', '--help');

      expect(updateHelp.success).toBe(true);
      expect(sourceHelp.success).toBe(true);
      expect(updateHelp.stdout).toMatch(/update/i);
      expect(sourceHelp.stdout).not.toContain('update [name]');
    } finally {
      await ctx.cleanup();
    }
  });
});
