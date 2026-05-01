import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../../src/config.js';
import { loadServerManifest, saveServerManifest } from '../../src/manifest.js';
import { refreshStoredManifests } from '../../src/refresh.js';
import * as transportModule from '../../src/transport.js';

describe('remote refresh orchestration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('refreshStoredManifests rewrites remote and local manifests from real remote hashes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-remote-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {
              claude: '/srv/skills'
            }
          }
        },
        sources: {}
      },
      homeDir
    );

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        stale: {
          local_hash: null,
          remote_hash: 'stale-hash',
          recorded_hash: 'stale-hash',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'welcome-hash',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    const manifests = await refreshStoredManifests(homeDir, {
      local: false,
      remote: true,
      server: 'alpha'
    });

    expect(manifests[0]?.skills.stale).toBeUndefined();
    expect(manifests[0]?.skills.welcome?.remote_hash).toBe('welcome-hash');
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toEqual(manifests[0]);
  });
});
