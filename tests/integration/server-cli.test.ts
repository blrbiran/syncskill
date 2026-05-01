import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../../src/config.js';
import { createProgram } from '../../src/index.js';
import * as serverModule from '../../src/server.js';

describe('server CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('server list prints configured server names', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          beta: { host: 'beta.example.com', remote_agents: {} },
          alpha: { host: 'alpha.example.com', remote_agents: {} }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'server', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([['alpha'], ['beta']]);
  });

  it('server show prints configured connection details', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
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
            user: 'deploy',
            port: 2222,
            identity_file: '/Users/demo/.ssh/id_syncskill',
            remote_agents: { claude: '/srv/skills' }
          }
        },
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'server', 'show', 'alpha'], {
      from: 'node'
    });

    expect(consoleLog.mock.calls).toEqual([
      ['name\talpha'],
      ['host\talpha.example.com'],
      ['user\tdeploy'],
      ['port\t2222'],
      ['identity_file\t/Users/demo/.ssh/id_syncskill'],
      ['remote_agent\tclaude\t/srv/skills']
    ]);
  });

  it('server probe prints one row per probe check and preserves failure rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-server-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {
          alpha: { host: 'alpha.example.com', remote_agents: { claude: '/srv/skills' } }
        },
        sources: {}
      },
      homeDir
    );

    vi.spyOn(serverModule, 'probeServer').mockResolvedValue([
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'remote_skill_root', ok: false, detail: 'missing: /srv/skills' }
    ]);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      createProgram(homeDir).parseAsync(['node', 'syncskill', '--no-refresh', 'server', 'probe', 'alpha'], {
        from: 'node'
      })
    ).rejects.toThrow('Server probe failed: alpha');

    expect(consoleLog.mock.calls).toEqual([
      ['transport\tok\tssh ok'],
      ['remote_skill_root\tfail\tmissing: /srv/skills']
    ]);
  });
});
