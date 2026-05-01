import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config.js';
import { listSources, loadSourceState, materializeSource } from '../src/source.js';

describe('source module', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('listSources normalizes valid source entries and sorts them by name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          zeta: { type: 'git', url: '/tmp/zeta.git', store: 'skills', ref: 'main' },
          alpha: { type: 'local', url: '/tmp/local-skills', store: '.' },
          broken: { type: 'git' }
        }
      },
      homeDir
    );

    await expect(listSources(homeDir)).resolves.toEqual([
      {
        name: 'alpha',
        type: 'local',
        url: '/tmp/local-skills',
        store: '.'
      },
      {
        name: 'zeta',
        type: 'git',
        url: '/tmp/zeta.git',
        store: 'skills',
        ref: 'main'
      }
    ]);
  });

  it('materializeSource symlinks local-source skills into the sync store and records state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha', 'beta']);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceRoot, 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha', 'beta'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource removes stale local-source skills from a previous state file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'beta'), { recursive: true, force: true });
    await mkdir(join(sourceRoot, 'gamma'), { recursive: true });
    await writeFile(join(sourceRoot, 'gamma', 'SKILL.md'), '# gamma\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['gamma']);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['gamma'],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
    await expect(access(join(homeDir, '.syncskill', 'skills', 'beta'))).rejects.toThrow();
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'gamma'))).resolves.toBe(join(sourceRoot, 'gamma'));
  });

  it('materializeSource keeps a stale skill path when it is no longer the source-owned symlink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    const foreignRoot = join(homeDir, 'foreign');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(foreignRoot, 'SKILL.md'), '# foreign\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await rm(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true, force: true });
    await symlink(foreignRoot, join(homeDir, '.syncskill', 'skills', 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual([]);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(foreignRoot);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: [],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
  });

  it('materializeSource preserves a relative symlink that no longer belongs to the source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    const foreignRoot = join(homeDir, 'foreign');
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(foreignRoot, 'SKILL.md'), '# foreign\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await rm(join(skillsDir, 'alpha'), { recursive: true, force: true });
    await symlink('../../foreign', join(skillsDir, 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual([]);
    await expect(readlink(join(skillsDir, 'alpha'))).resolves.toBe('../../foreign');
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: [],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
  });

  it('materializeSource rejects a local store path outside the source root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(sourceRoot, { recursive: true });

    await expect(
      materializeSource(homeDir, 'shared', { type: 'local', url: sourceRoot, store: '../outside' }, '2026-05-01T00:00:00.000Z')
    ).rejects.toThrow('Local source store must stay within the source root');
  });
});
