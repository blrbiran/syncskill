import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

const { mockCheckbox, mockConfirm } = vi.hoisted(() => ({
  mockCheckbox: vi.fn(),
  mockConfirm: vi.fn(),
}));

vi.mock('@inquirer/prompts', async () => {
  const actual = await vi.importActual<typeof import('@inquirer/prompts')>('@inquirer/prompts');
  return {
    ...actual,
    checkbox: mockCheckbox,
    confirm: mockConfirm,
  };
});

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { getSyncPaths } from '../../src/config/config.js';
import { loadServerManifest, saveServerManifest } from '../../src/core/manifest.js';
import { loadReceiverBackupIfExists } from '../../src/core/server.js';
import * as refreshModule from '../../src/refresh.js';
import * as transportModule from '../../src/core/transport.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createProgram } from '../../src/index.js';
import { getPullBackupDir } from '../../src/utils/backup.js';

describe('reconciliation CLI', () => {
  const tempDirs = useTempDirs();

  beforeEach(() => {
    mockCheckbox.mockReset();
    mockConfirm.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('status prints one row per skill and server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        deploy: {
          local_hash: null,
          remote_hash: '333',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        docs: {
          local_hash: null,
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'new'
        },
        welcome: {
          local_hash: '222',
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'status'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([
      ['docs\talpha\tpush\tlocal-changed'],
      ['welcome\talpha\tpush\tlocal-changed'],
      ['deploy\tbeta\tpull\tnew']
    ]);
  });

  it('status --json emits result event with hash triplet fields', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        deploy: {
          local_hash: null,
          remote_hash: '333',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        docs: {
          local_hash: null,
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'new'
        },
        welcome: {
          local_hash: '222',
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', 'status'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleLog.mock.calls[0][0]))).toEqual({
      type: 'result',
      command: 'status',
      ok: true,
      data_schema_version: 1,
      summary: {
        data: {
          servers: [
            {
              server: 'alpha',
              skills: [
                {
                  name: 'docs',
                  status: 'local-changed',
                  action: 'push',
                  local_hash: null,
                  remote_hash: '111',
                  baseline_hash: '111',
                  recorded_hash: '111'
                },
                {
                  name: 'welcome',
                  status: 'local-changed',
                  action: 'push',
                  local_hash: null,
                  remote_hash: '111',
                  baseline_hash: '111',
                  recorded_hash: '111'
                }
              ]
            },
            {
              server: 'beta',
              skills: [
                {
                  name: 'deploy',
                  status: 'new',
                  action: 'pull',
                  local_hash: null,
                  remote_hash: '333',
                  baseline_hash: null,
                  recorded_hash: null
                }
              ]
            }
          ]
        }
      }
    });
  });

  it('restore replaces the skill from pre-pull backup and keeps manifests in conflict before refresh', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    const syncPaths = getSyncPaths(homeDir);
    const skillDir = join(syncPaths.skillsDir, 'welcome');
    const backupDir = getPullBackupDir(homeDir, 'welcome');
    const preRestoreDir = join(syncPaths.backupsDir, 'skills', 'welcome', 'pre-restore');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# current\n', 'utf8');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# backup\n', 'utf8');

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-04T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-06-04T00:00:00.000Z',
      skills: {}
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'restore', 'welcome'], { from: 'node' });

    await expect(readFile(join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# backup\n');
    await expect(readFile(join(preRestoreDir, 'SKILL.md'), 'utf8')).resolves.toBe('# current\n');
    await expect(access(backupDir)).rejects.toThrow();
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'conflict',
          status: 'conflict',
          forced_conflict: true
        }
      }
    });

    consoleLog.mockClear();
    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'status'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([
      ['welcome\talpha\tconflict\tconflict']
    ]);
  });

  it('restore --dry-run previews changes without modifying files or manifests', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    const syncPaths = getSyncPaths(homeDir);
    const skillDir = join(syncPaths.skillsDir, 'welcome');
    const backupDir = getPullBackupDir(homeDir, 'welcome');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# current\n', 'utf8');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# backup\n', 'utf8');

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-04T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: '11111111111111111111111111111111',
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'restore', 'welcome', '--dry-run'], { from: 'node' });

    await expect(readFile(join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# current\n');
    await expect(readFile(join(backupDir, 'SKILL.md'), 'utf8')).resolves.toBe('# backup\n');
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    expect(consoleLog.mock.calls.map((call) => call[0])).toContain(
      `[dry-run] Would restore welcome from ${backupDir}; would mark conflict in: alpha`
    );
  });

  it('restore --server only marks the selected manifest as conflict', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    const syncPaths = getSyncPaths(homeDir);
    const skillDir = join(syncPaths.skillsDir, 'welcome');
    const backupDir = getPullBackupDir(homeDir, 'welcome');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# current\n', 'utf8');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# backup\n', 'utf8');

    const trackedState = {
      local_hash: '11111111111111111111111111111111',
      remote_hash: '11111111111111111111111111111111',
      recorded_hash: '11111111111111111111111111111111',
      direction: 'skip' as const,
      status: 'in-sync' as const
    };

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-06-04T00:00:00.000Z',
      skills: {
        welcome: trackedState
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-06-04T00:00:00.000Z',
      skills: {
        welcome: trackedState
      }
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'restore', 'welcome', '--server', 'beta'], { from: 'node' });

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });
    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'conflict',
          status: 'conflict',
          forced_conflict: true
        }
      }
    });
  });

  it('refresh --local [server] updates manifests without printing status rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {},
          beta: {}
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: null,
          recorded_hash: null,
          direction: 'push',
          status: 'new'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', '--local', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog).not.toHaveBeenCalled();
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: expect.any(String),
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });
  });

  it('refresh [server] prints refreshed status rows by default', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {
              claude: '/srv/skills'
            }
          }
        },
        sources: {}
      },
      homeDir
    );

    vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'remote-hash',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });
    vi.spyOn(transportModule, 'scanRemoteAgents').mockResolvedValue({
      discovered_agents: [
        {
          name: 'claude',
          path: '/srv/skills',
          symlinked_skills: ['welcome'],
          directory_skills: []
        }
      ],
      remote_only_skills: []
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpull\tnew']]);
    await expect(loadReceiverBackupIfExists(homeDir, 'alpha')).resolves.toMatchObject({
      version: 1,
      server: 'alpha',
      remote_agents: {
        claude: '/srv/skills'
      },
      links: {
        welcome: ['claude']
      }
    });
  });

  it('refresh --remote [server] updates receiver backup without printing status rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {
            host: 'alpha.example.com',
            remote_agents: {
              claude: '/srv/skills'
            }
          }
        },
        sources: {}
      },
      homeDir
    );

    vi.spyOn(transportModule, 'refreshRemoteManifestFromServer').mockResolvedValue({
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'remote-hash',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });
    vi.spyOn(transportModule, 'scanRemoteAgents').mockResolvedValue({
      discovered_agents: [
        {
          name: 'claude',
          path: '/srv/skills',
          symlinked_skills: ['welcome'],
          directory_skills: ['manual']
        }
      ],
      remote_only_skills: ['detached']
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', '--remote', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog).not.toHaveBeenCalled();
    await expect(loadReceiverBackupIfExists(homeDir, 'alpha')).resolves.toMatchObject({
      version: 1,
      server: 'alpha',
      remote_agents: {
        claude: '/srv/skills'
      },
      links: {
        detached: [],
        manual: [],
        welcome: ['claude']
      }
    });
  });

  it('status auto-refresh updates persisted manifests by default but not with --no-refresh', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: {}
        },
        sources: {}
      },
      homeDir
    );

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome\n', 'utf8');

    const staleManifest = {
      version: 1 as const,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'pull' as const,
          status: 'remote-changed' as const
        }
      }
    };

    await saveServerManifest(homeDir, staleManifest);

    const firstConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'status'], { from: 'node' });

    expect(firstConsoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      updated_at: expect.not.stringMatching(staleManifest.updated_at),
      skills: {
        welcome: {
          local_hash: expect.any(String),
          remote_hash: '11111111111111111111111111111111',
          recorded_hash: '11111111111111111111111111111111',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });

    firstConsoleLog.mockRestore();
    await saveServerManifest(homeDir, staleManifest);

    const secondConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'status'], { from: 'node' });

    expect(secondConsoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);
    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toEqual(staleManifest);
  });

  it('preAction skips auto-refresh for init, config, config show, config set, refresh, and install', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
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

    const autoRefreshSpy = vi.spyOn(refreshModule, 'autoRefreshManifests');

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'config', 'show'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'config', 'set', 'conflict_resolution', 'manual'], {
      from: 'node'
    });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    expect(autoRefreshSpy).not.toHaveBeenCalled();
  });

  it('diff <server> prints only pending rows for one server', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        docs: {
          local_hash: null,
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'new'
        },
        welcome: {
          local_hash: '222',
          remote_hash: '111',
          recorded_hash: '111',
          direction: 'push',
          status: 'local-changed'
        },
        remote: {
          local_hash: null,
          remote_hash: '333',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        ignored: {
          local_hash: '444',
          remote_hash: '555',
          recorded_hash: '555',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'diff', 'alpha'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([
      ['docs\tpush\t-\t111\t111'],
      ['remote\tpull\t-\t333\t-'],
      ['welcome\tpush\t-\t111\t111']
    ]);
  });

  it('resolve <skill> --local/--remote resolves only tracked conflicts across servers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-alpha',
          remote_hash: 'remote-alpha',
          recorded_hash: 'base-alpha',
          direction: 'conflict',
          status: 'conflict'
        },
        docs: {
          local_hash: 'docs',
          remote_hash: 'docs',
          recorded_hash: 'docs',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'skip',
          status: 'in-sync'
        },
        deploy: {
          local_hash: null,
          remote_hash: 'deploy-remote',
          recorded_hash: 'deploy-base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--local'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'remote-alpha',
          recorded_hash: 'remote-alpha',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });

    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'push',
          status: 'local-changed'
        },
        deploy: {
          local_hash: null,
          remote_hash: 'deploy-remote',
          recorded_hash: 'deploy-base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });
  });

  it('resolve <skill> --local/--remote reconciles stale derived fields before resolving a real conflict', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconciliation-cli-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-alpha',
          remote_hash: 'remote-alpha',
          recorded_hash: 'base-alpha',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-02T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'same',
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--remote'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpull\tnew']]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'remote-alpha',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });

    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });
  });

  it('resolve <skill> --local resolves conflict with local version', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-local-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-alpha',
          remote_hash: 'remote-alpha',
          recorded_hash: 'base-alpha',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--local'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: null,
          remote_hash: 'remote-alpha',
          recorded_hash: 'remote-alpha',
          direction: 'push',
          status: 'local-changed'
        }
      }
    });
  });

  it('resolve <skill> --remote resolves conflict with remote version', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-remote-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        deploy: {
          local_hash: 'local-beta',
          remote_hash: 'remote-beta',
          recorded_hash: 'base-beta',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'deploy', '--remote'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['deploy\tbeta\tpull\tnew']]);

    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
      skills: {
        deploy: {
          local_hash: null,
          remote_hash: 'remote-beta',
          recorded_hash: null,
          direction: 'pull',
          status: 'new'
        }
      }
    });
  });

  it('resolve <skill> rejects both --local and --remote together', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-both-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-alpha',
          remote_hash: 'remote-alpha',
          recorded_hash: 'base-alpha',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--local', '--remote'], {
        from: 'node'
      })
    ).rejects.toThrow('Cannot specify both --local and --remote');
  });

  it('resolve <skill> --diff shows hash differences for conflict', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-diff-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    // Create a real conflict: local and remote both differ from recorded
    // local_hash != remote_hash != recorded_hash
    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'abc123',
          remote_hash: 'def456',
          recorded_hash: 'base789',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    // Create local skill directory so local_hash gets recalculated
    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome conflict version\n', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'resolve', 'welcome', '--diff'], {
      from: 'node'
    });

    // Uses stored hashes from manifest (--no-refresh skips auto-refresh)
    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tlocal:abc123\tremote:def456\tbase:base789']]);
  });

  it('resolve <skill> --diff handles null local hash', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-diff-null-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    // A conflict where local is deleted but remote and recorded differ
    // This happens when: local=null, remote changed from recorded
    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        deploy: {
          local_hash: null,
          remote_hash: 'remote-new',
          recorded_hash: 'base-old',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'resolve', 'deploy', '--diff'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['deploy\tbeta\tlocal:-\tremote:remote-new\tbase:base-old']]);
  });

  it('resolve <skill> --local --diff shows diff then resolves with local', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-diff-local-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'alpha',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local-abc',
          remote_hash: 'remote-def',
          recorded_hash: 'base-xyz',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'resolve', 'welcome', '--local', '--diff'], {
      from: 'node'
    });

    // Should show diff first, then resolve
    expect(consoleLog.mock.calls).toEqual([
      ['welcome\talpha\tlocal:local-abc\tremote:remote-def\tbase:base-xyz'],
      ['welcome\talpha\tpush\tlocal-changed']
    ]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          direction: 'push',
          status: 'local-changed'
        }
      }
    });
  });

  it('resolve <skill> --remote --diff shows diff then resolves with remote', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-resolve-diff-remote-'));
    tempDirs.push(homeDir);
    await saveConfig(createDefaultConfig(), homeDir);

    await saveServerManifest(homeDir, {
      version: 1,
      server: 'beta',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        deploy: {
          local_hash: 'local-123',
          remote_hash: 'remote-456',
          recorded_hash: 'base-789',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'resolve', 'deploy', '--remote', '--diff'], {
      from: 'node'
    });

    // Should show diff first, then resolve
    expect(consoleLog.mock.calls).toEqual([
      ['deploy\tbeta\tlocal:local-123\tremote:remote-456\tbase:base-789'],
      ['deploy\tbeta\tpull\tremote-changed']
    ]);

    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
      skills: {
        deploy: {
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });
  });

  it('link edit <skill> requires an interactive terminal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-editor-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude']
        }
      },
      homeDir
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });

    try {
      await expect(
        createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'edit', 'my-skill'], { from: 'node' })
      ).rejects.toThrow(`process.exit:${ExitCode.NEEDS_INPUT}`);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    }

    expect(consoleError).toHaveBeenCalledWith('✗ `link edit` requires an interactive terminal');
    expect(consoleError).toHaveBeenCalledWith('  Use `syncskill link set <skill> <agent>...`, `syncskill link add <skill> <agent>...`, or `syncskill link clear <skill>` instead.');
    expect(exitMock).toHaveBeenCalledWith(ExitCode.NEEDS_INPUT);
  });

  it('link edit <skill> opens single-skill editor and reconciles selected agents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-editor-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          cursor: cursorDir,
          hermes: hermesDir
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude', 'hermes']
        }
      },
      homeDir
    );

    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });
    await writeFile(join(claudeDir, 'my-skill'), 'stale file', 'utf8');
    await writeFile(join(hermesDir, 'my-skill'), 'stale file', 'utf8');

    mockCheckbox.mockResolvedValue(['claude', 'cursor']);
    mockConfirm.mockResolvedValue(true);

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });

    try {
      await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'edit', 'my-skill'], { from: 'node' });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    }

    expect(mockCheckbox).toHaveBeenCalledWith({
      message: 'my-skill is currently linked to:\n',
      choices: [
        { name: 'claude', value: 'claude', checked: true },
        { name: 'cursor', value: 'cursor', checked: false },
        { name: 'hermes', value: 'hermes', checked: true }
      ]
    });
    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude', 'cursor']
      }
    });
    await expect(readlink(join(claudeDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(cursorDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readFile(join(hermesDir, 'my-skill'), 'utf8')).resolves.toBe('stale file');
    expect(consoleLog).toHaveBeenCalledWith('✓ Updated my-skill: linked to cursor, unlinked from hermes');
  });

  it('link add <skill> <agent>... appends multiple agents and creates symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-append-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          cursor: cursorDir,
          hermes: hermesDir
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude']
        }
      },
      homeDir
    );

    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'add', 'my-skill', 'cursor', 'hermes'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude', 'cursor', 'hermes']
      }
    });
    await expect(readlink(join(cursorDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(hermesDir, 'my-skill'))).resolves.toBe(skillDir);
    expect(consoleLog).toHaveBeenCalledWith('✓ Linked my-skill to: claude, cursor, hermes');
  });

  it('link add <skill> <agent>... rejects unknown agents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-append-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          hermes: join(homeDir, '.hermes', 'skills')
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude']
        }
      },
      homeDir
    );

    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(homeDir, '.hermes', 'skills'), { recursive: true });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'add', 'my-skill', 'cursor', 'unknown'], { from: 'node' })
    ).rejects.toThrow(`process.exit:${ExitCode.USAGE_ERROR}`);

    expect(consoleError).toHaveBeenCalledWith("✗ Agent 'cursor' not configured");
    expect(exitMock).toHaveBeenCalledWith(ExitCode.USAGE_ERROR);
    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude']
      }
    });
  });

  it('link remove <skill> <agent>... removes multiple agents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-remove-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });
    await symlink(skillDir, join(claudeDir, 'my-skill'));
    await symlink(skillDir, join(cursorDir, 'my-skill'));
    await symlink(skillDir, join(hermesDir, 'my-skill'));

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          cursor: cursorDir,
          hermes: hermesDir
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude', 'cursor', 'hermes']
        }
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'remove', 'my-skill', 'cursor', 'hermes'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude']
      }
    });
    await expect(readlink(join(claudeDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(access(join(cursorDir, 'my-skill'))).rejects.toThrow();
    await expect(access(join(hermesDir, 'my-skill'))).rejects.toThrow();
    expect(consoleLog).toHaveBeenCalledWith('✓ Removed cursor, hermes from my-skill');
  });

  it('link set <skill> * sets wildcard links and links all configured agents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-apply-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          cursor: cursorDir,
          hermes: hermesDir
        }),
        private_agents: [],
        links: {
          'my-skill': ['claude']
        }
      },
      homeDir
    );

    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'set', 'my-skill', '*'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['*']
      }
    });
    await expect(readlink(join(claudeDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(cursorDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(hermesDir, 'my-skill'))).resolves.toBe(skillDir);
    expect(consoleLog).toHaveBeenCalledWith('✓ Linked my-skill to: claude, cursor, hermes');
  });
});
