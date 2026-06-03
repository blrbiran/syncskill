import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildReceiverConfigPayload,
  formatProbeLines,
  formatServerListLines,
  formatServerShowLines,
  loadReceiverBackupIfExists,
  mergeRefreshedReceiverBackup,
  mutateReceiverBackup,
  snapshotReceiverBackupState,
} from '../../src/core/server.js';

describe('server helpers', () => {
  it('formats server list lines in sorted order', () => {
    expect(formatServerListLines(['beta', 'alpha'])).toEqual(['alpha', 'beta']);
  });

  it('formats one receiver backup summary', () => {
    expect(
      formatServerShowLines({
        version: 1,
        server: 'alpha',
        updated_at: '2026-06-03T09:01:00.000Z',
        remote_agents: {
          claude: '/home/deploy/.claude/skills'
        },
        links: {
          welcome: ['claude'],
          archived: []
        }
      })
    ).toEqual([
      'version\t1',
      'server\talpha',
      'updated_at\t2026-06-03T09:01:00.000Z',
      'remote_agent\tclaude\t/home/deploy/.claude/skills',
      'link\tarchived\t',
      'link\twelcome\tclaude'
    ]);
  });

  it('formats probe results as tab-separated status rows', () => {
    expect(
      formatProbeLines([
        { check: 'transport', ok: true, detail: 'ssh ok' },
        { check: 'receiver', ok: true, detail: 'receiver ok' },
        { check: 'remote_agent:claude', ok: false, detail: 'missing: /srv/skills' }
      ])
    ).toEqual([
      'transport\tok\tssh ok',
      'receiver\tok\treceiver ok',
      'remote_agent:claude\tfail\tmissing: /srv/skills'
    ]);
  });

  it('snapshots only the requested receiver backup section', () => {
    expect(
      snapshotReceiverBackupState(
        {
          version: 1,
          server: 'alpha',
          updated_at: '2026-06-03T09:01:00.000Z',
          remote_agents: {
            claude: '/srv/claude'
          },
          links: {
            welcome: ['claude']
          }
        },
        'links'
      )
    ).toEqual({
      links: {
        welcome: ['claude']
      }
    });
  });

  it('creates and persists receiver backup mutations', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-unit-'));

    const backup = await mutateReceiverBackup(homeDir, 'alpha', (currentBackup) => {
      currentBackup.remote_agents.claude = '/srv/claude';
      currentBackup.links.welcome = ['claude'];
    }, { updatedAt: '2026-06-03T10:00:00.000Z' });

    expect(backup).toMatchObject({
      server: 'alpha',
      updated_at: '2026-06-03T10:00:00.000Z',
      remote_agents: {
        claude: '/srv/claude'
      },
      links: {
        welcome: ['claude']
      }
    });
    await expect(loadReceiverBackupIfExists(homeDir, 'alpha')).resolves.toMatchObject({
      updated_at: '2026-06-03T10:00:00.000Z',
      remote_agents: {
        claude: '/srv/claude'
      },
      links: {
        welcome: ['claude']
      }
    });
  });

  it('builds receiver config payload from backup when present', () => {
    expect(buildReceiverConfigPayload(
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          stale: '/srv/stale'
        }
      },
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-06-03T10:00:00.000Z',
        remote_agents: {
          claude: '/srv/claude'
        },
        links: {
          welcome: ['claude']
        }
      }
    )).toEqual({
      remote_agents: {
        claude: '/srv/claude'
      },
      links: {
        welcome: ['claude']
      }
    });
  });

  it('merges scanned remote topology into receiver backup', () => {
    expect(mergeRefreshedReceiverBackup(
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-06-03T09:00:00.000Z',
        remote_agents: {
          codex: '/srv/codex'
        },
        links: {
          shared: ['*'],
          stale: ['codex']
        }
      },
      {
        name: 'alpha',
        host: 'alpha.example.com',
        remote_agents: {
          claude: '/srv/claude'
        }
      },
      {
        discovered_agents: [
          {
            name: 'claude',
            path: '/srv/claude',
            symlinked_skills: ['welcome', 'shared'],
            directory_skills: ['manual']
          }
        ],
        remote_only_skills: ['detached']
      },
      '2026-06-03T10:00:00.000Z'
    )).toEqual({
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-03T10:00:00.000Z',
      remote_agents: {
        claude: '/srv/claude',
        codex: '/srv/codex'
      },
      links: {
        detached: [],
        manual: [],
        shared: ['*'],
        stale: ['codex'],
        welcome: ['claude']
      }
    });
  });
});
