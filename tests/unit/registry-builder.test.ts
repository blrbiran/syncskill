import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncSkillConfig } from '../../src/config/config.js';
import { rebuildRegistryV2 } from '../../src/core/registry-builder.js';

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

  it('skips non-http sources', async () => {
    const sourcePath = join(tempDir, 'local-source');
    const skillPath = join(sourcePath, 'local-skill');
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, 'SKILL.md'), '# Local Skill');

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      sources: {
        local: {
          type: 'local',
          path: sourcePath,
          url: sourcePath
        }
      },
      links: {},
      servers: {},
      private_agents: []
    };

    const registry = await rebuildRegistryV2(tempDir, config);

    expect(registry).toEqual({ version: 2, http_baselines: {} });
  });

  it('skips directories without SKILL.md', async () => {
    const sourcePath = join(tempDir, 'http-source');
    await mkdir(join(sourcePath, 'not-a-skill'), { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      sources: {
        remote: {
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

    expect(registry).toEqual({ version: 2, http_baselines: {} });
  });
});
