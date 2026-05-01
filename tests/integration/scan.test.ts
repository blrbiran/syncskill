import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { scanSkills } from '../../src/linker.js';

describe('scanSkills', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('adds missing discovered skills with empty targets by default', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        links: {
          existing: ['claude']
        }
      },
      homeDir
    );

    await mkdir(join(homeDir, '.syncskill', 'skills', 'zeta'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'existing'), { recursive: true });

    await expect(scanSkills(homeDir, { allAgents: false })).resolves.toEqual(['alpha', 'zeta']);
    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {
        existing: ['claude'],
        alpha: [],
        zeta: []
      },
      servers: {},
      sources: {}
    });
  });

  it('adds wildcard targets when all-agents is used', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'beta'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });

    await expect(scanSkills(homeDir, { allAgents: true })).resolves.toEqual(['alpha', 'beta']);
    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {
        alpha: ['*'],
        beta: ['*']
      },
      servers: {},
      sources: {}
    });
  });
});
