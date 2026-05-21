import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { createProgram } from '../../src/index.js';
import { findExistingSourceByUrl, loadSourceState } from '../../src/source.js';

const execFileAsync = promisify(execFile);

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

describe('source CLI', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('source list prints configured sources in sorted order', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        sources: {
          'local-zeta': {
            type: 'local',
            url: join(homeDir, 'source-zeta'),
            path: 'skills'
          },
          'local-alpha': {
            type: 'local',
            url: join(homeDir, 'source-alpha'),
            path: 'bundle'
          },
          zeta: {
            type: 'git',
            url: 'https://example.com/zeta.git',
            path: 'skills',
            branch: 'main'
          },
          alpha: {
            type: 'http',
            url: 'https://example.com/alpha.zip',
            path: 'bundle'
          }
        }
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'list'], { from: 'node' });

    const output = consoleLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Sources:');
    expect(output).toContain('alpha (http)');
    expect(output).toContain('url:     https://example.com/alpha.zip');
    expect(output).toContain('local-alpha (local)');
    expect(output).toContain('local-zeta (local)');
    expect(output).toContain('zeta (git)');
    expect(output).toContain('url:     https://example.com/zeta.git');
  });
});

describe('source add compatibility removal', () => {
  it('source add is no longer available', async () => {
    const help = createProgram('/tmp');
    const sourceCmd = help.commands.find(c => c.name() === 'source');

    expect(sourceCmd?.commands.find(c => c.name() === 'add')).toBeUndefined();
  });
});


describe('skills-registry generation', () => {
  const tempDirs = useTempDirs();

  it('generates skills-registry.json after link --apply', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');

    // Create a skill
    await mkdir(join(skillsDir, 'test-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'test-skill', 'SKILL.md'), '# Test');

    // Create config with agent and link
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: join(homeDir, '.claude', 'skills') },
        links: { 'test-skill': ['claude'] },
        sources: {},
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Run link apply
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'apply'], { from: 'node' });

    // Check skills-registry.json was created
    const registryPath = join(syncDir, 'skills-registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(registry.version).toBe(1);
    expect(registry.skills['test-skill']).toBeDefined();
    expect(registry.skills['test-skill'].origin).toBe('manual');
    expect(registry.skills['test-skill'].status).toBe('active');
  });

  it('generates skills-registry.json after scan', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');

    // Create agent directory
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    // Create a skill not in links
    await mkdir(join(skillsDir, 'new-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'new-skill', 'SKILL.md'), '# New');

    // Create minimal config
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: agentDir },
        links: {},
        sources: {},
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Run scan
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });

    // Check skills-registry.json was created
    const registryPath = join(syncDir, 'skills-registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(registry.skills['new-skill']).toBeDefined();
    expect(registry.skills['new-skill'].status).toBe('active');
  });
});

describe('same-repo merge detection', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('detects existing source with same URL', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-cli-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Create config with existing source
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'repo-skill1': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            path: 'skills/skill1',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Test findExistingSourceByUrl directly
    const match = await findExistingSourceByUrl(homeDir, 'https://github.com/org/repo.git');
    expect(match).not.toBeNull();
    expect(match?.name).toBe('repo-skill1');
  });

});


