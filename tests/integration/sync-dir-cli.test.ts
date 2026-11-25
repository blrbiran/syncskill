// tests/integration/sync-dir-cli.test.ts
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
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
        // The guard only has to notice a write; hashing a multi-hundred-MB source tree made the
        // snapshot take longer than the hook budget on machines with a populated ~/.syncskill.
        entries.push(`${rel}|file|${info.size}|${info.mtimeMs}`);
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
  // A populated real ~/.syncskill (330 MB here) can exceed the 10 s default under load; this hook only reads metadata.
}, 60_000);

afterAll(async () => {
  expect(await snapshotDir(realSyncskillDir)).toEqual(realBefore);
}, 60_000);

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

  /**
   * Tester #488: the sync dir relocates the runtime, but the home boundary used to stay on process.env.HOME, so a
   * scratch `--sync-dir` scan adopted the real home's agent directories into the scratch tree. The default location
   * is now contained in the override (`.agent-home`) and is not adopted without the explicit flag either.
   */
  it('scan in a scratch sync-dir imports nothing from the real home (#488)', async () => {
    const realHome = await tempDir('syncskill-syncdir-realhome-');
    await mkdir(join(realHome, '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(realHome, '.claude', 'skills', 'alpha', 'SKILL.md'), '# real alpha', 'utf8');

    const scratch = await tempDir('syncskill-syncdir-scratch-');
    const syncDir = join(scratch, 'home', '.syncskill');
    await mkdir(join(syncDir, '.agent-home', '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(syncDir, '.agent-home', '.claude', 'skills', 'alpha', 'SKILL.md'), '# default alpha', 'utf8');
    await writeFile(join(syncDir, 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {}
    }), 'utf8');

    const run = await runCli(realHome, ['--sync-dir', syncDir, 'scan']);
    expect(run.code).toBe(0);

    const cfg = JSON.parse(await readFile(join(syncDir, 'config.json'), 'utf8')) as { links: Record<string, unknown> };
    // mutation: adopt the real home's agent directories again -> alpha is copied and linked, red
    // mutation: drop the migrateUnmanaged gate -> the contained default alpha is adopted, red
    expect(Object.keys(cfg.links)).toEqual([]);
    expect(await exists(join(syncDir, 'skills', 'alpha'))).toBe(false);
    expect(run.stdout).not.toContain('Found new skills in sources');
  });

  it('scan names where new skills actually came from (#488)', async () => {
    const home = await tempDir('syncskill-syncdir-home-');
    const scratch = await tempDir('syncskill-syncdir-scratch-');
    const syncDir = join(scratch, 'home', '.syncskill');
    await mkdir(join(syncDir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(syncDir, 'skills', 'alpha', 'SKILL.md'), '# alpha', 'utf8');
    await writeFile(join(syncDir, 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {}
    }), 'utf8');

    const run = await runCli(home, ['--sync-dir', syncDir, 'scan']);
    expect(run.code).toBe(0);
    // mutation: keep the old wording -> "sources" claims an origin the skill did not come from, red
    expect(run.stdout).toContain('Found new skills in the sync skills directory and configured sources:');
  });

  /**
   * Tester #488: inside the relocated tree, adopting agent directories is exactly the silent import the override is
   * supposed to avoid, so it waits for the flag the scan command already documents. The flag's target is the contained
   * default home `<sync-dir>/.agent-home` -- neither the real home nor the override's ancestor is touched.
   */
  it('scan under --sync-dir adopts agent directories only with --migrate-unmanaged (#488)', async () => {
    const realHome = await tempDir('syncskill-syncdir-realhome-');
    await mkdir(join(realHome, '.claude', 'skills', 'beta'), { recursive: true });
    await writeFile(join(realHome, '.claude', 'skills', 'beta', 'SKILL.md'), '# beta', 'utf8');

    const scratch = await tempDir('syncskill-syncdir-scratch-');
    const syncDir = join(scratch, 'home', '.syncskill');
    // The old ancestor boundary: a skill here must never be adopted.
    const ancestor = dirname(dirname(syncDir));
    await mkdir(join(ancestor, '.claude', 'skills', 'gamma'), { recursive: true });
    await writeFile(join(ancestor, '.claude', 'skills', 'gamma', 'SKILL.md'), '# gamma', 'utf8');
    // The contained default home the scan should use.
    const syntheticHome = join(syncDir, '.agent-home');
    await mkdir(join(syntheticHome, '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(syntheticHome, '.claude', 'skills', 'alpha', 'SKILL.md'), '# alpha', 'utf8');
    await writeFile(join(syncDir, 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {}
    }), 'utf8');

    let run = await runCli(realHome, ['--sync-dir', syncDir, 'scan']);
    expect(run.code).toBe(0);
    let cfg = JSON.parse(await readFile(join(syncDir, 'config.json'), 'utf8')) as { links: Record<string, unknown> };
    // mutation: drop the migrateUnmanaged gate -> alpha is adopted without the flag, red
    expect(Object.keys(cfg.links)).toEqual([]);
    expect(await exists(join(syncDir, 'skills', 'alpha'))).toBe(false);

    run = await runCli(realHome, ['--sync-dir', syncDir, 'scan', '--migrate-unmanaged']);
    expect(run.code).toBe(0);
    cfg = JSON.parse(await readFile(join(syncDir, 'config.json'), 'utf8')) as { links: Record<string, unknown> };
    // mutation: put process.env.HOME back as the boundary -> beta is adopted, red
    // mutation: use dirname(dirname(syncDir)) again -> gamma is adopted, red
    expect(Object.keys(cfg.links)).toEqual(['alpha']);
    expect(await exists(join(syncDir, 'skills', 'alpha'))).toBe(true);
    expect(await exists(join(syncDir, 'skills', 'beta'))).toBe(false);
    expect(await exists(join(syncDir, 'skills', 'gamma'))).toBe(false);
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
