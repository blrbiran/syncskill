import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('source remove emits JSON summary for complete removal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-json-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');
    const sourceDir = join(syncDir, '.sources', 'demo');
    const agentDir = join(homeDir, '.claude', 'skills');

    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '# skill-a');
    await mkdir(join(sourceDir, 'materialized', 'skill-a'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(join(skillsDir, 'skill-a'), join(agentDir, 'skill-a'));
    await writeFile(
      join(sourceDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-06-02T00:00:00.000Z' })
    );
    await mkdir(join(syncDir, '.sources'), { recursive: true });
    await writeFile(join(syncDir, '.sources', 'skills.json'), JSON.stringify({ owners: { 'skill-a': 'demo' } }));
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, { claude: agentDir }),
        links: { 'skill-a': ['claude'] },
        sources: {
          demo: {
            type: 'git',
            url: 'https://example.com/demo.git',
            path: '.'
          }
        }
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', 'source', 'remove', 'demo', '--force'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('source remove');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary).toMatchObject({
      name: 'demo',
      mode: 'completely',
      removed_skills: ['skill-a'],
      removed_links: [
        {
          skill: 'skill-a',
          agents: ['claude'],
          plan_ref: 'a1'
        }
      ]
    });
    expect(resultEvent.summary.deleted_paths).toEqual(
      expect.arrayContaining([
        join(skillsDir, 'skill-a'),
        join(syncDir, '.sources', 'demo')
      ])
    );
  });

  it('link build emits JSON summary with symlink plan refs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-build-json-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');

    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '# skill-a');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await symlink(join(skillsDir, 'skill-a'), join(cursorDir, 'skill-a'));
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, { claude: claudeDir, cursor: cursorDir }),
        links: { 'skill-a': ['claude'] }
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', 'link', 'build', '-y'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('link build');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary).toEqual({
      changes: [
        {
          skill: 'skill-a',
          config_before: ['claude'],
          config_after: ['claude'],
          symlinks_created: [
            {
              agent: 'claude',
              path: join(claudeDir, 'skill-a'),
              plan_ref: 'a1'
            }
          ],
          symlinks_removed: [
            {
              agent: 'cursor',
              path: join(cursorDir, 'skill-a'),
              plan_ref: 'a2'
            }
          ]
        }
      ]
    });
  });

  it('link build includes shared agents symlinks in JSON summary', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-build-shared-json-'));
    tempDirs.push(homeDir);
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const sharedDir = join(homeDir, '.agents', 'skills');

    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '# skill-a');
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: { 'skill-a': ['agents'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', '--json', 'link', 'build', '-y'], { from: 'node' });

    const events = consoleLog.mock.calls.map((call) => JSON.parse(call[0] as string));
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent.command).toBe('link build');
    expect(resultEvent.ok).toBe(true);
    expect(resultEvent.summary).toEqual({
      changes: [
        {
          skill: 'skill-a',
          config_before: ['agents'],
          config_after: ['agents'],
          symlinks_created: [
            {
              agent: 'agents',
              path: join(sharedDir, 'skill-a'),
              plan_ref: 'a1'
            }
          ],
          symlinks_removed: []
        }
      ]
    });
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

  it('generates skills-registry.json after link build', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-link-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');

    // Create a skill
    await mkdir(join(skillsDir, 'test-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'test-skill', 'SKILL.md'), '# Test');

    // Create config with agent and link
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, { claude: join(homeDir, '.claude', 'skills') }),
        links: { 'test-skill': ['claude'] },
      },
      homeDir
    );

    // Run link build
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'build'], { from: 'node' });

    // Check skills-registry.json was created
    const registryPath = join(syncDir, 'skills-registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(registry).toEqual({
      version: 2,
      http_baselines: {}
    });
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
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, { claude: agentDir }),
        links: {},
      },
      homeDir
    );

    // Run scan
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });

    // Check skills-registry.json was created
    const registryPath = join(syncDir, 'skills-registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(registry).toEqual({
      version: 2,
      http_baselines: {}
    });
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
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        links: { skill1: ['*'] },
        sources: {
          'repo-skill1': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            path: 'skills/skill1',
          },
        },
      },
      homeDir
    );

    // Test findExistingSourceByUrl directly
    const match = await findExistingSourceByUrl(homeDir, 'https://github.com/org/repo.git');
    expect(match).not.toBeNull();
    expect(match?.name).toBe('repo-skill1');
  });

});


