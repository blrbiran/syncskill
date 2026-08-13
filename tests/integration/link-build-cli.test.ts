// tests/integration/link-build-cli.test.ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect } from 'vitest';
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

describe('syncskill link build', () => {
  const tempDirs = useTempDirs();

  /**
   * config.links references a skill that exists nowhere: not in
   * ~/.syncskill/skills/ and not in any configured source. `link build` must
   * still link everything else, but must not claim success.
   */
  async function setupPartialFailure(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-build-'));
    tempDirs.push(homeDir);

    const agentDir = join(homeDir, '.claude', 'skills');
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'real-skill', 'SKILL.md'), '# real', 'utf8');

    await writeFile(
      join(homeDir, '.syncskill', 'config.json'),
      JSON.stringify({
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { 'ghost-skill': ['claude'], 'real-skill': ['claude'] },
        servers: {},
        sources: {}
      }),
      'utf8'
    );

    return homeDir;
  }

  it('exits non-zero when some configured links could not be created', async () => {
    const homeDir = await setupPartialFailure();

    const run = await runCli(homeDir, ['--json', 'link', 'build']);

    expect(run.code).not.toBe(0);
  });

  it('reports ok:false while still linking the skills that did resolve', async () => {
    const homeDir = await setupPartialFailure();

    const run = await runCli(homeDir, ['--json', 'link', 'build']);
    const result = parseEvents(run).find((event) => event.type === 'result');

    expect(result).toMatchObject({ command: 'link build', ok: false });
    await expect(readlink(join(homeDir, '.claude', 'skills', 'real-skill'))).resolves.toBe(
      join(homeDir, '.syncskill', 'skills', 'real-skill')
    );
  });

  it('points an unresolvable skill at `syncskill update` before `doctor --fix`', async () => {
    const homeDir = await setupPartialFailure();

    const run = await runCli(homeDir, ['--json', 'link', 'build']);
    const warning = parseEvents(run).find(
      (event) => event.type === 'warning' && event.code === 'W_LINK_SKIPPED'
    );

    expect(warning?.hint).toContain('syncskill update');
  });

  /**
   * A stale link makes `link build` ask before removing it. execFile gives the
   * child pipes rather than a TTY, so the prompt can never be answered: it used
   * to either crash with ExitPromptError or hang forever waiting on stdin.
   */
  it('reports needs-input instead of prompting when no terminal is attached', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-build-'));
    tempDirs.push(homeDir);

    const agentDir = join(homeDir, '.claude', 'skills');
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(skillsDir, 'orphan-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'orphan-skill', 'SKILL.md'), '# orphan', 'utf8');

    // Linked on disk but absent from config.links, so `link build` wants to
    // remove it and asks first.
    await symlink(join(skillsDir, 'orphan-skill'), join(agentDir, 'orphan-skill'));

    await writeFile(
      join(homeDir, '.syncskill', 'config.json'),
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

    const run = await runCli(homeDir, ['--json', 'link', 'build']);

    expect(run.code).toBe(4);
    expect(run.stdout + run.stderr).toContain('E_NEEDS_INPUT');
    // The link is left alone rather than removed without consent.
    await expect(readlink(join(agentDir, 'orphan-skill'))).resolves.toBe(
      join(skillsDir, 'orphan-skill')
    );
  }, 20000);

  it('exits zero when every configured link resolves', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-build-'));
    tempDirs.push(homeDir);

    const agentDir = join(homeDir, '.claude', 'skills');
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'real-skill', 'SKILL.md'), '# real', 'utf8');

    await writeFile(
      join(homeDir, '.syncskill', 'config.json'),
      JSON.stringify({
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { 'real-skill': ['claude'] },
        servers: {},
        sources: {}
      }),
      'utf8'
    );

    const run = await runCli(homeDir, ['--json', 'link', 'build']);
    const result = parseEvents(run).find((event) => event.type === 'result');

    expect(run.code).toBe(0);
    expect(result).toMatchObject({ ok: true });
  });
});
