import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, saveConfig } from '../../src/config/config.js';
import { getSyncPaths } from '../../src/config/config.js';
import { createEmptyManifest, saveServerManifest } from '../../src/core/manifest.js';
import {
  autoRefreshManifests,
  formatDiffLines,
  formatStatusLines,
  listTrackedServers,
  loadTrackedManifests,
  refreshStoredManifests,
  shouldRefreshLocal,
  shouldRefreshRemote
} from '../../src/refresh.js';
import { rebuildRemoteManifestFromHashes } from '../../src/core/manifest.js';
import * as transportModule from '../../src/core/transport.js';

describe('refresh orchestration', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('listTrackedServers returns the sorted union of configured and stored server names', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: {},
          alpha: {}
        },
        sources: {}
      },
      homeDir
    );

    const { manifestsDir } = getSyncPaths(homeDir);
    await mkdir(manifestsDir, { recursive: true });
    await writeFile(join(manifestsDir, 'charlie.json'), '{}\n', 'utf8');
    await writeFile(join(manifestsDir, 'alpha.json'), '{}\n', 'utf8');
    await writeFile(join(manifestsDir, 'ignore.txt'), 'nope\n', 'utf8');

    await expect(listTrackedServers(homeDir)).resolves.toEqual(['alpha', 'beta', 'charlie']);
  });

  it('refreshStoredManifests recomputes local hashes for every tracked server by default', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: {},
          alpha: {}
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const updatedAt = '2026-05-01T12:00:00.000Z';
    const manifests = await refreshStoredManifests(homeDir, { now: updatedAt });

    expect(manifests.map((manifest) => manifest.server)).toEqual(['alpha', 'beta']);
    expect(manifests.every((manifest) => manifest.updated_at === updatedAt)).toBe(true);
    expect(manifests.map((manifest) => manifest.skills.welcome.local_hash)).toEqual([expect.any(String), expect.any(String)]);

    const manifestFiles = (await readdir(getSyncPaths(homeDir).manifestsDir)).sort();
    expect(manifestFiles).toEqual(['alpha.json', 'beta.json']);
  });

  it('autoRefreshManifests warns instead of throwing when refresh fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {}
        },
        sources: {}
      },
      homeDir
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(getSyncPaths(homeDir).manifestsDir, { recursive: true });
    await writeFile(join(getSyncPaths(homeDir).manifestsDir, 'alpha.json'), '{broken-json\n', 'utf8');

    await expect(autoRefreshManifests(homeDir, true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARNING: auto refresh failed:'));
  });

  it('loadTrackedManifests loads reconciled manifests for all tracked servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: {}
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
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'push',
          status: 'new'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {}
    });

    const manifests = await loadTrackedManifests(homeDir);

    expect(manifests).toEqual([
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: '11111111111111111111111111111111',
            remote_hash: '11111111111111111111111111111111',
            recorded_hash: '11111111111111111111111111111111',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      },
      {
        version: 1,
        server: 'beta',
        updated_at: '2026-05-02T00:00:00.000Z',
        skills: {}
      }
    ]);
  });

  it('loadTrackedManifests loads reconciled manifests for a selected server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'push',
          status: 'new'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {}
    });

    const manifests = await loadTrackedManifests(homeDir, 'alpha');

    expect(manifests).toEqual([
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: '11111111111111111111111111111111',
            remote_hash: '11111111111111111111111111111111',
            recorded_hash: '11111111111111111111111111111111',
            direction: 'skip',
            status: 'in-sync'
          }
        }
      }
    ]);
  });

  it('refreshStoredManifests rewrites stored manifests on remote-only refresh', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
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
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'push',
          status: 'new'
        }
      }
    });

    vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-03T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '22222222222222222222222222222222',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });

    const manifests = await refreshStoredManifests(homeDir, {
      local: false,
      remote: true,
      now: '2026-05-03T00:00:00.000Z'
    });

    expect(manifests).toEqual([
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-03T00:00:00.000Z',
        skills: {
          welcome: {
            local_hash: '11111111111111111111111111111111',
            remote_hash: '22222222222222222222222222222222',
            recorded_hash: '11111111111111111111111111111111',
            direction: 'pull',
            status: 'remote-changed'
          }
        }
      }
    ]);

    await expect(loadTrackedManifests(homeDir, 'alpha')).resolves.toEqual(manifests);
  });

  it('refreshStoredManifests defaults to local refresh when both flags are explicitly false', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {}
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
        welcome: {
          local_hash: null,
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const updatedAt = '2026-05-05T00:00:00.000Z';
    const manifests = await refreshStoredManifests(homeDir, {
      local: false,
      remote: false,
      now: updatedAt
    });

    expect(manifests).toEqual([
      {
        version: 1,
        server: 'alpha',
        updated_at: updatedAt,
        skills: {
          welcome: {
            local_hash: expect.any(String),
            remote_hash: '11111111111111111111111111111111',
            recorded_hash: '11111111111111111111111111111111',
            direction: 'push',
            status: 'local-changed'
          }
        }
      }
    ]);
    expect(manifests[0]?.skills.welcome.local_hash).not.toBeNull();
  });

  it('refreshStoredManifests targets a single server when requested', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {},
          beta: {}
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const updatedAt = '2026-05-04T00:00:00.000Z';
    const manifests = await refreshStoredManifests(homeDir, { server: 'beta', now: updatedAt });

    expect(manifests.map((manifest) => manifest.server)).toEqual(['beta']);
    expect(manifests[0]?.updated_at).toBe(updatedAt);
    await expect(loadTrackedManifests(homeDir)).resolves.toEqual([
      {
        version: 1,
        server: 'alpha',
        updated_at: expect.any(String),
        skills: {}
      },
      {
        version: 1,
        server: 'beta',
        updated_at: updatedAt,
        skills: {
          welcome: {
            local_hash: expect.any(String),
            remote_hash: null,
            recorded_hash: null,
            direction: 'push',
            status: 'new'
          }
        }
      }
    ]);
  });

  it('autoRefreshManifests does nothing when disabled', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(autoRefreshManifests(homeDir, false)).resolves.toBeUndefined();
    await expect(listTrackedServers(homeDir)).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('interprets local and remote refresh options consistently', () => {
    expect(shouldRefreshLocal({ local: true })).toBe(true);
    expect(shouldRefreshLocal({ remote: true })).toBe(false);
    expect(shouldRefreshLocal({ local: false, remote: false })).toBe(true);
    expect(shouldRefreshLocal({})).toBe(true);

    expect(shouldRefreshRemote({})).toBe(false);
    expect(shouldRefreshRemote({ local: true })).toBe(false);
    expect(shouldRefreshRemote({ remote: true })).toBe(true);
    expect(shouldRefreshRemote({ local: true, remote: true })).toBe(true);
  });

  it('interprets all option as both local and remote refresh', () => {
    expect(shouldRefreshLocal({ all: true })).toBe(true);
    expect(shouldRefreshRemote({ all: true })).toBe(true);
    expect(shouldRefreshLocal({ all: true, local: false })).toBe(true);
    expect(shouldRefreshRemote({ all: true, remote: false })).toBe(true);
  });

  it('refreshes both local and remote when all option is true', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
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

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'pull',
          status: 'new'
        }
      }
    });

    vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockImplementation(
      async (_server, _runtime, manifest, updatedAt) => ({
        ...manifest,
        updated_at: updatedAt,
        skills: {
          ...manifest.skills,
          welcome: {
            ...manifest.skills.welcome,
            remote_hash: '22222222222222222222222222222222'
          }
        }
      })
    );

    const updatedAt = '2026-05-05T00:00:00.000Z';
    const manifests = await refreshStoredManifests(homeDir, {
      all: true,
      now: updatedAt
    });

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.skills.welcome.local_hash).not.toBeNull();
    expect(manifests[0]?.skills.welcome.remote_hash).toBe('22222222222222222222222222222222');
    expect(transportModule.refreshRemoteManifestFromServer).toHaveBeenCalled();
  });

  it('rebuildRemoteManifestFromHashes uses real remote hashes as source of truth', () => {
    const manifest = createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z');
    manifest.skills.docs = {
      local_hash: null,
      remote_hash: 'old-docs',
      recorded_hash: 'old-docs',
      direction: 'skip',
      status: 'in-sync'
    };
    manifest.skills.stale = {
      local_hash: null,
      remote_hash: 'stale-hash',
      recorded_hash: 'stale-hash',
      direction: 'skip',
      status: 'in-sync'
    };

    expect(
      rebuildRemoteManifestFromHashes(
        manifest,
        {
          docs: 'new-docs',
          welcome: 'new-welcome'
        },
        '2026-05-02T00:00:00.000Z'
      )
    ).toEqual({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        docs: {
          local_hash: null,
          remote_hash: 'new-docs',
          recorded_hash: 'old-docs',
          direction: 'pull',
          status: 'remote-changed'
        },
        welcome: {
          local_hash: null,
          remote_hash: 'new-welcome',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });
  });

  it('refreshStoredManifests rewrites a selected remote manifest from real remote hashes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-refresh-'));
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

    expect(manifests).toEqual([
      {
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
      }
    ]);
    await expect(loadTrackedManifests(homeDir, 'alpha')).resolves.toEqual(manifests);
  });

  it('formats status and diff lines from reconciled manifest data', () => {
    const manifest = {
      version: 1 as const,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        same: {
          local_hash: '111',
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'skip' as const,
          status: 'in-sync' as const
        },
        pushy: {
          local_hash: '222',
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push' as const,
          status: 'local-changed' as const
        },
        pully: {
          local_hash: null,
          remote_hash: '333',
          recorded_hash: null,
          direction: 'pull' as const,
          status: 'new' as const
        }
      }
    };

    expect(formatStatusLines([manifest])).toEqual([
      'pully\talpha\tpull\tnew',
      'pushy\talpha\tpush\tlocal-changed',
      'same\talpha\tskip\tin-sync'
    ]);

    expect(formatDiffLines(manifest)).toEqual([
      'pully\tpull\t-\t333\t-',
      'pushy\tpush\t222\t111\t111'
    ]);
  });
});
