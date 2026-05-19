import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
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
import * as refreshModule from '../../src/refresh.js';
import * as transportModule from '../../src/core/transport.js';
import { createProgram } from '../../src/index.js';

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

  it('refresh --local --status [server] prints refreshed status rows', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', '--local', '--status', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);
  });

  it('refresh --remote --status <server> prints refreshed remote rows', async () => {
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

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'refresh', '--remote', '--status', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpull\tnew']]);
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

  it('preAction skips auto-refresh for init, config, config show, config set, and refresh', async () => {
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

  it('link <skill> opens single-skill editor and reconciles selected agents', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'my-skill'], { from: 'node' });

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

  it('link <skill> <agent> appends one agent and creates the symlink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-append-'));
    tempDirs.push(homeDir);

    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const skillDir = join(homeDir, '.syncskill', 'skills', 'my-skill');

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill\n', 'utf8');

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {
          claude: claudeDir,
          cursor: cursorDir,
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
    await mkdir(cursorDir, { recursive: true });
    await mkdir(join(homeDir, '.hermes', 'skills'), { recursive: true });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'my-skill', 'cursor'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude', 'cursor']
      }
    });
    await expect(readlink(join(cursorDir, 'my-skill'))).resolves.toBe(skillDir);
    expect(consoleLog).toHaveBeenCalledWith('✓ Linked my-skill to cursor');
  });

  it('link <skill> <agent> rejects unknown agents', async () => {
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
      createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'my-skill', 'cursor'], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    expect(consoleError).toHaveBeenCalledWith("Error: Agent 'cursor' not configured");
    expect(exitMock).toHaveBeenCalledWith(1);
    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['claude']
      }
    });
  });

  it('link <skill> --apply sets wildcard links and links all configured agents', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'my-skill', '--apply'], { from: 'node' });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'my-skill': ['*']
      }
    });
    await expect(readlink(join(claudeDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(cursorDir, 'my-skill'))).resolves.toBe(skillDir);
    await expect(readlink(join(hermesDir, 'my-skill'))).resolves.toBe(skillDir);
    expect(consoleLog).toHaveBeenCalledWith('✓ Linked my-skill to all 3 agents');
  });
});
