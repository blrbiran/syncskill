import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function execWithInput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe'
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(Object.assign(new Error(`Process exited with code ${code}`), { code, stdout, stderr }));
    });

    child.stdin.end(options.input);
  });
}

describe('install CLI command', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = join(import.meta.dirname, `../../.test-tmp-install-cli-${Date.now()}`);
    homeDir = join(tempDir, 'home');
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

    const configPath = join(homeDir, '.syncskill', 'config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          agents: { claude: '~/.claude/skills' },
          links: {},
          servers: {},
          sources: {},
        },
        null,
        2
      )
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should show install command in help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('install');
  });

  it('should accept i as alias for install', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'i', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('Install');
  });

  it('should show install options in help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('--name');
    expect(stdout).toContain('--path');
    expect(stdout).toContain('--branch');
    expect(stdout).toContain('--yes');
  });

  it('shows help when install is called without args in non-tty mode', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('Usage: syncskill install|i [options] [urlOrPath]');
    expect(stdout).toContain('Use "self" for built-in skill');
    expect(stdout).not.toContain('--self');
  });

  it('does not include --self in install help output', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('Use "self" for built-in skill');
    expect(stdout).not.toContain('--self');
  });

  it('rejects the removed --self flag', async () => {
    await expect(
      execFileAsync('npx', ['tsx', 'src/index.ts', 'install', '--self'], {
        env: { ...process.env, HOME: homeDir }
      })
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(''),
      stderr: expect.stringContaining('unknown option')
    });
  });

  it('installs the built-in skill with self', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'dist/index.js', 'install', 'self'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('syncskill');
    expect(stdout).toContain(join(homeDir, '.syncskill', 'skills', 'syncskill'));
    const installedSkills = await readdir(join(homeDir, '.syncskill', 'skills'));
    expect(installedSkills).toContain('syncskill');
  });

  it('outputs plan JSON with --plan install self', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'dist/index.js', '--plan', 'install', 'self'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    });

    const plan = JSON.parse(stdout);
    expect(plan.version).toBe(1);
    expect(plan.command).toBe('install');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].id).toBe('a1');
    expect(plan.actions[0].op).toBe('install-self');
    expect(plan.actions[0].to).toContain('.syncskill/skills/syncskill');
  });

  it('supports deprecated stdin aliases for install self apply flow', async () => {
    const plan = {
      version: 1,
      command: 'install',
      generated_at: '2026-06-02T00:00:00.000Z',
      actions: [
        {
          id: 'a1',
          op: 'install-self',
          to: join(homeDir, '.syncskill', 'skills', 'syncskill')
        }
      ],
      unresolved: [],
      warnings: []
    };

    const { stdout } = await execWithInput(
      'npx',
      ['tsx', 'dist/index.js', '--json', '--apply-stdin', 'install', 'self'],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir },
        input: JSON.stringify(plan)
      }
    );

    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === 'info' && event.message.includes('Deprecated alias: use --apply -'))).toBe(true);

    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary.deprecations).toEqual(['--apply-stdin']);
  });

  it('supports deprecated resolutions stdin alias for install self apply flow', async () => {
    const plan = {
      version: 1,
      command: 'install',
      generated_at: '2026-06-02T00:00:00.000Z',
      actions: [
        {
          id: 'a1',
          op: 'install-self',
          to: join(homeDir, '.syncskill', 'skills', 'syncskill')
        }
      ],
      unresolved: [],
      warnings: []
    };

    const planPath = join(tempDir, 'install-self.plan.json');
    await writeFile(planPath, JSON.stringify(plan), 'utf8');

    const { stdout } = await execWithInput(
      'npx',
      ['tsx', 'dist/index.js', '--json', '--apply', planPath, '--resolutions-stdin', 'install', 'self'],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir },
        input: '{}'
      }
    );

    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === 'info' && event.message.includes('Deprecated alias: use --resolutions -'))).toBe(true);

    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary.deprecations).toEqual(['--resolutions-stdin']);
  });

  it('supports stdin shorthand flags in root help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('--apply <path|->');
    expect(stdout).toContain('--resolutions <path|->');
    expect(stdout).not.toContain('--apply-stdin');
    expect(stdout).not.toContain('--resolutions-stdin');
  });

  it('rejects --plan install --self', async () => {
    await expect(
      execFileAsync('npx', ['tsx', 'src/index.ts', '--plan', 'install', '--self'], {
        env: { ...process.env, HOME: homeDir }
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('unknown option')
    });
  });

  it('installs the built-in skill with self when no local ./self directory exists', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'dist/index.js', 'install', 'self'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('syncskill');
    expect(stdout).toContain(join(homeDir, '.syncskill', 'skills', 'syncskill'));
    const installedSkills = await readdir(join(homeDir, '.syncskill', 'skills'));
    expect(installedSkills).toContain('syncskill');
  });

  it('prefers a real ./self directory over built-in self shorthand', async () => {
    await mkdir(join(import.meta.dirname, '../../self'), { recursive: true });

    try {
      await expect(
        execFileAsync('npx', ['tsx', 'src/index.ts', 'install', 'self'], {
          cwd: join(import.meta.dirname, '../..'),
          env: { ...process.env, HOME: homeDir }
        })
      ).rejects.toThrow('Could not parse URL');
    } finally {
      await rm(join(import.meta.dirname, '../../self'), { recursive: true, force: true });
    }
  });

});
