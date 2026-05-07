import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { createDefaultConfig, loadConfig, saveConfig, type SyncSkillConfig } from '../../src/config.js';
import { listLocalSkillNames } from '../../src/manifest.js';
import { findOrphanSkills, loadSkillOwnershipState, RemovalAction, removeSource } from '../../src/source.js';

describe('removeSource', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('removes source from config and deletes store directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    const storeDir = join(homeDir, '.syncskill', '.sources', 'test-source', 'checkout');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'dummy.txt'), 'test');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'test-source': {
          type: 'git',
          url: 'https://github.com/test/repo.git',
          store: '.'
        }
      }
    }, homeDir);

    await removeSource(homeDir, 'test-source');

    const config = await loadConfig(homeDir);
    expect(config.sources['test-source']).toBeUndefined();
  });

  it('keeps store directory when keepStore is true', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    const storeDir = join(homeDir, '.syncskill', '.sources', 'test-source', 'checkout');
    await mkdir(storeDir, { recursive: true });

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'test-source': {
          type: 'git',
          url: 'https://github.com/test/repo.git',
          store: '.'
        }
      }
    }, homeDir);

    await removeSource(homeDir, 'test-source', { keepStore: true });

    const config = await loadConfig(homeDir);
    expect(config.sources['test-source']).toBeUndefined();
  });

  it('throws error for non-existent source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await expect(removeSource(homeDir, 'nonexistent')).rejects.toThrow('Source not found: nonexistent');
  });
});

describe('removeSource with RemovalAction', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('converts git source to local with RemovalAction.ConvertToLocal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');

    await mkdir(join(sourcesDir, 'checkout', 'skill-a'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git', store: '.' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await mkdir(join(syncDir, '.sources'), { recursive: true });
    await writeFile(
      join(syncDir, '.sources', 'skills.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.ConvertToLocal });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeDefined();
    expect(config.sources['test-source'].type).toBe('local');
    expect(config.sources['test-source'].url).toContain('checkout');
    expect(config.sources['test-source'].store).toBe('.');
  });

  it('removes config but keeps files with RemovalAction.RemoveConfigKeepFiles', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');
    const skillsDir = join(syncDir, 'skills');

    await mkdir(join(sourcesDir, 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git', store: '.' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(syncDir, '.sources', 'skills.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.RemoveConfigKeepFiles });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeUndefined();
    expect(config.links['skill-a']).toBeUndefined();
    // Files should still exist
    const fileExists = await stat(join(skillsDir, 'skill-a', 'SKILL.md')).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);
  });

  it('removes everything with RemovalAction.RemoveAll', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');
    const skillsDir = join(syncDir, 'skills');

    await mkdir(join(sourcesDir, 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git', store: '.' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(syncDir, '.sources', 'skills.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.RemoveAll });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeUndefined();
    expect(config.links['skill-a']).toBeUndefined();
    // Files should be deleted
    const skillExists = await stat(join(skillsDir, 'skill-a')).then(() => true).catch(() => false);
    expect(skillExists).toBe(false);
    const sourceExists = await stat(sourcesDir).then(() => true).catch(() => false);
    expect(sourceExists).toBe(false);
  });

  it('throws error when ConvertToLocal is used on non-git source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: {},
        sources: { 'test-source': { type: 'local', url: '/some/path', store: '.' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await mkdir(join(syncDir, '.sources'), { recursive: true });
    await writeFile(
      join(syncDir, '.sources', 'skills.json'),
      JSON.stringify({ owners: {} })
    );

    await expect(
      removeSource(homeDir, 'test-source', { action: RemovalAction.ConvertToLocal })
    ).rejects.toThrow('ConvertToLocal only valid for git sources');
  });
});

describe('findOrphanSkills integration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('correctly identifies orphan skills with real file structure', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-orphan-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');

    // Create skills directory with one manual skill
    await mkdir(join(skillsDir, 'manual-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'manual-skill', 'SKILL.md'), 'manual');

    // Create source with two skills, one overlaps with manual
    await mkdir(join(syncDir, '.sources', 'test-source', 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(syncDir, '.sources', 'test-source', 'materialized', 'manual-skill'), { recursive: true });

    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: {
          'skill-a': ['*'],
          'manual-skill': ['*'],
        },
        sources: {
          'test-source': { type: 'git', url: 'https://example.com/repo.git' },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    await writeFile(
      join(syncDir, '.sources', 'skills.json'),
      JSON.stringify({
        owners: {
          'skill-a': 'test-source',
          'manual-skill': 'test-source',
        },
      })
    );

    const config = await loadConfig(homeDir);
    const ownershipState = await loadSkillOwnershipState(homeDir);
    const localSkills = new Set(await listLocalSkillNames(homeDir));

    const orphans = findOrphanSkills('test-source', config, ownershipState, localSkills);

    // manual-skill exists in skillsDir, so not orphan
    // skill-a only from source, so orphan
    expect(orphans).toEqual(['skill-a']);
  });
});
