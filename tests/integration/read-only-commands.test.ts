import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { createFakeSshBin } from '../helpers/fake-ssh.js';
import { saveConfig } from '../../src/config/config.js';
import { saveServerManifest, type ManifestSkillState } from '../../src/core/manifest.js';
import { createProgram } from '../../src/index.js';

/**
 * Tester #474: `push --dry-run` rewrote ~/.syncskill/manifests/<server>.json before it ran (the preAction auto-refresh
 * saved local_hash/direction/updated_at and appended history), and a dry-run push also saved the receiver backup. A
 * preview changed the baseline of the next decision. Read-only commands -- status and every --dry-run -- now refresh in
 * memory only. Everything runs in a temp HOME with a fake ssh (real runtime, no network).
 */
const synced = (hash: string): ManifestSkillState => ({ local_hash: hash, remote_hash: hash, recorded_hash: hash, direction: 'skip', status: 'in-sync' });

async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      hash.update(`${relative(dir, path)}\0${entry.isDirectory() ? 'd' : 'f'}\0`);
      if (entry.isDirectory()) await walk(path);
      else hash.update(await readFile(path));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

describe('read-only commands write nothing under the sync dir (#474)', () => {
  const tempDirs = useTempDirs();
  const saved = { PATH: process.env.PATH, json: process.env.FAKE_SSH_MANIFEST_JSON, listing: process.env.FAKE_SSH_LISTING };

  beforeEach(async () => {
    const bin = await createFakeSshBin();
    tempDirs.push(bin);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_SSH_MANIFEST_JSON = JSON.stringify({ version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z', skills: { alpha: synced('a1') } });
    process.env.FAKE_SSH_LISTING = 'alpha';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.json === undefined) delete process.env.FAKE_SSH_MANIFEST_JSON; else process.env.FAKE_SSH_MANIFEST_JSON = saved.json;
    if (saved.listing === undefined) delete process.env.FAKE_SSH_LISTING; else process.env.FAKE_SSH_LISTING = saved.listing;
  });

  /** The tester's state: alpha was synced as `a1` and has since changed on disk; the receiver backup lacks alpha's link. */
  async function fixture(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-readonly-'));
    tempDirs.push(home);
    await saveConfig({
      version: 1, conflict_resolution: 'manual', agents: {}, links: { alpha: ['claude'] },
      servers: { lab: { host: 'lab.example.invalid', remote_agents: { claude: '~/.claude/skills' }, skills: { include: ['alpha'] } } },
      sources: {},
    } as never, home);
    await mkdir(join(home, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(home, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha, edited\n', 'utf8');
    await saveServerManifest(home, { version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z', skills: { alpha: synced('a1') } });
    await mkdir(join(home, '.syncskill', 'receivers'), { recursive: true });
    await writeFile(join(home, '.syncskill', 'receivers', 'lab.json'), `${JSON.stringify({
      version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00.000Z', remote_agents: { claude: '~/.claude/skills' }, links: {},
    }, null, 2)}\n`, 'utf8');
    return home;
  }

  async function run(home: string, argv: string[]): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await createProgram(home).parseAsync(['node', 'syncskill', ...argv], { from: 'node' });
    vi.restoreAllMocks();
    return lines;
  }

  it.each([
    [['status']],
    [['--json', 'status']],
    [['--json', 'source', 'list']],
    [['--json', 'remote', 'list']],
    [['--json', 'link', 'list']],
    [['--json', 'doctor']],
    [['push', 'lab', '--dry-run']],
    [['--json', 'push', 'lab', '--dry-run']],
    [['pull', 'lab', '--dry-run']],
    [['sync', 'lab', '--dry-run']],
  ])('%j leaves ~/.syncskill byte-identical', async (argv) => {
    const home = await fixture();
    const before = await treeHash(join(home, '.syncskill'));
    await run(home, argv);
    // mutation: save the refreshed manifest unconditionally again (refresh.ts) -> manifests/lab.json and history change, red
    // mutation: save the merged receiver backup under --dry-run again (sync_engine.ts) -> receivers/lab.json changes, red
    expect(await treeHash(join(home, '.syncskill'))).toBe(before);
  });

  it('status on a home that has never synced creates no directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-readonly-'));
    tempDirs.push(home);
    await saveConfig({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {},
      servers: { lab: { host: 'lab.example.invalid', remote_agents: {} } }, sources: {},
    } as never, home);
    const before = await treeHash(join(home, '.syncskill'));
    await run(home, ['status']);
    // mutation: listStoredServers mkdirs the manifests directory again -> manifests/ appears, red
    expect(await treeHash(join(home, '.syncskill'))).toBe(before);
  });

  it('status still reports what is on disk now, not the stale stored manifest', async () => {
    const home = await fixture();
    // mutation: skip the refresh for read-only commands instead of computing it in memory -> alpha reads skip/in-sync, red
    expect(await run(home, ['status'])).toContain('alpha\tlab\tpush\tlocal-changed');
  });

  it('a mutating command still refreshes and saves the manifest', async () => {
    const home = await fixture();
    const before = await readFile(join(home, '.syncskill', 'manifests', 'lab.json'), 'utf8');
    await run(home, ['diff', 'lab']);
    // mutation: never persist the auto refresh -> the stored manifest keeps local_hash a1, red
    expect(await readFile(join(home, '.syncskill', 'manifests', 'lab.json'), 'utf8')).not.toBe(before);
  });
});
