import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  createDefaultConfig,
  detectAgents,
  expandTargetAgents,
  getConfiguredServer,
  getSyncDir,
  getSyncPaths,
  loadConfig,
  saveConfig,
  validateConfig
} from '../../src/config/config.js';
import { useTempDirs } from '../helpers/temp-dir.js';

describe('config path helpers', () => {
  it('returns the sync directory for a home directory', () => {
    expect(getSyncDir('/tmp/demo-home')).toBe('/tmp/demo-home/.syncskill');
  });

  it('returns all sync paths for a home directory', () => {
    expect(getSyncPaths('/tmp/demo-home')).toEqual({
      syncDir: '/tmp/demo-home/.syncskill',
      configFile: '/tmp/demo-home/.syncskill/config.json',
      skillsDir: '/tmp/demo-home/.syncskill/skills',
      manifestsDir: '/tmp/demo-home/.syncskill/manifests',
      tempDir: '/tmp/demo-home/.syncskill/.tmp',
      historyFile: '/tmp/demo-home/.syncskill/manifest_history.json',
      backupsDir: '/tmp/demo-home/.syncskill/backups'
    });
  });

  it('should return config.json as configFile', () => {
    const paths = getSyncPaths('/home/test');
    expect(paths.configFile).toBe('/home/test/.syncskill/config.json');
  });
});

describe('detectAgents', () => {
  const tempDirs = useTempDirs();

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
  const tempDirs = useTempDirs();

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
      },
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
    };

    await saveConfig(config, homeDir);

    await expect(loadConfig(homeDir)).resolves.toEqual(config);
  });

  it('should load config from JSON file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
    const syncDir = join(tempDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const config = { version: 1, agents: {}, links: {}, servers: {}, sources: {} };
    await writeFile(join(syncDir, 'config.json'), JSON.stringify(config));

    const loaded = await loadConfig(tempDir);
    expect(loaded.version).toBe(1);

    await rm(tempDir, { recursive: true });
  });

  it('should fall back to YAML if JSON not found', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
    const syncDir = join(tempDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const config = { version: 1, agents: {}, links: {}, servers: {}, sources: {} };
    await writeFile(join(syncDir, 'config.yaml'), YAML.stringify(config));

    const loaded = await loadConfig(tempDir);
    expect(loaded.version).toBe(1);

    await rm(tempDir, { recursive: true });
  });

  it('should fall back to YAML if config.json contains YAML content from migration period', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
    const syncDir = join(tempDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const config = { version: 1, agents: {}, links: {}, servers: {}, sources: {} };
    await writeFile(join(syncDir, 'config.json'), YAML.stringify(config));
    await writeFile(join(syncDir, 'config.yaml'), YAML.stringify(config));

    const loaded = await loadConfig(tempDir);
    expect(loaded.version).toBe(1);

    await rm(tempDir, { recursive: true });
  });

  describe('saveConfig', () => {
    it('should save config as JSON', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
      const syncDir = join(tempDir, '.syncskill');
      await mkdir(syncDir, { recursive: true });

      const config = createDefaultConfig(tempDir, {});
      await saveConfig(config, tempDir);

      const jsonPath = join(syncDir, 'config.json');
      const content = await readFile(jsonPath, 'utf8');
      expect(JSON.parse(content).version).toBe(1);

      await rm(tempDir, { recursive: true });
    });

    it('should migrate YAML to JSON on save', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
      const syncDir = join(tempDir, '.syncskill');
      await mkdir(syncDir, { recursive: true });

      const yamlPath = join(syncDir, 'config.yaml');
      await writeFile(yamlPath, YAML.stringify({ version: 1, agents: {}, links: {} }));

      const config = await loadConfig(tempDir);
      await saveConfig(config, tempDir);

      const jsonPath = join(syncDir, 'config.json');
      await expect(access(yamlPath)).rejects.toThrow();
      const content = await readFile(jsonPath, 'utf8');
      expect(JSON.parse(content).version).toBe(1);

      await rm(tempDir, { recursive: true });
    });
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
      sources: {},
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
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
      sources: {},
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
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

describe('private_agents config', () => {
  const tempDirs = useTempDirs();

  it('should use default private_agents when not configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {}
      },
      homeDir
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
    });
  });

  it('should override default private_agents when configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {},
        private_agents: ['cursor', 'my-custom-agent']
      },
      homeDir
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      private_agents: ['cursor', 'my-custom-agent']
    });
  });
});

describe('getConfiguredServer', () => {
  it('normalizes host, auth fields, and remote agent mappings', () => {
    const config = validateConfig({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {
        alpha: {
          host: 'alpha.example.com',
          user: 'deploy',
          port: 2222,
          identity_file: '/Users/demo/.ssh/id_syncskill',
          remote_agents: {
            claude: '~/.claude/skills',
            qoder: '~/.qoder/skills',
            broken: 123
          }
        },
        broken: {
          user: 'deploy'
        }
      },
      sources: {}
    });

    expect(getConfiguredServer(config, 'alpha')).toEqual({
      name: 'alpha',
      host: 'alpha.example.com',
      user: 'deploy',
      port: 2222,
      identity_file: '/Users/demo/.ssh/id_syncskill',
      remote_agents: {
        claude: '~/.claude/skills',
        qoder: '~/.qoder/skills'
      }
    });
    expect(() => getConfiguredServer(config, 'broken')).toThrow('Server config is invalid: broken');
    expect(() => getConfiguredServer(config, 'missing')).toThrow('Server not found: missing');
  });
});
