import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rebuildRegistryV2 } from '../../src/core/registry-builder.js';
import type { SyncSkillConfig } from '../../src/config/config.js';

describe('registry-builder', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `registry-builder-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rebuilds http_baselines from HTTP sources', async () => {
    const sourcePath = join(tempDir, 'http-source');
    const skillPath = join(sourcePath, 'my-skill');
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, 'SKILL.md'), '# My Skill');
    await writeFile(join(skillPath, 'index.ts'), 'export const x = 1;');

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      sources: {
        'my-http-source': {
          type: 'http',
          url: 'https://example.com/skills.tar.gz',
          path: sourcePath
        }
      },
      links: {},
      servers: {},
      private_agents: []
    };

    const registry = await rebuildRegistryV2(tempDir, config);

    expect(registry.version).toBe(2);
    expect(registry.http_baselines['my-skill']).toBeDefined();
    expect(registry.http_baselines['my-skill'].source).toBe('my-http-source');
    expect(registry.http_baselines['my-skill'].hash).toBeDefined();
  });

  it('preserves existing ignored entries', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      sources: {},
      links: {},
      servers: {},
      private_agents: []
    };

    const existingIgnored = {
      'old-skill': { reason: 'user-choice' as const, ignored_at: '2026-05-21T00:00:00Z' }
    };

    const registry = await rebuildRegistryV2(tempDir, config, existingIgnored);

    expect(registry.ignored['old-skill']).toEqual(existingIgnored['old-skill']);
  });

  it('skips ignored skills when building http_baselines', async () => {
    const sourcePath = join(tempDir, 'http-source');
    const skill1Path = join(sourcePath, 'skill-1');
    const skill2Path = join(sourcePath, 'skill-2');
    await mkdir(skill1Path, { recursive: true });
    await mkdir(skill2Path, { recursive: true });
    await writeFile(join(skill1Path, 'SKILL.md'), '# Skill 1');
    await writeFile(join(skill2Path, 'SKILL.md'), '# Skill 2');

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      sources: {
        'my-http-source': {
          type: 'http',
          url: 'https://example.com/skills.tar.gz',
          path: sourcePath
        }
      },
      links: {},
      servers: {},
      private_agents: []
    };

    const existingIgnored = {
      'skill-1': { reason: 'user-choice' as const, ignored_at: '2026-05-21T00:00:00Z' }
    };

    const registry = await rebuildRegistryV2(tempDir, config, existingIgnored);

    expect(registry.http_baselines['skill-1']).toBeUndefined();
    expect(registry.http_baselines['skill-2']).toBeDefined();
  });
});
