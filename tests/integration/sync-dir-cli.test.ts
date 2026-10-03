// tests/integration/sync-dir-cli.test.ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'index.js');

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

// HOME is always a fresh temp dir, so a relocation that silently falls back to HOME is visible as HOME/.syncskill.
async function runCli(homeDir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...extraEnv };
  if (!('SYNCSKILL_DIR' in extraEnv)) delete env.SYNCSKILL_DIR;
  if (!('SYNCSKILL_CONFIG' in extraEnv)) delete env.SYNCSKILL_CONFIG;
  try {
    const result = await execFileAsync('node', [cliPath, ...args], { env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '', code: execError.code ?? 1 };
  }
}

function errorCodeOf(run: CliRun): unknown {
  return [...run.stdout.split('\n'), ...run.stderr.split('\n')]
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.type === 'error')?.code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

describe('syncskill --sync-dir / SYNCSKILL_DIR', () => {
  const tempDirs = useTempDirs();

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function seedSyncDir(syncDir: string, home: string): Promise<void> {
    await mkdir(join(syncDir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(syncDir, 'skills', 'alpha', 'SKILL.md'), '# alpha', 'utf8');
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    await writeFile(
      join(syncDir, 'config.json'),
      JSON.stringify({
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: join(home, '.claude', 'skills') },
        links: {},
        servers: {},
        sources: {}
      }),
      'utf8'
    );
  }

  async function profilesIn(syncDir: string): Promise<unknown> {
    return (JSON.parse(await readFile(join(syncDir, 'config.json'), 'utf8')) as { profiles?: unknown }).profiles;
  }

  it('SYNCSKILL_DIR moves every read and write of profile and inject out of HOME', async () => {
    const home = await tempDir('syncskill-syncdir-home-');
    const syncDir = await tempDir('syncskill-syncdir-root-');
    const target = await tempDir('syncskill-syncdir-target-');
    await seedSyncDir(syncDir, home);

    let run = await runCli(home, ['--json', 'profile', 'set', 'p', 'alpha'], { SYNCSKILL_DIR: syncDir });
    expect(run.code).toBe(0);
    expect(await profilesIn(syncDir)).toEqual({ p: ['alpha'] });

    run = await runCli(home, ['--json', 'inject', '--profile', 'p', '--target', target], { SYNCSKILL_DIR: syncDir });
    expect(run.code).toBe(0);
    expect(await readFile(join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha');
    expect(await exists(join(target, 'syncskill-lock.json'))).toBe(true);

    // Without relocation the same commands would have created HOME/.syncskill.
    expect(await exists(join(home, '.syncskill'))).toBe(false);
  });

  it('--sync-dir wins over SYNCSKILL_DIR', async () => {
    const home = await tempDir('syncskill-syncdir-home-');
    const flagDir = await tempDir('syncskill-syncdir-flag-');
    const envParent = await tempDir('syncskill-syncdir-env-');
    const envDir = join(envParent, 'never');
    await seedSyncDir(flagDir, home);

    const run = await runCli(home, ['--json', '--sync-dir', flagDir, 'profile', 'set', 'p', 'alpha'], { SYNCSKILL_DIR: envDir });
    expect(run.code).toBe(0);
    expect(await profilesIn(flagDir)).toEqual({ p: ['alpha'] });
    expect(await exists(envDir)).toBe(false);
    expect(await exists(join(home, '.syncskill'))).toBe(false);
  });

  it('a relative sync dir is a usage error and creates nothing', async () => {
    const home = await tempDir('syncskill-syncdir-home-');
    const run = await runCli(home, ['--json', 'profile', 'ls'], { SYNCSKILL_DIR: 'relative/dir' });
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_USAGE_SYNC_DIR');
    expect(await readdir(home)).toEqual([]);
  });

  it('--config and SYNCSKILL_CONFIG fail loudly instead of being ignored', async () => {
    const home = await tempDir('syncskill-syncdir-home-');
    let run = await runCli(home, ['--json', '--config', join(home, 'c.json'), 'profile', 'ls']);
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_USAGE_CONFIG_PATH');

    run = await runCli(home, ['--json', 'profile', 'ls'], { SYNCSKILL_CONFIG: join(home, 'c.json') });
    expect(run.code).toBe(2);
    expect(errorCodeOf(run)).toBe('E_USAGE_CONFIG_PATH');
    expect(await readdir(home)).toEqual([]);
  });
});
