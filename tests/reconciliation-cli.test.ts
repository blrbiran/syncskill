import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadServerManifest, saveServerManifest } from '../src/manifest.js';
import { createProgram } from '../src/index.js';

describe('reconciliation CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
          local_hash: '111',
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
      ['docs\talpha\tskip\tin-sync'],
      ['welcome\talpha\tpush\tlocal-changed'],
      ['deploy\tbeta\tpull\tnew']
    ]);
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
          local_hash: '111',
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
      ['remote\tpull\t-\t333\t-'],
      ['welcome\tpush\t222\t111\t111']
    ]);
  });

  it('resolve <skill> --take <side> resolves only tracked conflicts across servers', async () => {
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
          local_hash: 'same',
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'skip',
          status: 'in-sync'
        },
        deploy: {
          local_hash: 'deploy-local',
          remote_hash: 'deploy-remote',
          recorded_hash: 'deploy-base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--take', 'local'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpush\tlocal-changed']]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: 'local-alpha',
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
          local_hash: 'same',
          remote_hash: 'same',
          recorded_hash: 'same',
          direction: 'skip',
          status: 'in-sync'
        },
        deploy: {
          local_hash: 'deploy-local',
          remote_hash: 'deploy-remote',
          recorded_hash: 'deploy-base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    });
  });

  it('resolve <skill> --take <side> reconciles stale derived fields before resolving a real conflict', async () => {
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

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'resolve', 'welcome', '--take', 'remote'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([['welcome\talpha\tpull\tremote-changed']]);

    await expect(loadServerManifest(homeDir, 'alpha')).resolves.toMatchObject({
      skills: {
        welcome: {
          local_hash: 'local-alpha',
          remote_hash: 'remote-alpha',
          recorded_hash: 'local-alpha',
          direction: 'pull',
          status: 'remote-changed'
        }
      }
    });

    await expect(loadServerManifest(homeDir, 'beta')).resolves.toMatchObject({
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
  });
});
