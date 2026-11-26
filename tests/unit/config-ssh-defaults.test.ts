import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { loadConfig, getConfiguredServer } from '../../src/config/config.js';

/**
 * Tester #490: a config migrated from syncskills carries `ssh_defaults` (and `servers.<name>.directions`) that syncskill
 * used to keep but never read -- a configured identity file or port had no effect, silently. The defaults now merge into
 * the resolved server, where the transport's argv already carries a server's own port/identity.
 */
describe('ssh_defaults (#490)', () => {
  const tempDirs = useTempDirs();

  async function home(server: Record<string, unknown>, defaults: Record<string, unknown> | undefined) {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ssh-defaults-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, profiles: {},
      servers: { delta: server }, sources: {}, private_agents: [],
      ...(defaults === undefined ? {} : { ssh_defaults: defaults })
    }));
    return homeDir;
  }

  it('applies the config defaults, and a server value overrides them', async () => {
    const homeDir = await home({ host: 'fake.example.com', remote_agents: {}, port: 2222 }, { port: 2200, identity_file: '/tmp/default_key' });
    const config = await loadConfig(homeDir);
    // mutation: ignore ssh_defaults in getConfiguredServer -> port 2222 but no identity_file, red
    expect(getConfiguredServer(config, 'delta')).toMatchObject({ port: 2222, identity_file: '/tmp/default_key' });
    const plain = { ...config, servers: { plain: { host: 'h', remote_agents: {} } } };
    expect(getConfiguredServer(plain as never, 'plain')).toMatchObject({ port: 2200, identity_file: '/tmp/default_key' });
  });
});