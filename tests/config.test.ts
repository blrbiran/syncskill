import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDefaultConfig,
  detectAgents,
  expandTargetAgents,
  getSyncDir,
  getSyncPaths,
  loadConfig,
  saveConfig,
  validateConfig
} from '../src/config.js';

describe('config path helpers', () => {
  it('returns the sync directory for a home directory', () => {
    expect(getSyncDir('/tmp/demo-home')).toBe('/tmp/demo-home/.syncskill');
  });

  it('returns all sync paths for a home directory', () => {
    expect(getSyncPaths('/tmp/demo-home')).toEqual({
      syncDir: '/tmp/demo-home/.syncskill',
      configFile: '/tmp/demo-home/.syncskill/config.yaml',
      skillsDir: '/tmp/demo-home/.syncskill/skills',
      manifestsDir: '/tmp/demo-home/.syncskill/manifests',
      tempDir: '/tmp/demo-home/.syncskill/.tmp',
      historyFile: '/tmp/demo-home/.syncskill/manifest_history.json'
    });
  });
});

describe('detectAgents', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns only known directories that exist as a record of full paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    const qoderSkillsDir = join(homeDir, '.qoder', 'skills');

    await mkdir(claudeSkillsDir, { recursive: true });
    await mkdir(qoderSkillsDir, { recursive: true });
    await mkdir(join(homeDir, '.unknown', 'skills'), { recursive: true });

    await expect(detectAgents(homeDir)).resolves.toEqual({
      claude: claudeSkillsDir,
      qoder: qoderSkillsDir
    });
  });
});

describe('config persistence', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('saves and loads a valid config with record-form agents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    const config = {
      version: 1,
      conflict_resolution: 'manual' as const,
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        qwen: join(homeDir, '.qwen', 'skills')
      },
      links: {
        demo: ['claude']
      },
      servers: {
        local: {
          url: 'http://localhost:3000'
        }
      },
      sources: {
        local: {
          path: '/tmp/source'
        }
      }
    };

    await saveConfig(config, homeDir);

    await expect(loadConfig(homeDir)).resolves.toEqual(config);
  });
});

describe('validateConfig', () => {
  it('rejects missing required top-level keys', () => {
    expect(() => validateConfig({ version: 1, links: {} })).toThrow(/agents/i);
    expect(() => validateConfig({ version: 1, agents: {}, links: undefined })).toThrow(/links/i);
    expect(() => validateConfig({ agents: {}, links: {} })).toThrow(/version/i);
  });

  it('normalizes and returns record-form agents', () => {
    expect(
      validateConfig({
        version: 1,
        conflict_resolution: 'manual',
        agents: {
          qwen: '/tmp/qwen',
          claude: '/tmp/claude',
          invalid: 123
        },
        links: {},
        servers: undefined,
        sources: undefined
      })
    ).toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        qwen: '/tmp/qwen',
        claude: '/tmp/claude'
      },
      links: {},
      servers: {},
      sources: {}
    });
  });

  it('creates the default config with record-form agents', () => {
    const agents = {
      claude: '/tmp/demo/.claude/skills'
    };

    expect(createDefaultConfig('/tmp/demo', agents)).toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents,
      links: {},
      servers: {},
      sources: {}
    });
  });
});

describe('expandTargetAgents', () => {
  it('expands wildcard links to all configured agents and leaves explicit targets alone', () => {
    const config = validateConfig({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        qwen: '/tmp/qwen',
        claude: '/tmp/claude',
        aone_copilot: '/tmp/aone'
      },
      links: {},
      servers: {},
      sources: {}
    });

    expect(expandTargetAgents(config, ['*'])).toEqual(['aone_copilot', 'claude', 'qwen']);
    expect(expandTargetAgents(config, ['qwen', 'claude', 'qwen'])).toEqual(['claude', 'qwen']);
  });
});
