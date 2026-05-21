import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSkillsRegistry,
  saveSkillsRegistry,
  loadSkillsRegistryV2,
  saveSkillsRegistryV2,
  normalizeSkillsRegistry,
  getSkillsRegistryPath,
  isSkillIgnored,
  isSkillActive,
  getActiveSkills,
  getIgnoredSkills,
  addActiveSkill,
  addIgnoredSkill,
  removeSkill,
  activateSkill,
  ignoreSkill,
  rebuildSkillsRegistry,
  createEmptyRegistryV2,
  isSkillIgnoredV2,
  ignoreSkillV2,
  unignoreSkillV2,
  setHttpBaselineV2,
  getHttpBaselineV2,
  removeHttpBaselineV2,
} from '../../src/core/skills-registry.js';
import type { SkillsRegistryV2 } from '../../src/core/skills-registry.js';

describe('skills-registry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `skills-registry-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads empty registry when none exists', async () => {
    const registry = await loadSkillsRegistry(tempDir);
    expect(registry.version).toBe(1);
    expect(registry.skills).toEqual({});
  });

  it('saves and loads active skills', async () => {
    let registry = await loadSkillsRegistry(tempDir);
    registry = addActiveSkill(registry, 'test-skill', {
      path: '/path/to/skill',
      origin: 'manual',
      type: 'manual',
    });

    await saveSkillsRegistry(tempDir, registry);
    const loaded = await loadSkillsRegistry(tempDir);

    expect(isSkillActive(loaded, 'test-skill')).toBe(true);
    expect(isSkillIgnored(loaded, 'test-skill')).toBe(false);
    expect(loaded.skills['test-skill'].status).toBe('active');
  });

  it('saves and loads ignored skills', async () => {
    let registry = await loadSkillsRegistry(tempDir);
    registry = addIgnoredSkill(registry, 'test-skill', {
      path: '/path/to/skill',
      origin: 'my-source',
      type: 'git',
      ignored_reason: 'duplicate',
      kept_by: '/path/to/other',
    });

    await saveSkillsRegistry(tempDir, registry);
    const loaded = await loadSkillsRegistry(tempDir);

    expect(isSkillIgnored(loaded, 'test-skill')).toBe(true);
    expect(isSkillActive(loaded, 'test-skill')).toBe(false);
    expect(loaded.skills['test-skill'].ignored_reason).toBe('duplicate');
    expect(loaded.skills['test-skill'].kept_by).toBe('/path/to/other');
    expect(loaded.skills['test-skill'].ignored_at).toBeDefined();
  });

  it('removes skill from registry', () => {
    let registry = addActiveSkill(
      { version: 1, skills: {} },
      'test-skill',
      { path: '/path', origin: 'manual', type: 'manual' }
    );

    expect(isSkillActive(registry, 'test-skill')).toBe(true);

    registry = removeSkill(registry, 'test-skill');

    expect(isSkillActive(registry, 'test-skill')).toBe(false);
    expect('test-skill' in registry.skills).toBe(false);
  });

  it('activates ignored skill', () => {
    let registry = addIgnoredSkill(
      { version: 1, skills: {} },
      'test-skill',
      { path: '/path', origin: 'src', type: 'git', ignored_reason: 'user-choice' }
    );

    expect(isSkillIgnored(registry, 'test-skill')).toBe(true);

    registry = activateSkill(registry, 'test-skill');

    expect(isSkillActive(registry, 'test-skill')).toBe(true);
    expect(isSkillIgnored(registry, 'test-skill')).toBe(false);
    expect(registry.skills['test-skill'].ignored_reason).toBeUndefined();
    expect(registry.skills['test-skill'].ignored_at).toBeUndefined();
  });

  it('ignores active skill', () => {
    let registry = addActiveSkill(
      { version: 1, skills: {} },
      'test-skill',
      { path: '/path', origin: 'manual', type: 'manual' }
    );

    expect(isSkillActive(registry, 'test-skill')).toBe(true);

    registry = ignoreSkill(registry, 'test-skill', 'user-choice');

    expect(isSkillIgnored(registry, 'test-skill')).toBe(true);
    expect(registry.skills['test-skill'].ignored_reason).toBe('user-choice');
    expect(registry.skills['test-skill'].ignored_at).toBeDefined();
  });

  it('gets active skills only', () => {
    let registry: ReturnType<typeof loadSkillsRegistry> extends Promise<infer R> ? R : never = { version: 1, skills: {} };
    registry = addActiveSkill(registry, 'active-1', { path: '/a', origin: 'manual', type: 'manual' });
    registry = addActiveSkill(registry, 'active-2', { path: '/b', origin: 'src', type: 'git' });
    registry = addIgnoredSkill(registry, 'ignored-1', { path: '/c', origin: 'src', type: 'git', ignored_reason: 'duplicate' });

    const active = getActiveSkills(registry);

    expect(Object.keys(active)).toEqual(['active-1', 'active-2']);
    expect('ignored-1' in active).toBe(false);
  });

  it('gets ignored skills only', () => {
    let registry: ReturnType<typeof loadSkillsRegistry> extends Promise<infer R> ? R : never = { version: 1, skills: {} };
    registry = addActiveSkill(registry, 'active-1', { path: '/a', origin: 'manual', type: 'manual' });
    registry = addIgnoredSkill(registry, 'ignored-1', { path: '/b', origin: 'src', type: 'git', ignored_reason: 'duplicate' });
    registry = addIgnoredSkill(registry, 'ignored-2', { path: '/c', origin: 'src', type: 'git', ignored_reason: 'user-choice' });

    const ignored = getIgnoredSkills(registry);

    expect(Object.keys(ignored)).toEqual(['ignored-1', 'ignored-2']);
    expect('active-1' in ignored).toBe(false);
  });

  it('returns empty registry when file contains invalid JSON', async () => {
    const path = getSkillsRegistryPath(tempDir);
    await writeFile(path, 'this is not valid json{{{', 'utf8');

    const registry = await loadSkillsRegistry(tempDir);

    expect(registry.version).toBe(1);
    expect(registry.skills).toEqual({});
  });

  it('saves registry to directory that does not exist yet', async () => {
    const newTempDir = join(tmpdir(), `skills-registry-new-${Date.now()}`);

    const registry = addActiveSkill(
      { version: 1, skills: {} },
      'test-skill',
      { path: '/path', origin: 'manual', type: 'manual' }
    );

    await saveSkillsRegistry(newTempDir, registry);
    const loaded = await loadSkillsRegistry(newTempDir);

    expect(isSkillActive(loaded, 'test-skill')).toBe(true);

    await rm(newTempDir, { recursive: true, force: true });
  });
});

describe('skills-registry v2 types', () => {
  it('accepts valid v2 registry', () => {
    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: {
        'old-skill': {
          reason: 'user-choice',
          ignored_at: '2026-05-21T00:00:00.000Z'
        }
      },
      http_baselines: {
        'my-skill': {
          hash: 'abc123',
          source: 'my-http-source'
        }
      }
    };

    expect(registry.version).toBe(2);
    expect(registry.ignored['old-skill'].reason).toBe('user-choice');
    expect(registry.http_baselines['my-skill'].hash).toBe('abc123');
  });
});

describe('v2 registry helpers', () => {
  it('isSkillIgnoredV2 returns true for ignored skills', () => {
    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: { 'skill-a': { reason: 'user-choice', ignored_at: '2026-05-21T00:00:00Z' } },
      http_baselines: {}
    };

    expect(isSkillIgnoredV2(registry, 'skill-a')).toBe(true);
    expect(isSkillIgnoredV2(registry, 'skill-b')).toBe(false);
  });

  it('ignoreSkillV2 adds skill to ignored', () => {
    const registry = createEmptyRegistryV2();
    const updated = ignoreSkillV2(registry, 'skill-a', 'user-choice');

    expect(updated.ignored['skill-a'].reason).toBe('user-choice');
    expect(updated.ignored['skill-a'].ignored_at).toBeDefined();
  });

  it('unignoreSkillV2 removes skill from ignored', () => {
    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: { 'skill-a': { reason: 'user-choice', ignored_at: '2026-05-21T00:00:00Z' } },
      http_baselines: {}
    };

    const updated = unignoreSkillV2(registry, 'skill-a');
    expect(updated.ignored['skill-a']).toBeUndefined();
  });

  it('setHttpBaselineV2 sets baseline hash', () => {
    const registry = createEmptyRegistryV2();
    const updated = setHttpBaselineV2(registry, 'skill-a', 'abc123', 'my-source');

    expect(updated.http_baselines['skill-a'].hash).toBe('abc123');
    expect(updated.http_baselines['skill-a'].source).toBe('my-source');
  });

  it('getHttpBaselineV2 returns baseline or null', () => {
    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: {},
      http_baselines: { 'skill-a': { hash: 'abc', source: 'src1' } }
    };

    expect(getHttpBaselineV2(registry, 'skill-a')).toEqual({ hash: 'abc', source: 'src1' });
    expect(getHttpBaselineV2(registry, 'skill-b')).toBeNull();
  });

  it('removeHttpBaselineV2 removes baseline', () => {
    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: {},
      http_baselines: { 'skill-a': { hash: 'abc', source: 'src1' } }
    };

    const updated = removeHttpBaselineV2(registry, 'skill-a');
    expect(updated.http_baselines['skill-a']).toBeUndefined();
  });
});

describe('loadSkillsRegistryV2', () => {
  it('loads v2 registry', async () => {
    const tempDir = join(tmpdir(), `registry-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });

    const registryPath = join(tempDir, '.syncskill', 'skills-registry.json');
    await writeFile(registryPath, JSON.stringify({
      version: 2,
      ignored: { 'skill-a': { reason: 'user-choice', ignored_at: '2026-05-21T00:00:00Z' } },
      http_baselines: { 'skill-b': { hash: 'abc', source: 'src1' } }
    }));

    const registry = await loadSkillsRegistryV2(tempDir);

    expect(registry.version).toBe(2);
    expect(registry.ignored['skill-a'].reason).toBe('user-choice');
    expect(registry.http_baselines['skill-b'].hash).toBe('abc');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty v2 registry when file not found', async () => {
    const tempDir = join(tmpdir(), `registry-test-${Date.now()}`);

    const registry = await loadSkillsRegistryV2(tempDir);

    expect(registry.version).toBe(2);
    expect(registry.ignored).toEqual({});
    expect(registry.http_baselines).toEqual({});
  });

  it('migrates v1 registry to v2', async () => {
    const tempDir = join(tmpdir(), `registry-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });

    const registryPath = join(tempDir, '.syncskill', 'skills-registry.json');
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      skills: {
        'active-skill': {
          path: '/path/to/skill',
          origin: 'my-source',
          type: 'http',
          status: 'active',
          last_update_hash: 'hash123'
        },
        'ignored-skill': {
          path: '/path/to/skill2',
          origin: 'git-source',
          type: 'git',
          status: 'ignored',
          ignored_reason: 'user-choice',
          ignored_at: '2026-05-21T00:00:00Z'
        }
      }
    }));

    const registry = await loadSkillsRegistryV2(tempDir);

    expect(registry.version).toBe(2);
    expect(registry.http_baselines['active-skill']).toEqual({
      hash: 'hash123',
      source: 'my-source'
    });
    expect(registry.ignored['ignored-skill'].reason).toBe('user-choice');

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('saveSkillsRegistryV2', () => {
  it('saves v2 registry', async () => {
    const tempDir = join(tmpdir(), `registry-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });

    const registry: SkillsRegistryV2 = {
      version: 2,
      ignored: { 'skill-a': { reason: 'user-choice', ignored_at: '2026-05-21T00:00:00Z' } },
      http_baselines: { 'skill-b': { hash: 'xyz', source: 'src1' } }
    };

    await saveSkillsRegistryV2(tempDir, registry);

    const loaded = await loadSkillsRegistryV2(tempDir);
    expect(loaded).toEqual(registry);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('normalizeSkillsRegistry', () => {
  it('returns empty registry for null input', () => {
    const result = normalizeSkillsRegistry(null);
    expect(result).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for non-object input', () => {
    expect(normalizeSkillsRegistry('string')).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsRegistry(123)).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsRegistry(undefined)).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry when version is not 1', () => {
    const result = normalizeSkillsRegistry({ version: 2, skills: {} });
    expect(result).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry when skills is null', () => {
    const result = normalizeSkillsRegistry({ version: 1, skills: null });
    expect(result).toEqual({ version: 1, skills: {} });
  });

  it('accepts valid registry structure', () => {
    const valid = {
      version: 1,
      skills: {
        'my-skill': { path: '/p', origin: 'manual', type: 'manual', status: 'active' }
      }
    };
    const result = normalizeSkillsRegistry(valid);
    expect(result).toEqual(valid);
  });
});

describe('rebuildSkillsRegistry', () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `registry-rebuild-test-${Date.now()}`);
    homeDir = testDir;
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(join(syncDir, 'skills', 'manual-skill'), { recursive: true });
    await writeFile(join(syncDir, 'skills', 'manual-skill', 'SKILL.md'), '# Manual');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('discovers manual skills from ~/.syncskill/skills/', async () => {
    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {}
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['manual-skill']).toBeDefined();
    expect(registry.skills['manual-skill'].origin).toBe('manual');
    expect(registry.skills['manual-skill'].type).toBe('manual');
    expect(registry.skills['manual-skill'].status).toBe('active');
  });

  it('discovers skills from configured sources', async () => {
    const sourcePath = join(testDir, 'my-source');
    await mkdir(join(sourcePath, 'source-skill'), { recursive: true });
    await writeFile(join(sourcePath, 'source-skill', 'SKILL.md'), '# Source Skill');

    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {
        'my-source': {
          type: 'local',
          path: sourcePath
        }
      }
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['source-skill']).toBeDefined();
    expect(registry.skills['source-skill'].origin).toBe('my-source');
    expect(registry.skills['source-skill'].type).toBe('local');
    expect(registry.skills['source-skill'].status).toBe('active');
  });

  it('marks ignored skills from source ignore list', async () => {
    const sourcePath = join(testDir, 'my-source');
    await mkdir(join(sourcePath, 'ignored-skill'), { recursive: true });
    await writeFile(join(sourcePath, 'ignored-skill', 'SKILL.md'), '# Ignored');

    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {
        'my-source': {
          type: 'local',
          path: sourcePath,
          ignore: ['ignored-skill']
        }
      }
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['ignored-skill']).toBeDefined();
    expect(registry.skills['ignored-skill'].status).toBe('ignored');
    expect(registry.skills['ignored-skill'].ignored_reason).toBe('user-choice');
  });

  it('manual skills take precedence over source skills with same name', async () => {
    // Manual skill already created in beforeEach as 'manual-skill'
    // Create a source skill with the same name
    const sourcePath = join(testDir, 'my-source');
    await mkdir(join(sourcePath, 'manual-skill'), { recursive: true });
    await writeFile(join(sourcePath, 'manual-skill', 'SKILL.md'), '# Source version');

    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {
        'my-source': {
          type: 'local',
          path: sourcePath
        }
      }
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    // Manual skill should win
    expect(registry.skills['manual-skill'].origin).toBe('manual');
    expect(registry.skills['manual-skill'].type).toBe('manual');
  });

  it('skips directories without SKILL.md', async () => {
    const sourcePath = join(testDir, 'my-source');
    await mkdir(join(sourcePath, 'not-a-skill'), { recursive: true });
    await writeFile(join(sourcePath, 'not-a-skill', 'README.md'), '# Not a skill');

    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {
        'my-source': {
          type: 'local',
          path: sourcePath
        }
      }
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['not-a-skill']).toBeUndefined();
  });

  it('computes last_update_hash for HTTP sources', async () => {
    // Create an HTTP source path with a skill
    const httpSourcePath = join(testDir, 'http-source');
    await mkdir(join(httpSourcePath, 'http-skill'), { recursive: true });
    await writeFile(join(httpSourcePath, 'http-skill', 'SKILL.md'), '# HTTP Skill');

    const config = {
      version: 1 as const,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {
        'my-http-source': {
          type: 'http',
          path: httpSourcePath,
          url: 'https://example.com/skills.zip'
        }
      }
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['http-skill']).toBeDefined();
    expect(registry.skills['http-skill'].type).toBe('http');
    expect(registry.skills['http-skill'].last_update_hash).toBeDefined();
    expect(typeof registry.skills['http-skill'].last_update_hash).toBe('string');
    expect(registry.skills['http-skill'].last_update_hash!.length).toBeGreaterThan(0);
  });
});
