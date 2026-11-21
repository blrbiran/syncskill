import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config/config.js';
import { pushToServers } from '../../src/core/sync_engine.js';
import { type TransportRuntime } from '../../src/core/transport.js';

async function seedSkill(homeDir: string, name: string): Promise<void> {
  const dir = join(homeDir, '.syncskill', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
}

function createRuntime(remoteSkills: string[] = []): TransportRuntime & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    async exec(file, args) {
      calls.push({ file, args });
      if (file === 'ssh' && args.at(-1) === 'manifest') {
        return { stdout: JSON.stringify({ version: 1, server: 'alpha', updated_at: '2026-05-01T00:00:00.000Z', skills: {} }), stderr: '' };
      }
      if (file === 'ssh' && args.includes('ls')) {
        return { stdout: remoteSkills.map((skill) => `${skill}\n`).join(''), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  };
}

const rsyncDestinations = (runtime: { calls: Array<{ file: string; args: string[] }> }): string[] =>
  runtime.calls.filter((call) => call.file === 'rsync').map((call) => String(call.args.at(-1)));

describe('a server only receives the skills it is included for', () => {
  const tempDirs = useTempDirs();

  it('push follows the link matrix (issue 404)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scope-'));
    tempDirs.push(homeDir);
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: { linked: ['claude'] },
        servers: { alpha: { host: 'alpha.example.com', remote_agents: {} } },
        sources: {}
      },
      homeDir
    );
    await seedSkill(homeDir, 'linked');
    await seedSkill(homeDir, 'unlinked');

    const runtime = createRuntime();
    const [result] = await pushToServers(homeDir, ['alpha'], { runtime, now: '2026-05-01T00:30:00.000Z', yes: false });

    expect(result.pushed_skills).toEqual(['linked']);
    const destinations = rsyncDestinations(runtime).join('\n');
    // Issue #425: a push transfers into `.linked.staging-<id>/` and promotes it; the live path is never an rsync target.
    expect(destinations).toContain('.linked.staging-');
    expect(destinations).not.toContain('.unlinked.staging-');
  });

  it('per-server include narrows the set and orphan cleanup follows it (issue 404)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scope-'));
    tempDirs.push(homeDir);
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: { linked: ['claude'] },
        servers: { alpha: { host: 'alpha.example.com', remote_agents: {}, skills: { include: ['linked'] } } },
        sources: {}
      },
      homeDir
    );
    await seedSkill(homeDir, 'linked');
    await seedSkill(homeDir, 'unlinked');

    const runtime = createRuntime(['linked', 'unlinked', 'orphan']);
    const [result] = await pushToServers(homeDir, ['alpha'], {
      runtime,
      now: '2026-05-01T00:30:00.000Z',
      yes: true,
      yesDestructive: true
    });

    expect(result.pushed_skills).toEqual(['linked']);
    const rm = runtime.calls.find((call) => call.file === 'ssh' && call.args.includes('rm'));
    expect(rm?.args.join(' ')).toContain('/orphan');
    expect(rm?.args.join(' ')).toContain('/unlinked');
    expect(rm?.args.join(' ')).not.toContain('/linked"');
  });

  it('--timeout bounds a server phase (issue 406)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scope-'));
    tempDirs.push(homeDir);
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: { linked: ['claude'] },
        servers: { alpha: { host: 'alpha.example.com', remote_agents: {} } },
        sources: {}
      },
      homeDir
    );
    await seedSkill(homeDir, 'linked');

    const hanging: TransportRuntime = {
      exec: () => new Promise(() => {})
    };

    const started = Date.now();
    await expect(pushToServers(homeDir, ['alpha'], { runtime: hanging, timeout: 0.05 })).rejects.toThrow(
      /Timeout: sync with alpha exceeded 0\.05s/
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});