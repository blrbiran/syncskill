import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', cwd === undefined ? args : ['-C', cwd, ...args]);
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await git(['add', '.'], repoDir);
  await git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', message], repoDir);
}

async function createGitSourceFixture(homeDir: string): Promise<{ bareRepoDir: string; workRepoDir: string }> {
  const bareRepoDir = join(homeDir, 'remote.git');
  const workRepoDir = join(homeDir, 'work');

  await git(['init', '--bare', bareRepoDir]);
  await git(['clone', bareRepoDir, workRepoDir]);
  await git(['branch', '-M', 'main'], workRepoDir);

  return { bareRepoDir, workRepoDir };
}

describe('install CLI command', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = join(import.meta.dirname, `../../.test-tmp-install-cli-${Date.now()}`);
    homeDir = join(tempDir, 'home');
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });

    const configPath = join(homeDir, '.syncskill', 'config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          agents: { claude: join(homeDir, '.claude', 'skills') },
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
    expect(stdout).toContain('--type');
    expect(stdout).toContain('--branch');
    expect(stdout).toContain('--yes');
  });

  it('shows help when install is called without args in non-tty mode', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('Usage: syncskill install|i [options] [url-or-path]');
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
    expect(Array.isArray(plan.actions)).toBe(true);

    const installSelfAction = plan.actions.find((action: { op: string }) => action.op === 'install-self');
    expect(installSelfAction).toBeDefined();
    expect(installSelfAction.id).toBe('a1');
    expect(installSelfAction.to).toContain('.syncskill/skills/syncskill');
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

  it('emits a result hint when install is called without args in json mode', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', '--json', 'install'], {
      env: { ...process.env, HOME: homeDir }
    });

    const event = JSON.parse(stdout.trim());
    expect(event.type).toBe('result');
    expect(event.command).toBe('install');
    expect(event.ok).toBe(true);
    expect(event.summary.message).toBe('no target provided; use `install self` or `install <url>`');
    expect(event.summary.data).toEqual({
      hint: 'first-run users: run `syncskill init` for guided setup'
    });
  });

  it('treats self as the built-in reserved keyword even when ./self exists', async () => {
    await mkdir(join(import.meta.dirname, '../../self'), { recursive: true });

    try {
      const { stdout, stderr } = await execFileAsync('npx', ['tsx', 'dist/index.js', 'install', 'self'], {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      });

      expect(stdout).toContain('syncskill');
      expect(stdout).toContain(join(homeDir, '.syncskill', 'skills', 'syncskill'));
      expect(stderr).toContain('A directory named "./self" exists');
      expect(stderr).toContain('syncskill install ./self');
    } finally {
      await rm(join(import.meta.dirname, '../../self'), { recursive: true, force: true });
    }
  });

  it('installs skills from a local directory source', async () => {
    const sourceRoot = join(homeDir, 'local-source');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha');

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', sourceRoot, '--yes'],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      }
    );

    expect(stdout).toContain('Installed 1 skill(s)');
    expect(stdout).toContain('Linked to: claude');

    const config = JSON.parse(await readFile(join(homeDir, '.syncskill', 'config.json'), 'utf8'));
    expect(config.sources['local-source']).toEqual({
      type: 'local',
      url: sourceRoot,
      path: '.'
    });
    expect(config.links.alpha).toEqual(['agents', 'claude']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha');
  });

  it('outputs plan JSON with --plan install local directory source', async () => {
    const sourceRoot = join(homeDir, 'planned-local-source');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha');

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--plan', 'install', sourceRoot],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      }
    );

    const plan = JSON.parse(stdout);
    expect(plan.version).toBe(1);
    expect(plan.command).toBe('install');
    expect(plan.actions.some((action: { op: string }) => action.op === 'install-source')).toBe(true);
    expect(plan.unresolved).toEqual([
      expect.objectContaining({
        kind: 'skill-selection',
        resolve_phase: 'execute',
        default_under_y: 'all'
      })
    ]);
  });

  it('applies a planned local directory install with resolutions', async () => {
    const sourceRoot = join(homeDir, 'apply-local-source');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha');

    const { stdout: planStdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--plan', 'install', sourceRoot],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      }
    );

    const planPath = join(tempDir, 'install-local.plan.json');
    await writeFile(planPath, planStdout, 'utf8');

    const { stdout } = await execWithInput(
      'npx',
      ['tsx', 'dist/index.js', '--json', '--apply', planPath, '--resolutions-stdin', 'install', sourceRoot],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir },
        input: JSON.stringify({
          'skill-selection': {
            selected: ['alpha']
          }
        })
      }
    );

    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary.source).toEqual({
      name: 'apply-local-source',
      type: 'local',
      url: sourceRoot,
      path: '.'
    });
    expect(resultEvent.summary.data.skills.installed).toEqual([
      expect.objectContaining({ name: 'alpha' })
    ]);
    expect(resultEvent.summary.data.skills.ignored).toEqual([]);
    expect(resultEvent.summary.data.skills.already_installed).toEqual([]);
    expect(resultEvent.summary.data.links_created).toEqual([
      expect.objectContaining({ skill: 'alpha', agent: 'claude' })
    ]);

    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha');
  });

  it('rejects planned local directory install apply without resolutions', async () => {
    const sourceRoot = join(homeDir, 'missing-resolution-source');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha');

    const { stdout: planStdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--plan', 'install', sourceRoot],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      }
    );

    const planPath = join(tempDir, 'install-local-missing-resolution.plan.json');
    await writeFile(planPath, planStdout, 'utf8');

    await expect(
      execFileAsync(
        'npx',
        ['tsx', 'dist/index.js', '--json', '--apply', planPath, 'install', sourceRoot],
        {
          cwd: join(import.meta.dirname, '../..'),
          env: { ...process.env, HOME: homeDir }
        }
      )
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"code":"E_UNRESOLVED"')
    });
  });

  it('rejects interactive external install in json mode without -y or resolutions', async () => {
    const sourceRoot = join(homeDir, 'json-needs-input-source');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha');

    await expect(
      execFileAsync(
        'npx',
        ['tsx', 'dist/index.js', '--json', 'install', sourceRoot],
        {
          cwd: join(import.meta.dirname, '../..'),
          env: { ...process.env, HOME: homeDir }
        }
      )
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"code":"E_NEEDS_INPUT"')
    });
  });

  it('retries install when config links exist but local skill files are missing', async () => {
    const sourceRoot = join(homeDir, 'retry-source');
    await mkdir(join(sourceRoot, 'skills', 'retry-skill'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'retry-skill', 'SKILL.md'), '# retry');

    const configPath = join(homeDir, '.syncskill', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.links['retry-skill'] = ['claude'];
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', sourceRoot, '--yes'],
      {
        cwd: join(import.meta.dirname, '../..'),
        env: { ...process.env, HOME: homeDir }
      }
    );

    expect(stdout).toContain('Installed 1 skill(s)');
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'retry-skill', 'SKILL.md'), 'utf8')).resolves.toBe('# retry');
  });

  it('reports already-installed skills when reinstalling the same git subdir skill', async () => {
    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

    await mkdir(join(workRepoDir, 'skills', 'research', 'arxiv'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'research', 'arxiv', 'SKILL.md'), '# arxiv');
    await commitAll(workRepoDir, 'Add arxiv skill');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const commonOptions = {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    };

    const first = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--name', 'demo-source', '--type', 'git', '--path', 'skills/research/arxiv', '--yes'],
      commonOptions
    );
    expect(first.stdout).toContain('Installed 1 skill(s)');

    const second = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--type', 'git', '--path', 'skills/research/arxiv', '--yes'],
      commonOptions
    );
    expect(second.stdout).toContain('Already installed: arxiv');
    expect(second.stdout).not.toContain('No skills installed.');
  });

  it('emits already_installed in json output when reinstalling the same git subdir skill', async () => {
    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

    await mkdir(join(workRepoDir, 'skills', 'research', 'arxiv'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'research', 'arxiv', 'SKILL.md'), '# arxiv');
    await commitAll(workRepoDir, 'Add arxiv skill');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const commonOptions = {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    };

    await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--name', 'demo-source', '--type', 'git', '--path', 'skills/research/arxiv', '--yes'],
      commonOptions
    );

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--json', 'install', bareRepoDir, '--type', 'git', '--path', 'skills/research/arxiv', '--yes'],
      commonOptions
    );

    const resultEvent = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'result');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary.installedSkills).toEqual([]);
    expect(resultEvent.summary.data.skills.installed).toEqual([]);
    expect(resultEvent.summary.data.skills.already_installed).toEqual(['arxiv']);
  });

  it('merges same-repo installs into one source and activates the newly requested skill', async () => {
    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

    await mkdir(join(workRepoDir, 'skills', 'alpha', 'alpha'), { recursive: true });
    await mkdir(join(workRepoDir, 'skills', 'beta', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'alpha', 'alpha', 'SKILL.md'), '# alpha');
    await writeFile(join(workRepoDir, 'skills', 'beta', 'beta', 'SKILL.md'), '# beta');
    await commitAll(workRepoDir, 'Add alpha and beta skills');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const commonOptions = {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    };

    const first = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--name', 'demo-source', '--type', 'git', '--path', 'skills/alpha', '--yes'],
      commonOptions
    );
    expect(first.stdout).toContain('Installed 1 skill(s)');

    const second = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--type', 'git', '--path', 'skills/beta', '--yes'],
      commonOptions
    );
    expect(second.stdout).toContain('Installed 1 skill(s)');
    expect(second.stdout).toContain('Linked to: claude');

    const config = JSON.parse(await readFile(join(homeDir, '.syncskill', 'config.json'), 'utf8'));
    expect(Object.keys(config.sources)).toHaveLength(1);
    expect(config.sources['demo-source'].path).toBe('skills');
    expect(config.sources['demo-source'].ignore).toBeUndefined();
    expect(config.links.alpha).toEqual(['agents', 'claude']);
    expect(config.links.beta).toEqual(['agents', 'claude']);
    expect(Object.keys(config.sources)).toHaveLength(1);
    expect(config.sources['demo-source'].path).toBe('skills');
    expect(config.sources['demo-source'].ignore).toBeUndefined();
    expect(config.links.alpha).toEqual(['agents', 'claude']);
    expect(config.links.beta).toEqual(['agents', 'claude']);
  }, 15000);

  it('does not require resolutions for planned same-repo install apply', async () => {
    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

    await mkdir(join(workRepoDir, 'skills', 'alpha', 'alpha'), { recursive: true });
    await mkdir(join(workRepoDir, 'skills', 'beta', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'alpha', 'alpha', 'SKILL.md'), '# alpha');
    await writeFile(join(workRepoDir, 'skills', 'beta', 'beta', 'SKILL.md'), '# beta');
    await commitAll(workRepoDir, 'Add alpha and beta skills');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const commonOptions = {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    };

    await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', 'install', bareRepoDir, '--name', 'demo-source', '--type', 'git', '--path', 'skills/alpha', '--yes'],
      commonOptions
    );

    const { stdout: planStdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--plan', 'install', bareRepoDir, '--type', 'git', '--path', 'skills/beta'],
      commonOptions
    );

    const plan = JSON.parse(planStdout);
    expect(plan.unresolved).toEqual([]);

    const planPath = join(tempDir, 'same-repo-install.plan.json');
    await writeFile(planPath, planStdout, 'utf8');

    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'dist/index.js', '--json', '--apply', planPath, 'install', bareRepoDir, '--type', 'git', '--path', 'skills/beta'],
      commonOptions
    );

    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary.data.skills.installed).toEqual([
      expect.objectContaining({ name: 'beta' })
    ]);

    const config = JSON.parse(await readFile(join(homeDir, '.syncskill', 'config.json'), 'utf8'));
    expect(config.sources['demo-source'].path).toBe('skills');
    expect(config.links.beta).toEqual(['agents', 'claude']);
  }, 15000);

});
