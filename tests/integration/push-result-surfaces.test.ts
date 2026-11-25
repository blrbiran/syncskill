import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { createFakeSshBin } from '../helpers/fake-ssh.js';
import { saveConfig } from '../../src/config/config.js';
import { saveServerManifest, type ManifestSkillState } from '../../src/core/manifest.js';
import { createProgram } from '../../src/index.js';

/**
 * Tester #477: one `push --dry-run` gave three answers. Human output said "1 modified, 2 deleted", --json said
 * `pushed: 0, deleted: 0` (the dry-run result carried `pushed_skills: []`, and the human "deleted" was the manifest's
 * local deletions while JSON's was the orphan set), and the named warnings were printed nowhere and reached --json
 * only as a count. Both surfaces now render the same result; this runs the CLI twice on copies of one fixture.
 *
 * Fixture (real runtime, fake ssh): local has only `alpha` (changed since the last sync). The manifest recorded
 * `gamma` and `delta` as synced and they are gone locally (local deletions to carry). The remote lists alpha, gamma,
 * `elsewhere` (included, never on this machine -> kept, warned) and `old-one` (not included -> orphan). `delta` is no
 * longer in the listing, so only the manifest knows it is a deletion.
 */
const state = (hash: string): ManifestSkillState => ({ local_hash: hash, remote_hash: hash, recorded_hash: hash, direction: 'skip', status: 'in-sync' });

async function fixture(tempDirs: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'syncskill-surfaces-'));
  tempDirs.push(home);
  await saveConfig({
    version: 1, conflict_resolution: 'manual', agents: {}, links: {},
    servers: { lab: { host: 'lab.example.invalid', remote_agents: {}, skills: { include: ['alpha', 'gamma', 'delta', 'elsewhere'] } } },
    sources: {},
  } as never, home);
  await mkdir(join(home, '.syncskill', 'skills', 'alpha'), { recursive: true });
  await writeFile(join(home, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
  await saveServerManifest(home, {
    version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z',
    skills: { alpha: state('ra'), gamma: state('rg'), delta: state('rd') },
  });
  return home;
}

describe('push --dry-run: human output and --json report the same plan (#477)', () => {
  const tempDirs = useTempDirs();
  const saved = { PATH: process.env.PATH, json: process.env.FAKE_SSH_MANIFEST_JSON, listing: process.env.FAKE_SSH_LISTING };

  beforeEach(async () => {
    const bin = await createFakeSshBin();
    tempDirs.push(bin);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_SSH_MANIFEST_JSON = JSON.stringify({
      version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z',
      skills: { alpha: state('ra'), gamma: state('rg'), delta: state('rd'), elsewhere: state('re') },
    });
    process.env.FAKE_SSH_LISTING = 'alpha gamma elsewhere old-one';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.json === undefined) delete process.env.FAKE_SSH_MANIFEST_JSON; else process.env.FAKE_SSH_MANIFEST_JSON = saved.json;
    if (saved.listing === undefined) delete process.env.FAKE_SSH_LISTING; else process.env.FAKE_SSH_LISTING = saved.listing;
  });

  async function run(argv: string[]): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await createProgram(await fixture(tempDirs)).parseAsync(['node', 'syncskill', ...argv], { from: 'node' });
    vi.restoreAllMocks();
    return lines;
  }

  it('counts, deletion set and warnings agree between the two surfaces', async () => {
    const human = await run(['push', 'lab', '--dry-run']);
    const jsonLines = await run(['--json', 'push', 'lab', '--dry-run']);

    // --json stdout is JSON events only; a plan printed there would make it unparseable.
    const events = jsonLines.map((line) => JSON.parse(line) as { type: string; summary?: Record<string, any> });
    const summary = events.find((event) => event.type === 'result')?.summary as Record<string, any>;

    const humanPushed = human.filter((line) => / \((new|modified)\)$/.test(line)).length;
    const humanDeleted = human.filter((line) => / \(deleted\)$/.test(line)).map((line) => line.trim().replace(/^- /, '').replace(/ \(deleted\)$/, ''));
    const humanWarnings = human.map((line) => line.trim()).filter((line) => line.startsWith('warning: '));

    // The plan itself (an equality of two zeros would prove nothing).
    expect(humanDeleted.sort()).toEqual(['delta', 'gamma', 'old-one']);
    expect(humanPushed).toBe(1);

    // mutation: dry-run returns pushed_skills: [] again -> JSON pushed 0 vs human 1 modified, red
    expect(summary.pushed).toBe(humanPushed);
    // mutation: report only the orphan set as deleted -> delta missing on one side, red
    expect(summary.deleted).toBe(humanDeleted.length);
    expect(summary.data.deleted.map((entry: { skill: string }) => entry.skill).sort()).toEqual(humanDeleted.sort());
    expect(human).toContain('Summary: 4 skill(s), 1 modified, 3 deleted');

    // mutation: drop data.warnings from the JSON summary -> only a count reaches a script, red
    expect(summary.data.warnings).toEqual([{ code: 'included-not-local', server: 'lab', detail: 'elsewhere' }]);
    // mutation: stop printing warnings in the human plan -> the person never sees why `elsewhere` is kept, red
    expect(humanWarnings).toEqual(['warning: included-not-local: elsewhere']);
    expect(summary.warnings).toBe(humanWarnings.length);
  });
});
