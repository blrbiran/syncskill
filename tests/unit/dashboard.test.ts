import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../../src/config/config.js';
import { saveSkillsRegistry } from '../../src/core/skills-registry.js';
import { saveServerManifest, type ServerManifest } from '../../src/core/manifest.js';
import { formatDashboardSummary, loadDashboardSummary } from '../../src/dashboard.js';
import { useTempDirs } from '../helpers/temp-dir.js';

describe('dashboard summary', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    // cleanup handled by useTempDirs
  });

  it('formats the dashboard summary in the spec layout', () => {
    const output = formatDashboardSummary({
      skills: { total: 12, linked: 10, ignored: 2 },
      sources: ['my-repo', 'skill-pack', 'local-tools'],
      agents: [
        { name: 'claude', exists: true },
        { name: 'cursor', exists: true },
        { name: 'hermes', exists: false }
      ],
      servers: [
        { name: 'prod', status: 'in-sync', pending: 0 },
        { name: 'dev', status: 'pending', pending: 2 }
      ],
      health: { issues: 0 }
    });

    expect(output).toBe([
      'Syncskill Status',
      '────────────────────────────────────────',
      '',
      'Skills:   12 total (10 linked, 2 ignored)',
      'Sources:  3 (my-repo, skill-pack, local-tools)',
      'Agents:   claude ✓  cursor ✓  hermes ✗',
      '',
      'Servers:',
      '  prod     ✓ in-sync',
      '  dev      ⚠ 2 skills pending push',
      '',
      'Health:   ✓ No issues',
      '',
      'Quick actions:',
      '  syncskill link          Edit skill-agent mappings',
      '  syncskill update        Update all sources',
      '  syncskill push          Push changes to servers',
      '',
      'Run `syncskill --help` for all commands.'
    ].join('\n'));
  });

  it('loads dashboard data from config, registry, manifests, and diagnostics', async () => {
    const homeDir = join(tmpdir(), `syncskill-dashboard-${Date.now()}`);
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const sourceOneDir = join(homeDir, 'sources', 'my-repo');
    const sourceTwoDir = join(homeDir, 'sources', 'local-tools');

    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(sourceOneDir, { recursive: true });
    await mkdir(sourceTwoDir, { recursive: true });

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {
          claude: claudeDir,
          cursor: cursorDir,
          hermes: join(homeDir, '.hermes', 'skills')
        },
        links: {},
        servers: {
          dev: { host: 'dev.example.com', remote_agents: {} },
          prod: { host: 'prod.example.com', remote_agents: {} }
        },
        sources: {
          'my-repo': { type: 'local', path: sourceOneDir },
          'local-tools': { type: 'local', path: sourceTwoDir }
        },
        private_agents: ['cursor', 'hermes']
      },
      homeDir
    );

    await saveSkillsRegistry(homeDir, {
      version: 1,
      skills: {
        alpha: { path: join(homeDir, '.syncskill', 'skills', 'alpha'), origin: 'manual', type: 'manual', status: 'active' },
        beta: { path: join(homeDir, '.syncskill', 'skills', 'beta'), origin: 'manual', type: 'manual', status: 'active' },
        gamma: { path: join(homeDir, '.syncskill', 'skills', 'gamma'), origin: 'my-repo', type: 'local', status: 'ignored', ignored_reason: 'user-choice' }
      }
    });

    const prodManifest: ServerManifest = {
      version: 1,
      server: 'prod',
      updated_at: new Date().toISOString(),
      skills: {
        alpha: { local_hash: 'a', remote_hash: 'a', recorded_hash: 'a', direction: 'skip', status: 'in-sync' }
      }
    };
    const devManifest: ServerManifest = {
      version: 1,
      server: 'dev',
      updated_at: new Date().toISOString(),
      skills: {
        alpha: { local_hash: 'a', remote_hash: 'b', recorded_hash: 'b', direction: 'push', status: 'local-changed' },
        beta: { local_hash: 'c', remote_hash: null, recorded_hash: null, direction: 'push', status: 'new' }
      }
    };

    await saveServerManifest(homeDir, prodManifest);
    await saveServerManifest(homeDir, devManifest);

    const summary = await loadDashboardSummary(homeDir);

    expect(summary).toEqual({
      skills: { total: 3, linked: 2, ignored: 1 },
      sources: ['local-tools', 'my-repo'],
      agents: [
        { name: 'claude', exists: true },
        { name: 'cursor', exists: true },
        { name: 'hermes', exists: false }
      ],
      servers: [
        { name: 'dev', status: 'pending', pending: 2 },
        { name: 'prod', status: 'in-sync', pending: 0 }
      ],
      health: { issues: 1 }
    });
  });
});
