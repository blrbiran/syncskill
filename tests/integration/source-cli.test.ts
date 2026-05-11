import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
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

  it('source add saves a local source config and materializes skills immediately', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'shared',
        '--type',
        'local',
        '--url',
        sourceRoot,
        '--path',
        '.'
      ],
      { from: 'node' }
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      sources: {
        shared: {
          type: 'local',
          url: sourceRoot,
          path: '.'
        }
      }
    });
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceRoot, 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: expect.any(String)
    });
  });

  it('source add stores a git source definition without materializing it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'team',
        '--type',
        'git',
        '--url',
        'https://example.com/team.git',
        '--path',
        'skills',
        '--ref',
        'main'
      ],
      { from: 'node' }
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      sources: {
        team: {
          type: 'git',
          url: 'https://example.com/team.git',
          path: 'skills',
          ref: 'main'
        }
      }
    });
    await expect(access(join(homeDir, '.syncskill', 'skills', 'team'))).rejects.toThrow();
  });

  it('source add rolls back config when local materialization fails because the target is occupied', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');

    await expect(
      createProgram(homeDir).parseAsync(
        [
          'node',
          'syncskill',
          'source',
          'add',
          'shared',
          '--type',
          'local',
          '--url',
          sourceRoot,
          '--path',
          '.'
        ],
        { from: 'node' }
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');

    await expect(loadConfig(homeDir)).resolves.toMatchObject({ sources: {} });
  });

  it('source update <name> refreshes one configured git source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'team',
        '--type',
        'git',
        '--url',
        bareRepoDir,
        '--path',
        'source.path',
        '--ref',
        'main'
      ],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'update', 'team'], { from: 'node' });

    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'update', 'team'], { from: 'node' });

    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v2\n');
    await expect(loadSourceState(homeDir, 'team')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: expect.any(String)
    });
  });

  it('source update --all refreshes all configured sources', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const sourceAlpha = join(homeDir, 'source-alpha');
    const sourceBeta = join(homeDir, 'source-beta');
    await mkdir(join(sourceAlpha, 'skills', 'alpha'), { recursive: true });
    await mkdir(join(sourceBeta, 'bundle', 'beta'), { recursive: true });
    await writeFile(join(sourceAlpha, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(sourceBeta, 'bundle', 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'alpha-source',
        '--type',
        'local',
        '--url',
        sourceAlpha,
        '--path',
        'skills'
      ],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'beta-source',
        '--type',
        'local',
        '--url',
        sourceBeta,
        '--path',
        'bundle'
      ],
      { from: 'node' }
    );

    await rm(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true, force: true });
    await rm(join(homeDir, '.syncskill', 'skills', 'beta'), { recursive: true, force: true });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'update', '--all'], { from: 'node' });

    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceAlpha, 'skills', 'alpha'));
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'beta'))).resolves.toBe(join(sourceBeta, 'bundle', 'beta'));
    await expect(loadSourceState(homeDir, 'alpha-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: expect.any(String)
    });
    await expect(loadSourceState(homeDir, 'beta-source')).resolves.toEqual({
      materialized_skills: ['beta'],
      updated_at: expect.any(String)
    });
  });

  it('source list prints configured sources in sorted order', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);
    await mkdir(join(homeDir, 'source-zeta', 'skills'), { recursive: true });
    await mkdir(join(homeDir, 'source-alpha', 'bundle'), { recursive: true });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'local-zeta',
        '--type',
        'local',
        '--url',
        join(homeDir, 'source-zeta'),
        '--path',
        'skills'
      ],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'local-alpha',
        '--type',
        'local',
        '--url',
        join(homeDir, 'source-alpha'),
        '--path',
        'bundle'
      ],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'zeta',
        '--type',
        'git',
        '--url',
        'https://example.com/zeta.git',
        '--path',
        'skills',
        '--ref',
        'main'
      ],
      { from: 'node' }
    );
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'alpha',
        '--type',
        'http',
        '--url',
        'https://example.com/alpha.zip',
        '--path',
        'bundle'
      ],
      { from: 'node' }
    );

    consoleLog.mockClear();

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'source', 'list'], { from: 'node' });

    expect(consoleLog.mock.calls).toEqual([
      ['alpha\thttp\thttps://example.com/alpha.zip\tbundle'],
      [`local-alpha\tlocal\t${join(homeDir, 'source-alpha')}\tbundle`],
      [`local-zeta\tlocal\t${join(homeDir, 'source-zeta')}\tskills`],
      ['zeta\tgit\thttps://example.com/zeta.git\tskills']
    ]);
  });
});

describe('source add --path option', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('treats --path as shorthand for --url + --path=. for local sources', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-path-'));
    tempDirs.push(homeDir);
    const localSkillDir = join(homeDir, 'my-local-skills');

    // Create a local skill directory with a skill
    await mkdir(join(localSkillDir, 'local-skill'), { recursive: true });
    await writeFile(join(localSkillDir, 'local-skill', 'SKILL.md'), '# Local Skill');

    // Create minimal config
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // Run source add with --path (shorthand for --url <path> --path .)
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'my-local',
        '--type',
        'local',
        '--path',
        localSkillDir
      ],
      { from: 'node' }
    );

    // Verify source was added: url = path value, path = '.'
    const config = await loadConfig(homeDir);
    expect(config.sources['my-local']).toBeDefined();
    const source = config.sources['my-local'] as Record<string, unknown>;
    expect(source.type).toBe('local');
    expect(source.url).toBe(localSkillDir);
    expect(source.path).toBe('.');

    // Verify skill was materialized
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'local-skill'))).resolves.toBe(join(localSkillDir, 'local-skill'));
  });

});

describe('skills-registry generation', () => {
  const tempDirs = useTempDirs();

  it('generates skills-registry.json after link --all', async () => {
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
        links: { 'test-skill': ['*'] },
        sources: {},
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Run link --all
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });

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

  it('CLI shows sameRepoMatch message when source already exists', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-msg-'));
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

    // Mock console.log to capture output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      // Try to add source with same repo URL
      await createProgram(homeDir).parseAsync(
        ['node', 'syncskill', 'source', 'add', 'skill2', '--type', 'git', '--url', 'https://github.com/org/repo.git', '--path', 'skills/skill2'],
        { from: 'node' }
      );

      // Verify sameRepoMatch message was shown
      const output = logs.join('\n');
      expect(output).toContain('A source already exists for this repository');
      expect(output).toContain('repo-skill1');
    } finally {
      console.log = originalLog;
    }
  });
});

describe('source add with -y flag', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('should add all skills without prompting when -y is used', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-y-flag-'));
    tempDirs.push(homeDir);

    // Create a local source directory with multiple skills
    const sourceDir = join(homeDir, 'local-source');
    await mkdir(join(sourceDir, 'skill-a'), { recursive: true });
    await mkdir(join(sourceDir, 'skill-b'), { recursive: true });
    await writeFile(join(sourceDir, 'skill-a', 'SKILL.md'), '# Skill A');
    await writeFile(join(sourceDir, 'skill-b', 'SKILL.md'), '# Skill B');

    // Create minimal config
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // Run source add with -y flag and local type
    await createProgram(homeDir).parseAsync(
      [
        'node',
        'syncskill',
        'source',
        'add',
        'test-source',
        '--type',
        'local',
        '--path',
        sourceDir,
        '-y'
      ],
      { from: 'node' }
    );

    // Verify source was added
    const config = await loadConfig(homeDir);
    expect(config.sources['test-source']).toBeDefined();
    const source = config.sources['test-source'] as Record<string, unknown>;
    expect(source.type).toBe('local');
    expect(source.url).toBe(sourceDir);

    // Verify both skills were materialized (symlinked)
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'skill-a'))).resolves.toBe(join(sourceDir, 'skill-a'));
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'skill-b'))).resolves.toBe(join(sourceDir, 'skill-b'));

    // Verify source state contains both skills
    const state = await loadSourceState(homeDir, 'test-source');
    expect(state.materialized_skills).toContain('skill-a');
    expect(state.materialized_skills).toContain('skill-b');
  });
});

describe('source add --path auto-detect local type', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('auto-detects local type when --path is provided without --type', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-path-auto-'));
    tempDirs.push(homeDir);
    const pathDir = join(homeDir, 'local-skills');

    // Create a skill in pathDir
    await mkdir(join(pathDir, 'my-skill'), { recursive: true });
    await writeFile(join(pathDir, 'my-skill', 'SKILL.md'), '# My Skill');

    // Create minimal config
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // Run source add with --path but NO --type
    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'source', 'add', 'local-src', '--path', pathDir],
      { from: 'node' }
    );

    // Verify local type was auto-detected
    const config = await loadConfig(homeDir);
    const source = config.sources['local-src'] as Record<string, unknown>;
    expect(source.type).toBe('local');
    expect(source.url).toBe(pathDir);
    expect(source.path).toBe('.');

    // Verify skill was materialized
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'my-skill'))).resolves.toBe(join(pathDir, 'my-skill'));
  });

  it('--type takes precedence over --path auto-detection', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-path-explicit-'));
    tempDirs.push(homeDir);

    // Create minimal config
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // When --type git is explicit, --path should not force local type
    // Git sources don't materialize immediately, they just save config
    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'source', 'add', 'my-source', '--type', 'git', '--url', 'https://example.com/repo.git', '--path', '/some/path', '--path', 'skills'],
      { from: 'node' }
    );

    // Verify type is git (not local, even though --path was provided)
    const config = await loadConfig(homeDir);
    const source = config.sources['my-source'] as Record<string, unknown>;
    expect(source.type).toBe('git');
    expect(source.url).toBe('https://example.com/repo.git');
  });
});
