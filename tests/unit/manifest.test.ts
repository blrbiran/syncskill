import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { getSyncPaths } from '../../src/config/config.js';
import {
  applyRemoteSnapshot,
  buildLocalSkillHashes,
  collectRemoteHistoryEntries,
  createEmptyManifest,
  finalizePulledSkills,
  finalizePushedSkills,
  hashSkillDirectory,
  loadManifestHistory,
  loadServerManifest,
  refreshLocalManifest,
  saveManifestHistory,
  saveServerManifest
} from '../../src/core/manifest.js';

describe('manifest hashing', () => {
  const tempDirs = useTempDirs();

  it('hashSkillDirectory sorts relative paths and ignores symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const skillDir = join(homeDir, '.syncskill', 'skills', 'demo');
    await mkdir(join(skillDir, 'b'), { recursive: true });
    await mkdir(join(skillDir, 'a'), { recursive: true });
    await writeFile(join(skillDir, 'b', 'second.txt'), 'second', 'utf8');
    await writeFile(join(skillDir, 'a', 'first.txt'), 'first', 'utf8');
    await symlink(join(skillDir, 'a', 'first.txt'), join(skillDir, 'link.txt'));

    const withSymlink = await hashSkillDirectory(skillDir);

    await rm(join(skillDir, 'link.txt'));

    const withoutSymlink = await hashSkillDirectory(skillDir);

    expect(withSymlink).toMatch(/^[a-f0-9]{32}$/);
    expect(withSymlink).toBe(withoutSymlink);
  });

  it('buildLocalSkillHashes returns hashes for all local skills in name order', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await mkdir(join(skillsDir, 'ops'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome', 'utf8');
    await writeFile(join(skillsDir, 'ops', 'SKILL.md'), '# ops', 'utf8');

    const hashes = await buildLocalSkillHashes(homeDir);

    expect(Object.keys(hashes)).toEqual(['ops', 'welcome']);
    expect(hashes.ops).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.welcome).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.ops).not.toBe(hashes.welcome);
  });

  it('loadServerManifest returns an empty manifest when the file is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    await expect(loadServerManifest(homeDir, 'dev')).resolves.toEqual({
      version: 1,
      server: 'dev',
      updated_at: expect.any(String),
      skills: {}
    });
  });

  it('loadServerManifest reads back a saved server manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const manifest = createEmptyManifest('dev', '2026-05-01T00:00:00.000Z');
    manifest.skills.welcome = {
      local_hash: '11111111111111111111111111111111',
      remote_hash: '22222222222222222222222222222222',
      recorded_hash: '33333333333333333333333333333333',
      direction: 'push',
      status: 'local-changed'
    };

    await saveServerManifest(homeDir, manifest);

    await expect(loadServerManifest(homeDir, 'dev')).resolves.toEqual(manifest);
  });

  it('loadManifestHistory normalizes malformed history input to empty entries', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    await saveManifestHistory(homeDir, {
      version: 1,
      entries: [
        {
          skill: 'welcome',
          server: 'local',
          old_hash: '11111111111111111111111111111111',
          new_hash: '22222222222222222222222222222222',
          direction: 'local',
          updated_at: '2026-05-01T00:00:00.000Z'
        }
      ]
    });

    const { historyFile } = getSyncPaths(homeDir);
    await writeFile(
      historyFile,
      `${JSON.stringify({ version: 1, entries: [{ skill: 'broken' }, 'bad-entry', null] }, null, 2)}\n`,
      'utf8'
    );

    await expect(loadManifestHistory(homeDir)).resolves.toEqual({
      version: 1,
      entries: []
    });
  });

  it('refreshLocalManifest saves local hashes and appends history only when a hash changes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome', 'utf8');

    const first = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T00:00:00.000Z');
    expect(first.skills.welcome.local_hash).toMatch(/^[a-f0-9]{32}$/);

    const afterFirstHistory = await loadManifestHistory(homeDir);
    expect(afterFirstHistory.entries).toEqual([]);

    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome changed', 'utf8');

    const second = await refreshLocalManifest(homeDir, 'dev', '2026-05-01T01:00:00.000Z');
    const history = await loadManifestHistory(homeDir);

    expect(second.skills.welcome.local_hash).not.toBe(first.skills.welcome.local_hash);
    expect(history.entries).toEqual([
      {
        skill: 'welcome',
        server: 'local',
        old_hash: first.skills.welcome.local_hash,
        new_hash: second.skills.welcome.local_hash,
        direction: 'local',
        updated_at: '2026-05-01T01:00:00.000Z'
      }
    ]);
  });

  it('applyRemoteSnapshot merges remote hashes into an existing manifest', () => {
    const previous = {
      ...createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'),
      skills: {
        welcome: {
          local_hash: 'local-1',
          remote_hash: 'remote-1',
          recorded_hash: 'remote-1',
          direction: 'push' as const,
          status: 'local-changed' as const
        }
      }
    };

    expect(
      applyRemoteSnapshot(previous, { welcome: 'remote-2', docs: 'remote-3' }, '2026-05-01T01:00:00.000Z')
    ).toEqual({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T01:00:00.000Z',
      skills: {
        docs: {
          local_hash: null,
          remote_hash: 'remote-3',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        },
        welcome: {
          local_hash: 'local-1',
          remote_hash: 'remote-2',
          recorded_hash: 'remote-1',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });
  });

  it('collectRemoteHistoryEntries records only actual remote hash changes', () => {
    const previous = {
      ...createEmptyManifest('alpha', '2026-05-01T00:00:00.000Z'),
      skills: {
        welcome: {
          local_hash: 'local-1',
          remote_hash: 'remote-1',
          recorded_hash: 'remote-1',
          direction: 'skip' as const,
          status: 'in-sync' as const
        }
      }
    };
    const next = applyRemoteSnapshot(previous, { welcome: 'remote-2', docs: 'remote-3' }, '2026-05-01T01:00:00.000Z');

    expect(collectRemoteHistoryEntries(previous, next, '2026-05-01T01:00:00.000Z')).toEqual([
      {
        skill: 'docs',
        server: 'alpha',
        old_hash: null,
        new_hash: 'remote-3',
        direction: 'remote',
        updated_at: '2026-05-01T01:00:00.000Z'
      },
      {
        skill: 'welcome',
        server: 'alpha',
        old_hash: 'remote-1',
        new_hash: 'remote-2',
        direction: 'remote',
        updated_at: '2026-05-01T01:00:00.000Z'
      }
    ]);
  });

  it('finalizePushedSkills promotes local hashes to the shared baseline', () => {
    const manifest = finalizePushedSkills(
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T01:00:00.000Z',
        skills: {
          welcome: {
            local_hash: 'local-2',
            remote_hash: 'remote-1',
            recorded_hash: 'remote-1',
            direction: 'push',
            status: 'local-changed'
          }
        }
      },
      ['welcome'],
      '2026-05-01T02:00:00.000Z'
    );

    expect(manifest.skills.welcome).toEqual({
      local_hash: 'local-2',
      remote_hash: 'local-2',
      recorded_hash: 'local-2',
      direction: 'skip',
      status: 'in-sync'
    });
  });

  it('finalizePulledSkills promotes remote hashes to the shared baseline', () => {
    const manifest = finalizePulledSkills(
      {
        version: 1,
        server: 'alpha',
        updated_at: '2026-05-01T01:00:00.000Z',
        skills: {
          welcome: {
            local_hash: 'local-1',
            remote_hash: 'remote-2',
            recorded_hash: 'local-1',
            direction: 'pull',
            status: 'remote-changed'
          }
        }
      },
      ['welcome'],
      '2026-05-01T02:00:00.000Z'
    );

    expect(manifest.skills.welcome).toEqual({
      local_hash: 'remote-2',
      remote_hash: 'remote-2',
      recorded_hash: 'remote-2',
      direction: 'skip',
      status: 'in-sync'
    });
  });
});
