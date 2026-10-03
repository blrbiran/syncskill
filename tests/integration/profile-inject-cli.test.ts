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

async function runCli(homeDir: string, args: string[], cwd?: string): Promise<CliRun> {
  try {
    const result = await execFileAsync('node', [cliPath, ...args], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      ...(cwd === undefined ? {} : { cwd })
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

function errorCodeOf(run: CliRun): unknown {
  return parseEvents(run).find((event) => event.type === 'error')?.code;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', cwd === undefined ? args : ['-C', cwd, ...args]);
  return stdout;
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await git(['add', '.'], repoDir);
  await git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', message], repoDir);
}

async function snapshotDir(root: string): Promise<string | string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await lstat(path);
      const rel = path.slice(root.length);
      if (info.isDirectory()) {
        entries.push(`${rel}|dir`);
        await walk(path);
      } else if (info.isFile()) {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.push(`${rel}|file|${info.size}|${digest}`);
      } else {
        entries.push(`${rel}|other`);
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
    const saved = (await readConfig(home)) as { profiles: unknown; conflict_resolution: string };
    expect(saved.conflict_resolution).toBe('keep-local');
    expect(saved.profiles).toEqual({ review: ['alpha', 'beta'] });
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
    const lockBytes = await readFile(join(t1, 'syncskill-lock.json'), 'utf8');
    const alphaHash = await hashSkillDirectory(join(t1, 'alpha'));
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', t1])).code).toBe(7);
    expect((await readdir(t1)).sort()).toEqual(listing);
    expect(await readFile(join(t1, 'syncskill-lock.json'), 'utf8')).toBe(lockBytes);
    expect(await hashSkillDirectory(join(t1, 'alpha'))).toBe(alphaHash);
    const t5 = join(home, 'runs', 'five');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'alpha,ghost', '--target', t5])).code).toBe(2);
    await expect(readdir(t5)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('6: giving both selectors exits 2', async () => {
    const home = await setup();
    expect((await runCli(home, ['profile', 'set', 'p1', 'alpha'])).code).toBe(0);
    const run = await runCli(home, ['--json', 'inject', '--profile', 'p1', '--skills', 'alpha', '--target', join(home, 'runs', 'six')]);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_USAGE_INJECT_SELECTION');
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
      expect(change).toMatchObject({ op: 'add', entity: 'skill', target: join(target, String(change.name)) });
    }
    expect(changes.map((change) => change.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('rejects unsafe skill names in profile set before touching the config', async () => {
    const home = await setup();
    for (const [profile, skill] of [['p', '..'], ['q', '../skills/alpha']] as const) {
      const run = await runCli(home, ['--json', 'profile', 'set', profile, skill]);
      expect(run.code).toBe(2);
      expect(errorCodeOf(run)).toBe('E_USAGE_SKILL_NAME');
    }
    const profiles = ((await readConfig(home)).profiles ?? {}) as Record<string, unknown>;
    expect(profiles).not.toHaveProperty('p');
    expect(profiles).not.toHaveProperty('q');
  });

  it('reports unknown profiles as E_PROFILE_NOT_FOUND and lists all profiles without a name', async () => {
    const home = await setup();
    let run = await runCli(home, ['--json', 'inject', '--profile', 'nope', '--target', join(home, 'runs', 'x')]);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_PROFILE_NOT_FOUND');
    run = await runCli(home, ['--json', 'profile', 'ls', 'nope']);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_PROFILE_NOT_FOUND');
    await runCli(home, ['profile', 'set', 'p1', 'alpha']);
    await runCli(home, ['profile', 'set', 'p2', 'beta', 'gamma']);
    run = await runCli(home, ['--json', 'profile', 'ls']);
    expect(run.code).toBe(0);
    expect(resultOf(run).summary.profiles).toEqual({ p1: ['alpha'], p2: ['beta', 'gamma'] });
  });

  it('resolves a relative --target against the working directory', async () => {
    const home = await setup();
    const cwd = await mkdtemp(join(tmpdir(), 'syncskill-inject-cwd-'));
    tempDirs.push(cwd);
    const run = await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', 'rel/out'], cwd);
    expect(run.code).toBe(0);
    expect((await stat(join(cwd, 'rel', 'out', 'alpha'))).isDirectory()).toBe(true);
  });

  it('records source identity and the source repo HEAD for a git-sourced skill', async () => {
    const home = await setup();
    const bareRepoDir = join(home, 'remote.git');
    const workRepoDir = join(home, 'work');
    await git(['init', '--bare', bareRepoDir]);
    await git(['clone', bareRepoDir, workRepoDir]);
    await git(['branch', '-M', 'main'], workRepoDir);
    await mkdir(join(workRepoDir, 'skills', 'delta'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'delta', 'SKILL.md'), '# delta');
    await commitAll(workRepoDir, 'v1');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);
    const install = await runCli(home, ['install', bareRepoDir, '--name', 'demo', '--type', 'git', '--path', 'skills', '--yes']);
    expect(install.code).toBe(0);

    const target = join(home, 'runs', 'git');
    expect((await runCli(home, ['--json', 'inject', '--skills', 'delta', '--target', target])).code).toBe(0);
    const config = JSON.parse(await readFile(join(home, '.syncskill', 'config.json'), 'utf8')) as {
      sources: Record<string, { url: string; branch?: string }>;
    };
    const stored = config.sources.demo!;
    const lock = JSON.parse(await readFile(join(target, 'syncskill-lock.json'), 'utf8'));
    expect(lock.skills).toHaveLength(1);
    const entry = lock.skills[0];
    expect(entry.name).toBe('delta');
    expect(entry.source).toEqual({
      name: 'demo',
      type: 'git',
      url: stored.url,
      ...(stored.branch === undefined ? {} : { branch: stored.branch })
    });
    expect(entry.resolved_commit).toBe((await git(['rev-parse', 'HEAD'], workRepoDir)).trim());
    expect(entry.content_md5).toBe(await hashSkillDirectory(join(target, 'delta')));
  });

  it('9: prototype-chain profile names are not profiles (fix for review I1)', async () => {
    const home = await setup();
    let run = await runCli(home, ['--json', 'profile', 'set', '__proto__', 'alpha']);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_USAGE_PROFILE_NAME');
    run = await runCli(home, ['--json', 'profile', 'ls', 'constructor']);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_PROFILE_NOT_FOUND');
    run = await runCli(home, ['--json', 'profile', 'rm', 'constructor']);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_PROFILE_NOT_FOUND');
    run = await runCli(home, ['--json', 'inject', '--profile', 'toString', '--target', join(home, 'runs', 'proto')]);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_PROFILE_NOT_FOUND');
    // a legitimate own key with a prototype-looking name still works
    expect((await runCli(home, ['--json', 'profile', 'set', 'constructor', 'alpha'])).code).toBe(0);
    run = await runCli(home, ['--json', 'profile', 'ls', 'constructor']);
    expect(run.code).toBe(0);
    expect(resultOf(run).summary).toMatchObject({ profiles: { constructor: ['alpha'] } });
  });

  it('10: inject does not touch the stored manifests (spec 5.6)', async () => {
    const home = await setup();
    const manifests = join(home, '.syncskill', 'manifests');
    const before = await snapshotDir(manifests);
    const run = await runCli(home, ['--json', 'inject', '--skills', 'alpha', '--target', join(home, 'runs', 'm')]);
    expect(run.code).toBe(0);
    expect(await snapshotDir(manifests)).toEqual(before);
  });
});
