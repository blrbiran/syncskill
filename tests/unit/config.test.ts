import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

const fsHarness = vi.hoisted(() => ({
  failure: undefined as { operation: 'write' | 'sync' | 'rename'; error: Error } | undefined,
  failCloseAndCleanup: false,
  collide: false,
  syncCalls: 0
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsHarness.collide) await actual.writeFile(args[0], 'preexisting staging file', { flag: 'wx' });
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);

      handle.writeFile = async (...writeArgs) => {
        if (fsHarness.failure?.operation === 'write') {
          await write('{');
          throw fsHarness.failure.error;
        }
        await write(...writeArgs);
      };
      handle.sync = async () => {
        fsHarness.syncCalls += 1;
        if (fsHarness.failure?.operation === 'sync') throw fsHarness.failure.error;
        await sync();
      };
      handle.close = async () => {
        await close();
        if (fsHarness.failCloseAndCleanup) throw new Error('injected close failure');
      };

      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsHarness.failure?.operation === 'rename') throw fsHarness.failure.error;
      await actual.rename(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsHarness.failCloseAndCleanup) throw new Error('injected cleanup failure');
      await actual.unlink(...args);
    }
  };
});

afterEach(() => {
  fsHarness.failure = undefined;
  fsHarness.failCloseAndCleanup = false;
  fsHarness.collide = false;
});

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
      backupsDir: '/tmp/demo-home/.syncskill/.backups',
      historyFile: '/tmp/demo-home/.syncskill/manifest_history.json'
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
      profiles: {},
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
    };

    await saveConfig(config, homeDir);

    await expect(loadConfig(homeDir)).resolves.toEqual(config);
  });

  it('a write round-trip keeps ssh_defaults and an unknown future key (#490)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    const { syncDir, configFile } = getSyncPaths(homeDir);
    await mkdir(syncDir, { recursive: true });

    const baseCfg = {
      ...createDefaultConfig(homeDir, {}),
      ssh_defaults: { port: 2200 },
      future_key: { a: 1 }
    };
    await writeFile(configFile, JSON.stringify(baseCfg), 'utf8');

    const config = await loadConfig(homeDir);
    await saveConfig(config, homeDir);

    const after = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    expect(after.ssh_defaults).toEqual({ port: 2200 });
    expect(after.future_key).toEqual({ a: 1 });
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

  it('treats YAML placed in config.json as corrupt instead of falling back (#489)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
    const syncDir = join(tempDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const config = { version: 1, agents: {}, links: {}, servers: {}, sources: {} };
    await writeFile(join(syncDir, 'config.json'), YAML.stringify(config));
    await writeFile(join(syncDir, 'config.yaml'), YAML.stringify(config));

    await expect(loadConfig(tempDir)).rejects.toThrow(/E_CONFIG_CORRUPT/);

    await rm(tempDir, { recursive: true });
  });

  it('a truncated config.json is reported as corrupt, not as missing (#489)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
    const syncDir = join(tempDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const configPath = join(syncDir, 'config.json');
    await writeFile(configPath, '{"version":1,"agents":', 'utf8');

    await expect(loadConfig(tempDir)).rejects.toThrow(
      `E_CONFIG_CORRUPT: ${configPath} is not valid JSON; the previous copy is at ${configPath}.bak. Do not run \`init\`: it would overwrite it.`
    );
    await expect(loadConfig(tempDir)).rejects.not.toThrow(/Config not found/);

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

    it('writes through a fsync\'d 0600 temp file and leaves no .bak on the first write (#489)', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
      const syncDir = join(tempDir, '.syncskill');
      const jsonPath = join(syncDir, 'config.json');

      fsHarness.syncCalls = 0;
      await saveConfig(createDefaultConfig(tempDir, {}), tempDir);

      expect((await stat(jsonPath)).mode & 0o777).toBe(0o600);
      expect(fsHarness.syncCalls).toBe(1);
      expect(existsSync(`${jsonPath}.bak`)).toBe(false);

      await rm(tempDir, { recursive: true });
    });

    it('keeps the previous config in config.json.bak on the next write (#489)', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-'));
      const syncDir = join(tempDir, '.syncskill');
      const jsonPath = join(syncDir, 'config.json');

      const first = createDefaultConfig(tempDir, {});
      await saveConfig(first, tempDir);

      const second = { ...first, conflict_resolution: 'keep-local' as const };
      await saveConfig(second, tempDir);

      expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual(second);
      expect(JSON.parse(await readFile(`${jsonPath}.bak`, 'utf8'))).toEqual(first);

      await rm(tempDir, { recursive: true });
    });

    it.each(['write', 'sync', 'rename'] as const)('cleans up its staging file when %s fails (#489)', async (operation) => {
      const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
      tempDirs.push(homeDir);
      const { syncDir, configFile } = getSyncPaths(homeDir);
      const first = createDefaultConfig(homeDir, {});
      await saveConfig(first, homeDir);
      const previous = await readFile(configFile, 'utf8');
      const error = new Error(`injected ${operation} failure`);

      fsHarness.failure = { operation, error };
      await expect(saveConfig({ ...first, conflict_resolution: 'keep-remote' }, homeDir)).rejects.toBe(error);

      expect(await readFile(configFile, 'utf8')).toBe(previous);
      expect((await readdir(syncDir)).sort()).toEqual(
        operation === 'rename' ? ['config.json', 'config.json.bak'] : ['config.json']
      );
      if (operation === 'rename') expect(await readFile(`${configFile}.bak`, 'utf8')).toBe(previous);
    });

    it('cleans up only its own staging file when the backup copy fails (#489)', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
      tempDirs.push(homeDir);
      const { syncDir, configFile } = getSyncPaths(homeDir);
      const first = createDefaultConfig(homeDir, {});
      await saveConfig(first, homeDir);
      const previous = await readFile(configFile, 'utf8');
      await mkdir(`${configFile}.bak`);
      await writeFile(`${configFile}.tmp-preexisting`, 'other write');

      await expect(saveConfig({ ...first, conflict_resolution: 'keep-remote' }, homeDir)).rejects.toMatchObject({
        code: 'EISDIR',
        syscall: 'copyfile'
      });

      expect(await readFile(configFile, 'utf8')).toBe(previous);
      expect((await readdir(syncDir)).sort()).toEqual(['config.json', 'config.json.bak', 'config.json.tmp-preexisting']);
      expect(await readFile(`${configFile}.tmp-preexisting`, 'utf8')).toBe('other write');
      expect((await stat(`${configFile}.bak`)).isDirectory()).toBe(true);
    });

    it('preserves a staging file it did not create when exclusive open fails (#489)', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
      tempDirs.push(homeDir);
      const { syncDir } = getSyncPaths(homeDir);

      fsHarness.collide = true;
      await expect(saveConfig(createDefaultConfig(homeDir, {}), homeDir)).rejects.toMatchObject({ code: 'EEXIST' });

      const files = await readdir(syncDir);
      expect(files).toEqual([expect.stringMatching(/^config\.json\.tmp-/)]);
      expect(await readFile(join(syncDir, files[0]), 'utf8')).toBe('preexisting staging file');
    });

    it('preserves the write error if closing or removing the staging file also fails (#489)', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
      tempDirs.push(homeDir);
      const error = new Error('injected write failure');

      fsHarness.failure = { operation: 'write', error };
      fsHarness.failCloseAndCleanup = true;
      await expect(saveConfig(createDefaultConfig(homeDir, {}), homeDir)).rejects.toBe(error);
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
      profiles: {},
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
      profiles: {},
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
          remote_repo: '/srv/syncskill',
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
      remote_repo: '/srv/syncskill',
      remote_agents: {
        claude: '~/.claude/skills',
        qoder: '~/.qoder/skills'
      }
    });
    expect(() => getConfiguredServer(config, 'broken')).toThrow('Server config is invalid: broken');
    expect(() => getConfiguredServer(config, 'missing')).toThrow('Server not found: missing');
  });
});
