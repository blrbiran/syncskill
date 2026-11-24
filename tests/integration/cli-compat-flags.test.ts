import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

// Issue 411: scripts written for the mature CLI pass --config and program-level --dry-run / -y, and
// push used to take --on-local-deletion. Each must either work losslessly or refuse with a next step
// instead of a bare "unknown option".
const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'index.js');

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(homeDir: string, args: string[]): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.SYNCSKILL_DIR;
  delete env.SYNCSKILL_CONFIG;
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '', code: execError.code ?? 1 };
  }
}

function errorCodeOf(run: CliRun): unknown {
  for (const line of [...run.stdout.split('\n'), ...run.stderr.split('\n')]) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'error') return event.code;
    } catch {
      // pretty-printed output; not an event line
    }
  }
  return undefined;
}

describe('mature-CLI compatibility flags', () => {
  const tempDirs = useTempDirs();

  async function initializedHome(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-compat-'));
    tempDirs.push(homeDir);
    const init = await runCli(homeDir, ['init']);
    expect(init.code).toBe(0);
    return homeDir;
  }

  it('--config naming the config file acts like --sync-dir', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--json', '--config', join(homeDir, '.syncskill', 'config.json'), 'config', 'show']);
    expect(run.code).toBe(0);
    expect(errorCodeOf(run)).toBeUndefined();
  });

  it('--config naming anything else is refused with the supported alternative', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--json', '--config', join(homeDir, 'elsewhere.json'), 'config', 'show']);
    expect(errorCodeOf(run)).toBe('E_USAGE_CONFIG_PATH');
    expect(run.stdout + run.stderr).toContain('--sync-dir');
  });

  it('a program-level --dry-run reaches a command that declares it', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--dry-run', '--json', 'scan']);
    expect(run.code).toBe(0);
    expect(errorCodeOf(run)).toBeUndefined();
  });

  it('a program-level --dry-run is refused by a command that does not declare it', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--json', '--dry-run', 'config', 'show']);
    expect(errorCodeOf(run)).toBe('E_USAGE_GLOBAL_FLAG');
  });

  it('--quiet is refused with a next step', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--json', '--quiet', 'config', 'show']);
    expect(errorCodeOf(run)).toBe('E_USAGE_GLOBAL_FLAG');
    expect(run.stdout + run.stderr).toContain('--json');
  });

  // Tester #473: -V/--version was missing, so neither a person nor a script could tell installed builds apart.
  it('-V and --version print the package version and exit 0', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-version-'));
    const { version } = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    for (const flag of ['-V', '--version']) {
      const run = await runCli(homeDir, [flag]);
      // mutation: drop program.version(...) -> commander's unknown option, exit 1, red
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe(version);
    }
  });

  it('--on-local-deletion on push is refused with a next step', async () => {
    const homeDir = await initializedHome();
    const run = await runCli(homeDir, ['--json', 'push', '--on-local-deletion', 'delete']);
    expect(errorCodeOf(run)).toBe('E_USAGE_ON_LOCAL_DELETION');
    expect(run.stdout + run.stderr).toContain('--yes-destructive');
  });
});