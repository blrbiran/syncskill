import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { createFakeSshBin } from '../helpers/fake-ssh.js';
import { saveConfig } from '../../src/config/config.js';
import { saveServerManifest, type ManifestSkillState } from '../../src/core/manifest.js';
import { createProgram } from '../../src/index.js';

// Tester #484: what a real push/pull/sync sends to the remote over ssh (transport.ts); a preview sends none of it.
const WRITE_VERBS = ['rm -rf', 'mkdir -p', 'cat >', 'rsync', 'apply', 'write-manifest'];

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

// Tester #484: the root --plan ("Output plan without executing") was silently ignored by push/pull/sync, which then
// really pushed. Runs in-process against src with the real runtime and a fake ssh that logs every call (no network).
describe('--plan (#484)', () => {
  const tempDirs = useTempDirs();
  const saved = { PATH: process.env.PATH, json: process.env.FAKE_SSH_MANIFEST_JSON, listing: process.env.FAKE_SSH_LISTING };
  const synced = (hash: string): ManifestSkillState => ({ local_hash: hash, remote_hash: hash, recorded_hash: hash, direction: 'skip', status: 'in-sync' });
  let sshLog = '';

  beforeEach(async () => {
    const bin = await createFakeSshBin();
    const logBin = await mkdtemp(join(tmpdir(), 'syncskill-sshlog-'));
    tempDirs.push(bin, logBin);
    sshLog = join(logBin, 'calls.log');
    await writeFile(sshLog, '', 'utf8');
    await writeFile(join(logBin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\nexec '${join(bin, 'ssh')}' "$@"\n`, 'utf8');
    await chmod(join(logBin, 'ssh'), 0o755);
    process.env.PATH = `${logBin}:/usr/bin:/bin`;
    process.env.FAKE_SSH_MANIFEST_JSON = JSON.stringify({ version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z', skills: { alpha: synced('a1') } });
    process.env.FAKE_SSH_LISTING = 'alpha';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.json === undefined) delete process.env.FAKE_SSH_MANIFEST_JSON; else process.env.FAKE_SSH_MANIFEST_JSON = saved.json;
    if (saved.listing === undefined) delete process.env.FAKE_SSH_LISTING; else process.env.FAKE_SSH_LISTING = saved.listing;
  });

  /** alpha was synced as `a1` and has changed on disk since, so a real push has something to write. */
  async function fixture(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-plan-'));
    tempDirs.push(home);
    await saveConfig({
      version: 1, conflict_resolution: 'manual', agents: {}, links: { alpha: ['claude'] },
      servers: { lab: { host: 'lab.example.invalid', remote_agents: { claude: '~/.claude/skills' }, skills: { include: ['alpha'] } } },
      sources: {},
    } as never, home);
    await mkdir(join(home, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(home, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# alpha, edited\n', 'utf8');
    await saveServerManifest(home, { version: 1, server: 'lab', updated_at: '2026-01-01T00:00:00Z', skills: { alpha: synced('a1') } });
    return home;
  }

  /** process.exit throws so a refusal really stops the command, as it does outside the test. */
  async function run(home: string, argv: string[]): Promise<{ lines: string[]; exitCode: number | undefined; thrown?: unknown }> {
    const lines: string[] = [];
    let exitCode: number | undefined;
    let thrown: unknown;
    const capture = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; throw new Error(`exit ${code}`); }) as never);
    try {
      await createProgram(home).parseAsync(['node', 'syncskill', ...argv], { from: 'node' });
    } catch (error) {
      // a real transfer against the fake ssh throws; keep it so the write-verb assertion is what goes red
      if (exitCode === undefined) thrown = error;
    } finally {
      vi.restoreAllMocks();
    }
    return { lines, exitCode, thrown };
  }

  async function writeCalls(): Promise<string[]> {
    return (await readFile(sshLog, 'utf8')).split('\n').filter((call) => WRITE_VERBS.some((verb) => call.includes(verb)));
  }

  it.each([['push'], ['pull'], ['sync']])('--plan on %s runs as a dry run: no write verb is ever sent', async (command) => {
    const home = await fixture();
    const result = await run(home, ['--plan', command, 'lab']);
    // mutation: drop the --plan tuple in the preAction loop -> a real push/pull/sync sends write verbs, red
    expect(await writeCalls()).toEqual([]);
    // Tester #555 (session 1cdb9811): --plan is a dry run, so it sends no SSH at all; an empty log is
    // a measurement of that, not a skipped command.
    expect((await readFile(sshLog, 'utf8').catch(() => '')).trim()).toBe('');
    expect(result.thrown).toBeUndefined();
    expect(result.exitCode ?? 0, result.lines.join('\n')).toBe(0);
  });

  it('--plan on push prints the push plan', async () => {
    const home = await fixture();
    const result = await run(home, ['--plan', 'push', 'lab']);
    expect(result.lines.join('\n')).toContain('[dry-run] push to lab');
  });

  it('--plan on a command with no dry run is refused, not silently ignored', async () => {
    const home = await fixture();
    const result = await run(home, ['--json', '--plan', 'config', 'show']);
    // mutation: never refuse --plan -> config show runs and exits 0, red
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('E_USAGE_GLOBAL_FLAG');
    // the person typed --plan; naming --dry-run instead would point them at a flag they never passed
    // mutation: report `${long}` instead of `${flag}` -> "--dry-run is not supported by", red
    expect(result.lines.join('\n')).toContain('--plan is not supported by');
  });

  it('--plan on install is install\'s own plan: not refused, and nothing is installed', async () => {
    const home = await fixture();
    const source = await mkdtemp(join(tmpdir(), 'syncskill-plan-src-'));
    tempDirs.push(source);
    await mkdir(join(source, 'beta'), { recursive: true });
    await writeFile(join(source, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\n# beta\n', 'utf8');
    const configBefore = await readFile(join(home, '.syncskill', 'config.json'), 'utf8');
    // -y keeps a mutated install from stopping at the interactive skill picker: it would hang, not fail on the checks below
    const result = await run(home, ['--plan', 'install', source, '-y']);
    // mutation: drop install's exemption -> E_USAGE_GLOBAL_FLAG, exit 2, red
    expect(result.exitCode ?? 0, result.lines.join('\n')).toBe(0);
    expect(result.lines.join('\n')).not.toContain('E_USAGE_GLOBAL_FLAG');
    // mutation: force install's planMode to false -> the source is registered and beta copied in, red
    expect(await readFile(join(home, '.syncskill', 'config.json'), 'utf8')).toBe(configBefore);
    expect((await readdir(join(home, '.syncskill', 'skills'))).sort()).toEqual(['alpha']);
  });
});