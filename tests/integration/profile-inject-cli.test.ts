// tests/integration/profile-inject-cli.test.ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSkillDirectory } from '../../src/core/manifest.js';
import { useTempDirs } from '../helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'index.js');

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(homeDir: string, args: string[]): Promise<CliRun> {
  try {
    const result = await execFileAsync('node', [cliPath, ...args], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '', code: execError.code ?? 1 };
  }
}

function parseEvents(run: CliRun): Array<Record<string, unknown>> {
  return [...run.stdout.split('\n'), ...run.stderr.split('\n')]
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resultOf(run: CliRun): { summary: Record<string, unknown> } {
  const event = parseEvents(run).find((candidate) => candidate.type === 'result');
  if (event === undefined) throw new Error(`no result event in: ${run.stdout}${run.stderr}`);
  return event as { summary: Record<string, unknown> };
}

async function snapshotDir(root: string): Promise<string | string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await lstat(path);
      const rel = path.slice(root.length);
      if (info.isDirectory()) {
        entries.push(`${rel}|dir|${info.mtimeMs}`);
        await walk(path);
      } else if (info.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.push(`${rel}|${info.size}|${info.mtimeMs}|${digest}`);
      } else {
        entries.push(`${rel}|other|${info.mtimeMs}`);
      }
    }
  }
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<absent>';
    throw error;
  }
  await walk(root);
  return entries;
}

const realSyncskillDir = join(userInfo().homedir, '.syncskill');
let realBefore: string | string[];

beforeAll(async () => {
  realBefore = await snapshotDir(realSyncskillDir);
});

afterAll(async () => {
  expect(await snapshotDir(realSyncskillDir)).toEqual(realBefore);
});

describe('syncskill profile and inject', () => {
  const tempDirs = useTempDirs();

  async function setup(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-profile-inject-'));
    tempDirs.push(home);
    const agentDir = join(home, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });
    for (const name of ['alpha', 'beta', 'gamma']) {
      await mkdir(join(home, '.syncskill', 'skills', name), { recursive: true });
      await writeFile(join(home, '.syncskill', 'skills', name, 'SKILL.md'), `# ${name}`, 'utf8');
    }
    await writeFile(
      join(home, '.syncskill', 'config.json'),
      JSON.stringify({
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: {},
        servers: {},
        sources: {}
      }),
      'utf8'
    );
    return home;
  }

  async function readConfig(home: string): Promise<{ profiles: unknown }> {
    return JSON.parse(await readFile(join(home, '.syncskill', 'config.json'), 'utf8')) as { profiles: unknown };
  }

  it('1: profile round trip survives an unrelated config save', async () => {
    const home = await setup();
    let run = await runCli(home, ['--json', 'profile', 'set', 'review', 'beta', 'alpha']);
    expect(run.code).toBe(0);
    run = await runCli(home, ['--json', 'config', 'set', 'conflict_resolution', 'keep-local']);
    expect(run.code).toBe(0);
    expect((await readConfig(home)).profiles).toEqual({ review: ['alpha', 'beta'] });
    run = await runCli(home, ['--json', 'profile', 'ls', 'review']);
    expect(resultOf(run).summary).toMatchObject({ profiles: { review: ['alpha', 'beta'] } });
    run = await runCli(home, ['--json', 'profile', 'rm', 'review']);
    expect(run.code).toBe(0);
    expect((await readConfig(home)).profiles).toEqual({});
    expect((await runCli(home, ['--json', 'profile', 'rm', 'review'])).code).toBe(2);
    expect((await runCli(home, ['--json', 'profile', 'set', 'bad.name', 'alpha'])).code).toBe(2);
    expect((await runCli(home, ['--json', 'profile', 'set', 'x', 'ghost'])).code).toBe(2);
  });

  it('3: two targets from two profiles, then --skills', async () => {
    const home = await setup();
    expect((await runCli(home, ['profile', 'set', 'p1', 'alpha'])).code).toBe(0);
    expect((await runCli(home, ['profile', 'set', 'p2', 'beta', 'gamma'])).code).toBe(0);
    const t1 = join(home, 'runs', 'one');
    const t2 = join(home, 'runs', 'two');
    expect((await runCli(home, ['--json', 'inject', '--profile', 'p1', '--target', t1])).code).toBe(0);
    expect((await runCli(home, ['--json', 'inject', '--profile', 'p2', '--target', t2])).code).toBe(0);
    expect((await readdir(t1)).sort()).toEqual(['alpha', 'syncskill-lock.json']);
    expect((await readdir(t2)).sort()).toEqual(['beta', 'gamma', 'syncskill-lock.json']);
    const lock2 = JSON.parse(await readFile(join(t2, 'syncskill-lock.json'), 'utf8'));
    expect(lock2.profile).toBe('p2');
    for (const entry of lock2.skills) {
      expect(entry.content_md5).toBe(await hashSkillDirectory(join(t2, entry.name)));
    }
    expect(lock2.skills.map((s: { source: unknown }) => s.source)).toEqual([null, null]);
    const t3 = join(home, 'runs', 'three');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'beta,alpha,alpha', '--target', t3])).code).toBe(0);
    const lock3 = JSON.parse(await readFile(join(t3, 'syncskill-lock.json'), 'utf8'));
    expect(lock3.profile).toBeNull();
    expect(lock3.skills.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('4: editing the managed source after inject does not change the target', async () => {
    const home = await setup();
    const t1 = join(home, 'runs', 'one');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t1])).code).toBe(0);
    const before = await hashSkillDirectory(join(t1, 'alpha'));
    await writeFile(join(home, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha changed');
    expect(await hashSkillDirectory(join(t1, 'alpha'))).toBe(before);
  });

  it('5: occupied target exits 7 and missing skill exits 2, leaving no trace', async () => {
    const home = await setup();
    const t1 = join(home, 'runs', 'one');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t1])).code).toBe(0);
    const listing = (await readdir(t1)).sort();
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t1])).code).toBe(7);
    expect((await readdir(t1)).sort()).toEqual(listing);
    const t5 = join(home, 'runs', 'five');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha,ghost', '--target', t5])).code).toBe(2);
    await expect(readdir(t5)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('6: giving both selectors exits 2', async () => {
    const home = await setup();
    await runCli(home, ['profile', 'set', 'p1', 'alpha']);
    const run = await runCli(home, ['--json', 'inject', '--profile', 'p1', '--skills', 'alpha', '--target', join(home, 'runs', 'six')]);
    expect(run.code).toBe(2);
  });

  it('7: a symlink inside a skill becomes a regular file in the target', async () => {
    const home = await setup();
    await writeFile(join(home, 'outside.txt'), 'outside');
    await symlink(join(home, 'outside.txt'), join(home, '.syncskill', 'skills', 'gamma', 'link.txt'));
    const t7 = join(home, 'runs', 'seven');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'gamma', '--target', t7])).code).toBe(0);
    expect((await lstat(join(t7, 'gamma', 'link.txt'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(t7, 'gamma', 'link.txt'), 'utf8')).toBe('outside');
  });

  it('8: a target holding only a lock file exits 7 and keeps the lock bytes', async () => {
    const home = await setup();
    const t8 = join(home, 'runs', 'eight');
    await mkdir(t8, { recursive: true });
    await writeFile(join(t8, 'syncskill-lock.json'), 'prior');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t8])).code).toBe(7);
    expect(await readFile(join(t8, 'syncskill-lock.json'), 'utf8')).toBe('prior');
    expect((await readdir(t8)).sort()).toEqual(['syncskill-lock.json']);
  });

  it('reports target, lock and skills in the result and one add change per skill', async () => {
    const home = await setup();
    const target = join(home, 'runs', 'events');
    const run = await runCli(home, ['--json', 'inject', '--skills', 'alpha,beta', '--target', target]);
    expect(run.code).toBe(0);
    const summary = resultOf(run).summary;
    const lock = JSON.parse(await readFile(join(target, 'syncskill-lock.json'), 'utf8'));
    expect(summary.target).toBe(target);
    expect(summary.lock).toBe(join(target, 'syncskill-lock.json'));
    expect(summary.skills).toEqual(lock.skills);
    const changes = parseEvents(run).filter((event) => event.type === 'change');
    expect(changes).toHaveLength(2);
    for (const change of changes) {
      expect(change).toMatchObject({ op: 'add', entity: 'skill' });
    }
  });
});
