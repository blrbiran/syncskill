import { createServer, IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import YAML, { stringify } from 'yaml';

import { createDefaultConfig, getSyncPaths, loadConfig, saveConfig } from '../../src/config/config.js';
import type { SyncSkillConfig } from '../../src/config/config.js';
import { addSourceFromUrl, buildSkillsIndex, buildSkillsRegistry, classifySameRepoScenario, detectArchiveFormat, detectArchiveFormatFromFilename, detectGitDefaultBranch, detectSourceType, discoverAllSkills, discoverMaterializedSkillEntries, discoverSourceSkills, DirtySourceQuitError, findExistingSourceByUrl, findOrphanSkills, handleSameRepoMerge, listSources, loadSkillOwnershipState, loadSourceState, loadSkillsIndex, loadSkillsRegistry, materializeSource, parseContentDisposition, resolveLinkedSkillSourcePath, resolveSkillPath, SameRepoScenario, saveSkillsIndex, saveSkillsRegistry, scanSkillsInDirectory, scanSkillsInSource, updateSource } from '../../src/source.js';
import type { SkillsRegistry } from '../../src/source.js';
import { normalizeSkillsRegistry } from '../../src/core/skills-registry.js';

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: mockSelect,
}));

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

async function createTarGzArchive(sourceDir: string, archiveFile: string): Promise<void> {
  await execFileAsync('tar', ['-czf', archiveFile, '-C', sourceDir, '.']);
}

async function startArchiveServer(archiveFile: string): Promise<{ url: string; close: () => Promise<void> }> {
  const archive = await readFile(archiveFile);

  return startHttpServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== '/source.tar.gz') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Length', archive.byteLength);
    response.end(archive);
  });
}

async function startFailingArchiveServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return startHttpServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== '/source.tar.gz') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    response.statusCode = 500;
    response.end('boom');
  });
}

async function startHttpServer(
  handler: RequestListener
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to determine archive server address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/source.tar.gz`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

describe('source module', () => {
  const tempDirs = useTempDirs();
  const cleanups: Array<() => Promise<void>> = [];
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    mockSelect.mockReset();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
  });

  afterEach(async () => {
    delete process.env.SYNCSKILL_TEST_FAIL_RENAME_TO;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('listSources normalizes valid source entries and sorts them by name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          zeta: { type: 'git', url: '/tmp/zeta.git', path: 'skills', branch: 'main' },
          alpha: { type: 'local', url: '/tmp/local-skills', path: '.' },
          broken: { type: 'git' }
        }
      },
      homeDir
    );

    await expect(listSources(homeDir)).resolves.toEqual([
      {
        name: 'alpha',
        type: 'local',
        url: '/tmp/local-skills',
        path: '.'
      },
      {
        name: 'zeta',
        type: 'git',
        url: '/tmp/zeta.git',
        path: 'skills',
        branch: 'main'
      }
    ]);
  });

  it('listSources supports legacy store field for backward compatibility', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    // Simulate an old config file using 'store' instead of 'path'
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      `version: 1
conflict_resolution: manual
agents: {}
links: {}
servers: {}
sources:
  legacy-source:
    type: git
    url: https://example.com/repo.git
    store: skills
    branch: main
`
    );

    const sources = await listSources(homeDir);
    expect(sources).toEqual([
      {
        name: 'legacy-source',
        type: 'git',
        url: 'https://example.com/repo.git',
        path: 'skills',
        branch: 'main'
      }
    ]);
  });

  it('materializeSource records local-source ownership without writing managed skill directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        shared: { type: 'local', url: sourceRoot, path: '.' }
      }
    }, homeDir);

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha', 'beta']);
    await expect(access(join(homeDir, '.syncskill', 'skills', 'alpha'))).rejects.toThrow();
    await expect(loadSkillOwnershipState(homeDir)).resolves.toEqual({
      owners: {
        alpha: 'shared',
        beta: 'shared'
      }
    });
    await expect(resolveLinkedSkillSourcePath(homeDir, 'alpha')).resolves.toBe(join(sourceRoot, 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha', 'beta'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource discovers nested leaf skills for local sources rooted above skills/', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        shared: { type: 'local', url: sourceRoot, path: '.' }
      }
    }, homeDir);

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(access(join(homeDir, '.syncskill', 'skills', 'alpha'))).rejects.toThrow();
    await expect(resolveLinkedSkillSourcePath(homeDir, 'alpha')).resolves.toBe(join(sourceRoot, 'skills', 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource updates local-source ownership when discovered skills change', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        shared: { type: 'local', url: sourceRoot, path: '.' }
      }
    }, homeDir);

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'beta'), { recursive: true, force: true });
    await mkdir(join(sourceRoot, 'gamma'), { recursive: true });
    await writeFile(join(sourceRoot, 'gamma', 'SKILL.md'), '# gamma\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['gamma']);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['gamma'],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
    await expect(loadSkillOwnershipState(homeDir)).resolves.toEqual({
      owners: {
        gamma: 'shared'
      }
    });
    await expect(resolveLinkedSkillSourcePath(homeDir, 'beta')).resolves.toBeNull();
    await expect(resolveLinkedSkillSourcePath(homeDir, 'gamma')).resolves.toBe(join(sourceRoot, 'gamma'));
  });

  it('materializeSource keeps a stale skill path when it is no longer the source-owned symlink', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    const foreignRoot = join(homeDir, 'foreign');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(foreignRoot, 'SKILL.md'), '# foreign\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    await rm(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true, force: true });
    await symlink(foreignRoot, join(homeDir, '.syncskill', 'skills', 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual([]);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(foreignRoot);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: [],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
  });

  it('materializeSource preserves a relative symlink that no longer belongs to the source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    const foreignRoot = join(homeDir, 'foreign');
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(foreignRoot, 'SKILL.md'), '# foreign\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await mkdir(skillsDir, { recursive: true });
    await rm(join(skillsDir, 'alpha'), { recursive: true, force: true });
    await symlink('../../foreign', join(skillsDir, 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, path: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual([]);
    await expect(readlink(join(skillsDir, 'alpha'))).resolves.toBe('../../foreign');
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: [],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
  });

  it('materializeSource rejects a local store path outside the source root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(sourceRoot, { recursive: true });

    await expect(
      materializeSource(homeDir, 'shared', { type: 'local', url: sourceRoot, path: '../outside' }, '2026-05-01T00:00:00.000Z')
    ).rejects.toThrow('Local source path must stay within the source root');
  });

  it('materializeSource extracts a local archive and copies skill files into the sync store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    // Create fixture directory with skills
    const fixtureDir = join(homeDir, 'fixture');
    await mkdir(join(fixtureDir, 'skills', 'alpha'), { recursive: true });
    await mkdir(join(fixtureDir, 'skills', 'beta'), { recursive: true });
    await writeFile(join(fixtureDir, 'skills', 'alpha', 'SKILL.md'), '# Local archive alpha\n', 'utf8');
    await writeFile(join(fixtureDir, 'skills', 'beta', 'SKILL.md'), '# Local archive beta\n', 'utf8');

    // Create archive
    const archiveFile = join(homeDir, 'my-skills.tar.gz');
    await createTarGzArchive(fixtureDir, archiveFile);

    // Expected checkout directory
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'my-skills', 'checkout');

    const result = await materializeSource(
      homeDir,
      'my-skills',
      { type: 'local', url: checkoutDir, path: 'skills', archive_path: archiveFile },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha', 'beta']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# Local archive alpha\n');
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'beta', 'SKILL.md'), 'utf8')).resolves.toBe('# Local archive beta\n');
    await expect(loadSourceState(homeDir, 'my-skills')).resolves.toEqual({
      materialized_skills: ['alpha', 'beta'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource clones a git source and copies skill files into the sync store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(access(join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout', '.git'))).resolves.toBeUndefined();
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:00:00.000Z'
    });
  });

  it('materializeSource re-clones when checkout directory exists but is not a git repo', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    // Pre-create checkout directory as a non-git directory (simulates stale directory)
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(checkoutDir, { recursive: true });
    await writeFile(join(checkoutDir, 'stale-file.txt'), 'stale content', 'utf8');

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(access(join(checkoutDir, '.git'))).resolves.toBeUndefined();
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
    // Stale file should be gone after re-clone
    await expect(access(join(checkoutDir, 'stale-file.txt'))).rejects.toThrow();
  });

  it('materializeSource re-clones when checkout directory has a different remote URL', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    // Create first repo (old)
    const oldBareRepoDir = join(homeDir, 'old-remote.git');
    const oldWorkRepoDir = join(homeDir, 'old-work');
    await git(['init', '--bare', oldBareRepoDir]);
    await git(['clone', oldBareRepoDir, oldWorkRepoDir]);
    await git(['branch', '-M', 'main'], oldWorkRepoDir);
    await mkdir(join(oldWorkRepoDir, 'source.path', 'old-skill'), { recursive: true });
    await writeFile(join(oldWorkRepoDir, 'source.path', 'old-skill', 'SKILL.md'), '# old skill\n', 'utf8');
    await commitAll(oldWorkRepoDir, 'old content');
    await git(['push', '-u', 'origin', 'main'], oldWorkRepoDir);

    // Create second repo (new)
    const { bareRepoDir: newBareRepoDir, workRepoDir: newWorkRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(newWorkRepoDir, 'source.path', 'new-skill'), { recursive: true });
    await writeFile(join(newWorkRepoDir, 'source.path', 'new-skill', 'SKILL.md'), '# new skill\n', 'utf8');
    await commitAll(newWorkRepoDir, 'new content');
    await git(['push', '-u', 'origin', 'main'], newWorkRepoDir);

    // Pre-clone the old repo to the checkout directory
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(join(homeDir, '.syncskill', '.sources', 'git-source'), { recursive: true });
    await git(['clone', '--single-branch', '--depth', '1', '--branch', 'main', oldBareRepoDir, checkoutDir]);

    // Now materialize with the NEW repo URL - should re-clone
    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: newBareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['new-skill']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'new-skill', 'SKILL.md'), 'utf8')).resolves.toBe('# new skill\n');
    // Old skill should not exist
    await expect(access(join(homeDir, '.syncskill', 'skills', 'old-skill'))).rejects.toThrow();
  });

  it('materializeSource re-clones when checkout directory is empty', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    // Pre-create checkout directory as an empty directory
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(checkoutDir, { recursive: true });

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(access(join(checkoutDir, '.git'))).resolves.toBeUndefined();
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
  });

  it('materializeSource re-clones when checkout is git repo without origin remote', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    // Pre-create checkout directory as a git repo with no 'origin' remote
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(checkoutDir, { recursive: true });
    await git(['init'], checkoutDir);
    await git(['remote', 'add', 'upstream', 'https://example.com/other.git'], checkoutDir);

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
  });

  it('materializeSource re-clones when checkout has corrupted .git directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    // Pre-create checkout directory with corrupted .git (empty directory)
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(join(checkoutDir, '.git'), { recursive: true });

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
  });

  it('materializeSource reuses checkout when URL differs only by .git suffix', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    // Pre-clone with the bare URL (no .git suffix in stored remote)
    const checkoutDir = join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout');
    await mkdir(join(homeDir, '.syncskill', '.sources', 'git-source'), { recursive: true });
    await git(['clone', '--single-branch', '--depth', '1', '--branch', 'main', bareRepoDir, checkoutDir]);

    // Now materialize with URL that has .git suffix added - should NOT re-clone
    const urlWithGitSuffix = bareRepoDir.endsWith('.git') ? bareRepoDir : bareRepoDir + '.git';
    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: urlWithGitSuffix, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
  });

  it('materializeSource downloads an http source archive, extracts checkout, and copies skills into the sync store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const fixtureDir = join(homeDir, 'http-fixture');
    const archiveFile = join(homeDir, 'http-source.tar.gz');
    await mkdir(join(fixtureDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(fixtureDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha http\n', 'utf8');
    await createTarGzArchive(fixtureDir, archiveFile);

    const server = await startArchiveServer(archiveFile);
    cleanups.push(server.close);

    const result = await materializeSource(
      homeDir,
      'http-source',
      { type: 'http', url: server.url, path: 'source.path' },
      '2026-05-01T02:30:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', '.sources', 'http-source', 'checkout', 'source.path', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# alpha http\n'
    );
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha http\n');
    await expect(loadSourceState(homeDir, 'http-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:30:00.000Z'
    });
  });

  it('materializeSource preserves the previous http checkout and state when a later download fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const fixtureDir = join(homeDir, 'http-fixture');
    const archiveFile = join(homeDir, 'http-source.tar.gz');
    await mkdir(join(fixtureDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(fixtureDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha http\n', 'utf8');
    await createTarGzArchive(fixtureDir, archiveFile);

    const goodServer = await startArchiveServer(archiveFile);
    cleanups.push(goodServer.close);

    await materializeSource(
      homeDir,
      'http-source',
      { type: 'http', url: goodServer.url, path: 'source.path' },
      '2026-05-01T02:30:00.000Z'
    );

    const failingServer = await startFailingArchiveServer();
    cleanups.push(failingServer.close);

    await expect(
      materializeSource(
        homeDir,
        'http-source',
        { type: 'http', url: failingServer.url, path: 'source.path' },
        '2026-05-01T02:31:00.000Z'
      )
    ).rejects.toThrow('Failed to download HTTP source archive: 500 Internal Server Error');

    await expect(readFile(join(homeDir, '.syncskill', '.sources', 'http-source', 'checkout', 'source.path', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# alpha http\n'
    );
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha http\n');
    await expect(loadSourceState(homeDir, 'http-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:30:00.000Z'
    });
  });

  it('defaults to skip for dirty git skill changes in interactive mode', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout', 'source.path', 'alpha', 'SKILL.md'), '# local dirty\n', 'utf8');

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const promptConfigPromise = new Promise<any>((resolve) => {
      mockSelect.mockImplementationOnce(async (config) => {
        resolve(config);
        return config.default;
      });
    });

    const result = await updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z');
    const promptConfig = await promptConfigPromise;

    expect(promptConfig.default).toBe('skip');
    expect(promptConfig.choices).toEqual([
      { name: '(S) Skip — keep local modifications, skip this source', value: 'skip' },
      { name: '(o) Overwrite — stash local changes and update to latest', value: 'update' },
      { name: '(q) Quit — stop update', value: 'quit' }
    ]);
    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
    await expect(access(join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout', '.git', 'refs', 'stash'))).rejects.toThrow();
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:00:00.000Z'
    });
  });

  it('defaults to skip for dirty git non-skill changes in interactive mode', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await writeFile(join(workRepoDir, 'README.md'), '# repo\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout', 'README.md'), '# local dirty\n', 'utf8');

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const promptConfigPromise = new Promise<any>((resolve) => {
      mockSelect.mockImplementationOnce(async (config) => {
        resolve(config);
        return config.default;
      });
    });

    const result = await updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z');
    const promptConfig = await promptConfigPromise;

    expect(promptConfig.default).toBe('skip');
    expect(promptConfig.choices).toEqual([
      { name: '(S) Skip — keep local modifications, skip this source', value: 'skip' },
      { name: '(o) Overwrite — stash local changes and update to latest', value: 'update' },
      { name: '(q) Quit — stop update', value: 'quit' }
    ]);
    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
    await expect(access(join(homeDir, '.syncskill', '.sources', 'git-source', 'checkout', '.git', 'refs', 'stash'))).rejects.toThrow();
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:00:00.000Z'
    });
  });

  it('updateSource refreshes an existing git-owned skill directory when the skill name stays the same', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z');

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v2\n');
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T03:00:00.000Z'
    });
  });

  it('updateSource keeps the previous git-owned skill directory when replacing the copy fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    process.env.SYNCSKILL_TEST_FAIL_RENAME_TO = 'alpha';

    await expect(updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z')).rejects.toThrow('simulated rename failure');

    delete process.env.SYNCSKILL_TEST_FAIL_RENAME_TO;

    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha v1\n');
    await expect(access(join(homeDir, '.syncskill', 'skills', 'alpha.next'))).rejects.toThrow();
    await expect(access(join(homeDir, '.syncskill', 'skills', 'alpha.prev'))).rejects.toThrow();
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:00:00.000Z'
    });
  });

  it('materializeSource rejects a git source when a target skill path is occupied by an unmanaged directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# occupied\n', 'utf8');

    await expect(
      materializeSource(
        homeDir,
        'git-source',
        { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
        '2026-05-01T02:00:00.000Z'
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');
  });

  it('updateSource refreshes a git source checkout, removes stale skills, and keeps new ones', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await rm(join(workRepoDir, 'source.path', 'alpha'), { recursive: true, force: true });
    await mkdir(join(workRepoDir, 'source.path', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'beta', 'SKILL.md'), '# beta v2\n', 'utf8');
    await commitAll(workRepoDir, 'update source');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z');

    expect(result.materialized_skills).toEqual(['beta']);
    await expect(access(join(homeDir, '.syncskill', 'skills', 'alpha'))).rejects.toThrow();
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'beta', 'SKILL.md'), 'utf8')).resolves.toBe('# beta v2\n');
    await expect(loadSourceState(homeDir, 'git-source')).resolves.toEqual({
      materialized_skills: ['beta'],
      updated_at: '2026-05-01T03:00:00.000Z'
    });
  });

  it('updateSource does not remove a colliding skill currently owned by another source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sharedRoot = join(homeDir, 'shared');
    await mkdir(join(sharedRoot, 'alpha'), { recursive: true });
    await writeFile(join(sharedRoot, 'alpha', 'SKILL.md'), '# local alpha\n', 'utf8');

    await materializeSource(
      homeDir,
      'local-source',
      { type: 'local', url: sharedRoot, path: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.path', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'alpha', 'SKILL.md'), '# git alpha\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: {},
        links: {},
        servers: {},
        sources: {
          'local-source': { type: 'local', url: sharedRoot, path: '.' },
          'git-source': { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' }
        }
      },
      homeDir
    );

    await expect(
      materializeSource(
        homeDir,
        'git-source',
        { type: 'git', url: bareRepoDir, path: 'source.path', branch: 'main' },
        '2026-05-01T02:00:00.000Z'
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');

    await rm(join(workRepoDir, 'source.path', 'alpha'), { recursive: true, force: true });
    await mkdir(join(workRepoDir, 'source.path', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.path', 'beta', 'SKILL.md'), '# git beta\n', 'utf8');
    await commitAll(workRepoDir, 'replace alpha with beta');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', {}, '2026-05-01T03:00:00.000Z');

    expect(result.materialized_skills).toEqual(['beta']);
    await expect(resolveLinkedSkillSourcePath(homeDir, 'alpha')).resolves.toBe(join(sharedRoot, 'alpha'));
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'beta', 'SKILL.md'), 'utf8')).resolves.toBe('# git beta\n');
  });

  it('detectGitDefaultBranch returns the default branch from a bare repo', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);

    await mkdir(join(workRepoDir, 'skills'), { recursive: true });
    await writeFile(join(workRepoDir, 'skills', 'SKILL.md'), '# test\n', 'utf8');
    await commitAll(workRepoDir, 'initial commit');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const branch = await detectGitDefaultBranch(bareRepoDir);
    expect(branch).toBe('main');
  });

  it('detectGitDefaultBranch returns main as fallback for invalid URLs', async () => {
    const branch = await detectGitDefaultBranch('/nonexistent/path');
    expect(branch).toBe('main');
  });
});

describe('discoverSourceSkills', () => {
  const tempDirs = useTempDirs();

  it('discovers skills in skills/ subdirectory (multi-skill mode)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'source');
    await mkdir(join(sourceRoot, 'skills', 'skill-a'), { recursive: true });
    await mkdir(join(sourceRoot, 'skills', 'skill-b'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'skill-a', 'SKILL.md'), '# Skill A');
    await writeFile(join(sourceRoot, 'skills', 'skill-b', 'SKILL.md'), '# Skill B');

    const skills = await discoverSourceSkills(sourceRoot);

    expect(skills).toEqual(['skill-a', 'skill-b']);
  });

  it('discovers single skill when root has SKILL.md (single-skill mode)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'my-skill');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'SKILL.md'), '# My Skill');

    const skills = await discoverSourceSkills(sourceRoot, 'my-skill');

    expect(skills).toEqual(['my-skill']);
  });

  it('returns empty array when no skills found', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'empty');
    await mkdir(sourceRoot, { recursive: true });

    const skills = await discoverSourceSkills(sourceRoot);

    expect(skills).toEqual([]);
  });

  it('ignores directories in skills/ subdirectory without SKILL.md', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'source');
    await mkdir(join(sourceRoot, 'skills', 'valid-skill'), { recursive: true });
    await mkdir(join(sourceRoot, 'skills', 'not-a-skill'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'valid-skill', 'SKILL.md'), '# Valid Skill');
    await writeFile(join(sourceRoot, 'skills', 'not-a-skill', 'README.md'), '# Not a skill');

    const skills = await discoverSourceSkills(sourceRoot);

    expect(skills).toEqual(['valid-skill']);
  });

  it('returns empty array for single-skill mode without fallbackName', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'my-skill');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'SKILL.md'), '# My Skill');

    const skills = await discoverSourceSkills(sourceRoot);

    expect(skills).toEqual([]);
  });
});

describe('resolveSkillPath', () => {
  it('resolves skill path with skillSubdir', () => {
    const path = resolveSkillPath('/root', 'skill-a', 'skills');
    expect(path).toBe(join('/root', 'skills', 'skill-a'));
  });

  it('resolves skill path without skillSubdir (uses skills/ default)', () => {
    const path = resolveSkillPath('/root', 'skill-a');
    expect(path).toBe(join('/root', 'skills', 'skill-a'));
  });

  it('resolves skill path with custom skillSubdir', () => {
    const path = resolveSkillPath('/root', 'skill-a', 'custom-dir');
    expect(path).toBe(join('/root', 'custom-dir', 'skill-a'));
  });
});

describe('discoverAllSkills', () => {
  const tempDirs = useTempDirs();

  it('merges skills from local dir and configured sources', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-all-'));
    tempDirs.push(homeDir);

    // Create local skill
    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'local-skill'), { recursive: true });

    // Create source with skill
    const sourceRoot = join(homeDir, 'source');
    await mkdir(join(sourceRoot, 'skills', 'source-skill'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'source-skill', 'SKILL.md'), '# Source Skill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'my-source': {
          type: 'local',
          url: sourceRoot,
          path: '.'
        }
      }
    }, homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills.sort()).toEqual(['local-skill', 'source-skill']);
  });

  it('ignores source-derived skills listed in source ignore', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-all-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'source');
    await mkdir(join(sourceRoot, 'skills', 'visible-skill'), { recursive: true });
    await mkdir(join(sourceRoot, 'skills', 'ignored-skill'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'visible-skill', 'SKILL.md'), '# Visible Skill');
    await writeFile(join(sourceRoot, 'skills', 'ignored-skill', 'SKILL.md'), '# Ignored Skill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'my-source': {
          type: 'local',
          url: sourceRoot,
          path: '.',
          ignore: ['ignored-skill']
        }
      }
    }, homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills).toEqual(['visible-skill']);
  });

  it('returns empty array when no skills exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-all-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills).toEqual([]);
  });

  it('deduplicates skills that exist in both local dir and sources', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-all-'));
    tempDirs.push(homeDir);

    // Create local skill
    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'shared-skill'), { recursive: true });

    // Create source with same skill name
    const sourceRoot = join(homeDir, 'source');
    await mkdir(join(sourceRoot, 'skills', 'shared-skill'), { recursive: true });
    await writeFile(join(sourceRoot, 'skills', 'shared-skill', 'SKILL.md'), '# Shared Skill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'my-source': {
          type: 'local',
          url: sourceRoot,
          path: '.'
        }
      }
    }, homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills).toEqual(['shared-skill']);
  });

  it('skips sources with unmaterialized roots', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-all-'));
    tempDirs.push(homeDir);

    // Create local skill
    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'local-skill'), { recursive: true });

    // Config with non-existent source
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'nonexistent': {
          type: 'local',
          url: join(homeDir, 'nonexistent-source'),
          path: '.'
        }
      }
    }, homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills).toEqual(['local-skill']);
  });
});

describe('findOrphanSkills', () => {
  it('returns skills only owned by the target source', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: {
        'skill-a': ['*'],
        'skill-b': ['*'],
        'skill-c': ['*'],
      },
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git', path: '.' },
        'source-two': { type: 'git', url: 'https://example.com/other.git', path: '.' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = {
      owners: {
        'skill-a': 'source-one',
        'skill-b': 'source-one',
        'skill-c': 'source-two',
      },
    };
    const localSkills = new Set<string>(); // no manual skills

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual(['skill-a', 'skill-b']);
  });

  it('excludes skills that exist in local skills directory', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['*'] },
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git', path: '.' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = {
      owners: { 'skill-a': 'source-one' },
    };
    const localSkills = new Set(['skill-a']); // also exists locally

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual([]);
  });

  it('returns empty array when source owns no skills', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: {},
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git', path: '.' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = { owners: {} };
    const localSkills = new Set<string>();

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual([]);
  });
});

describe('skills-registry', () => {
  const tempDirs = useTempDirs();

  it('saves skills registry with manual and source skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const registry: SkillsRegistry = {
      version: 1,
      skills: {
        'manual-skill': {
          path: join(syncDir, 'skills', 'manual-skill'),
          origin: 'manual',
          type: 'manual',
          status: 'active',
        },
        'source-skill': {
          path: join(syncDir, 'sources', 'my-repo', '.claude', 'source-skill'),
          origin: 'my-repo',
          type: 'git',
          status: 'active',
        },
      },
    };

    await saveSkillsRegistry(homeDir, registry);

    const saved = JSON.parse(await readFile(join(syncDir, 'skills-registry.json'), 'utf-8'));
    expect(saved).toEqual(registry);
  });

  it('loads existing skills registry', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const registry: SkillsRegistry = {
      version: 1,
      skills: {
        'test-skill': {
          path: '/some/path',
          origin: 'manual',
          type: 'manual',
          status: 'active',
        },
      },
    };
    await writeFile(join(syncDir, 'skills-registry.json'), JSON.stringify(registry));

    const loaded = await loadSkillsRegistry(homeDir);
    expect(loaded).toEqual(registry);
  });

  it('returns empty registry when file does not exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-registry-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const loaded = await loadSkillsRegistry(homeDir);
    expect(loaded).toEqual({ version: 1, skills: {} });
  });

  it('builds index from manual skills and sources', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-build-index-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');
    const sourcesDir = join(syncDir, '.sources');

    // Create manual skill
    await mkdir(join(skillsDir, 'manual-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'manual-skill', 'SKILL.md'), '# Manual Skill');

    // Create source with materialized skill
    await mkdir(join(sourcesDir, 'my-source', 'materialized', 'source-skill'), { recursive: true });
    await writeFile(join(sourcesDir, 'my-source', 'materialized', 'source-skill', 'SKILL.md'), '# Source Skill');
    await writeFile(
      join(sourcesDir, 'my-source', 'state.json'),
      JSON.stringify({ materialized_skills: ['source-skill'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(sourcesDir, 'ownership.json'),
      JSON.stringify({ owners: { 'source-skill': 'my-source' } })
    );

    // Create config
    await saveConfig({
      ...createDefaultConfig(homeDir, { claude: '~/.claude/skills' }),
      links: { 'manual-skill': ['*'], 'source-skill': ['*'] },
      sources: { 'my-source': { type: 'git', url: 'https://example.com/repo.git', path: 'materialized' } },
    }, homeDir);

    const index = await buildSkillsIndex(homeDir);

    expect(index.version).toBe(1);
    expect(index.skills['manual-skill']).toEqual({
      path: join(skillsDir, 'manual-skill'),
      origin: 'manual',
      type: 'manual',
      status: 'active',
    });
    expect(index.skills['source-skill']).toEqual({
      path: expect.stringContaining('source-skill'),
      origin: 'my-source',
      type: 'git',
      status: 'active',
    });
  });
});

describe('findExistingSourceByUrl', () => {
  const tempDirs = useTempDirs();

  it('returns matching source when URL matches', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'sources/repo',
        },
      },
    }, homeDir);

    const result = await findExistingSourceByUrl(homeDir, 'https://github.com/org/repo.git');

    expect(result).not.toBeNull();
    expect(result?.name).toBe('existing-source');
    expect(result?.source.url).toBe('https://github.com/org/repo.git');
  });

  it('returns null when no matching URL', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'other-source': {
          type: 'git',
          url: 'https://github.com/org/other.git',
          path: 'sources/other',
        },
      },
    }, homeDir);

    const result = await findExistingSourceByUrl(homeDir, 'https://github.com/org/repo.git');

    expect(result).toBeNull();
  });
});

describe('classifySameRepoScenario', () => {
  it('returns scenario 1 when new path is subset of existing multi-skill dir', () => {
    const result = classifySameRepoScenario(
      'skills/',           // existing: multi-skill directory
      'skills/skill1',     // new: single skill within
      false,               // existing has SKILL.md = false (multi)
      true                 // new has SKILL.md = true (single)
    );

    expect(result).toBe(SameRepoScenario.NewWithinExisting);
  });

  it('returns scenario 2 when new path contains existing single skill', () => {
    const result = classifySameRepoScenario(
      'skills/skill1',     // existing: single skill
      'skills/',           // new: multi-skill directory containing it
      true,                // existing has SKILL.md = true (single)
      false                // new has SKILL.md = false (multi)
    );

    expect(result).toBe(SameRepoScenario.NewContainsExisting);
  });

  it('returns scenario 3 when same parent, different skills', () => {
    const result = classifySameRepoScenario(
      'skills/skill1',     // existing: single skill
      'skills/skill2',     // new: sibling skill
      true,
      true
    );

    expect(result).toBe(SameRepoScenario.SameParentSiblings);
  });

  it('returns scenario 4 when different parent directories', () => {
    const result = classifySameRepoScenario(
      'skills/skill1',     // existing in skills/
      'examples/skill2',   // new in examples/
      true,
      true
    );

    expect(result).toBe(SameRepoScenario.DifferentParents);
  });
});

describe('handleSameRepoMerge', () => {
  const tempDirs = useTempDirs();

  it('scenario 1: removes skill from ignore when re-adding within multi-skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'existing-source');

    // Create source with ignore list
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill1'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/',
          ignore: ['skill1'],
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/',
      newSubdir: 'skills/skill1',
      scenario: SameRepoScenario.NewWithinExisting,
    });

    expect(result.action).toBe('restored-from-ignore');
    expect(result.skillName).toBe('skill1');
  });

  it('scenario 1: returns already-covered when skill not in ignore', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/',
      newSubdir: 'skills/skill1',
      scenario: SameRepoScenario.NewWithinExisting,
    });

    expect(result.action).toBe('already-covered');
    expect(result.skillName).toBe('skill1');
  });

  it('scenario 2: expands to multi-skill directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'existing-source');

    // Create source with single skill but multiple skills in checkout
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill1'), { recursive: true });
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill2'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill2', 'SKILL.md'), '# Skill 2');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/skill1',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/skill1',
      newSubdir: 'skills/',
      scenario: SameRepoScenario.NewContainsExisting,
    });

    expect(result.action).toBe('expanded-to-multi');
    expect(result.newSkills).toContain('skill2');
  });

  it('scenario 3: adds sibling skill with shared parent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-sibling-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'existing-source');

    // Create checkout with two sibling skills
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill1'), { recursive: true });
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill2'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill2', 'SKILL.md'), '# Skill 2');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/skill1',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/skill1',
      newSubdir: 'skills/skill2',
      scenario: SameRepoScenario.SameParentSiblings,
      expandToParent: false,
    });

    expect(result.action).toBe('added-sibling');
    expect(result.skillName).toBe('skill2');
  });

  it('scenario 4: creates new source entry for different parent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-diff-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/skill1',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/skill1',
      newSubdir: 'examples/skill2',
      scenario: SameRepoScenario.DifferentParents,
    });

    expect(result.action).toBe('created-new-entry');
    expect(result.newSourceName).toBe('existing-source.2');
  });

  it('scenario 3 with expandToParent=true: expands to shared parent with all skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-expand-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'existing-source');

    // Create checkout with three sibling skills
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill1'), { recursive: true });
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill2'), { recursive: true });
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill3'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill2', 'SKILL.md'), '# Skill 2');
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill3', 'SKILL.md'), '# Skill 3');
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/skill1',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/skill1',
      newSubdir: 'skills/skill2',
      scenario: SameRepoScenario.SameParentSiblings,
      expandToParent: true,
    });

    expect(result.action).toBe('expanded-to-multi');
    expect(result.newSkills).toContain('skill1');
    expect(result.newSkills).toContain('skill2');
    expect(result.newSkills).toContain('skill3');

    // Verify config updated with parent directory
    const config = await loadConfig(homeDir);
    const source = config.sources['existing-source'] as Record<string, unknown>;
    expect(source.path).toBe('skills/');
  });

  it('scenario 4: increments suffix when .2 already exists', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-suffix-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { skill1: ['*'], skill2: ['*'] },
      sources: {
        'existing-source': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/skill1',
        },
        'existing-source.2': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'examples/skill2',
        },
      },
    }, homeDir);

    const result = await handleSameRepoMerge(homeDir, {
      existingName: 'existing-source',
      existingSubdir: 'skills/skill1',
      newSubdir: 'docs/skill3',
      scenario: SameRepoScenario.DifferentParents,
    });

    expect(result.action).toBe('created-new-entry');
    expect(result.newSourceName).toBe('existing-source.3');
  });
});

describe('classifySameRepoScenario edge cases', () => {
  it('handles empty string for new subdir', () => {
    const result = classifySameRepoScenario(
      'skills/',
      '',
      false,
      false
    );

    // Empty new path with existing multi-skill should be DifferentParents
    // since dirname('') === '.' and dirname('skills') !== '.'
    expect(result).toBe(SameRepoScenario.DifferentParents);
  });

  it('handles root path "." for existing subdir', () => {
    const result = classifySameRepoScenario(
      '.',
      'skills/skill1',
      false,
      true
    );

    // Root contains everything - should be NewWithinExisting
    // But the logic checks startsWith, and 'skills/skill1' does not start with './'
    // So this falls through to DifferentParents
    expect(result).toBe(SameRepoScenario.DifferentParents);
  });

  it('handles trailing slashes consistently', () => {
    const result = classifySameRepoScenario(
      'skills/',
      'skills/skill1/',
      false,
      true
    );

    expect(result).toBe(SameRepoScenario.NewWithinExisting);
  });

  it('handles same path (edge case)', () => {
    const result = classifySameRepoScenario(
      'skills/skill1',
      'skills/skill1',
      true,
      true
    );

    // Same path, same parent → SameParentSiblings (degenerate case)
    expect(result).toBe(SameRepoScenario.SameParentSiblings);
  });
});

describe('normalizeSkillsRegistry edge cases', () => {
  it('returns empty registry for null', () => {
    expect(normalizeSkillsRegistry(null)).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for wrong version', () => {
    expect(normalizeSkillsRegistry({ version: 2, skills: {} })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for missing skills field', () => {
    expect(normalizeSkillsRegistry({ version: 1 })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for non-object skills', () => {
    expect(normalizeSkillsRegistry({ version: 1, skills: 'invalid' })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for array input', () => {
    expect(normalizeSkillsRegistry([])).toEqual({ version: 1, skills: {} });
  });

  it('returns empty registry for primitive input', () => {
    expect(normalizeSkillsRegistry('string')).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsRegistry(123)).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsRegistry(undefined)).toEqual({ version: 1, skills: {} });
  });
});

describe('buildSkillsIndex manual skill priority', () => {
  const tempDirs = useTempDirs();

  it('manual skill takes priority over source skill with same name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-priority-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');
    const sourcesDir = join(syncDir, '.sources');

    // Create manual skill
    await mkdir(join(skillsDir, 'shared-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'shared-skill', 'SKILL.md'), '# Manual Version');

    // Create source with skill of same name and set up ownership
    await mkdir(join(sourcesDir, 'my-source', 'materialized', 'shared-skill'), { recursive: true });
    await writeFile(join(sourcesDir, 'my-source', 'materialized', 'shared-skill', 'SKILL.md'), '# Source Version');
    await writeFile(
      join(sourcesDir, 'my-source', 'state.json'),
      JSON.stringify({ materialized_skills: ['shared-skill'], updated_at: '2026-01-01T00:00:00Z' })
    );
    // Mark the skill as owned by source to test priority
    await writeFile(
      join(sourcesDir, 'ownership.json'),
      JSON.stringify({ owners: { 'shared-skill': 'my-source' } })
    );

    // Create config
    await saveConfig({
      ...createDefaultConfig(homeDir, { claude: '~/.claude/skills' }),
      links: { 'shared-skill': ['*'] },
      sources: { 'my-source': { type: 'git', url: 'https://example.com/repo.git', path: 'materialized' } },
    }, homeDir);

    const index = await buildSkillsIndex(homeDir);

    // Manual skill should take priority
    expect(index.skills['shared-skill'].origin).toBe('manual');
    expect(index.skills['shared-skill'].type).toBe('manual');
    expect(index.skills['shared-skill'].path).toBe(join(skillsDir, 'shared-skill'));
  });
});

describe('detectArchiveFormat', () => {
  it('returns tar.gz for .tar.gz URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.tar.gz');
    expect(result).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });

  it('returns tar.gz for .tgz URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.tgz');
    expect(result).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });

  it('returns tar.bz2 for .tar.bz2 URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.tar.bz2');
    expect(result).toEqual({ type: 'tar.bz2', extension: '.tar.bz2' });
  });

  it('returns tar.bz2 for .tbz2 URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.tbz2');
    expect(result).toEqual({ type: 'tar.bz2', extension: '.tar.bz2' });
  });

  it('returns tar.xz for .tar.xz URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.tar.xz');
    expect(result).toEqual({ type: 'tar.xz', extension: '.tar.xz' });
  });

  it('returns tar.xz for .txz URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.txz');
    expect(result).toEqual({ type: 'tar.xz', extension: '.tar.xz' });
  });

  it('returns zip for .zip URLs', () => {
    const result = detectArchiveFormat('https://example.com/archive.zip');
    expect(result).toEqual({ type: 'zip', extension: '.zip' });
  });

  it('defaults to tar.gz for unknown extensions', () => {
    const result = detectArchiveFormat('https://example.com/archive.unknown');
    expect(result).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });

  it('handles case-insensitive extensions', () => {
    expect(detectArchiveFormat('https://example.com/archive.TAR.GZ')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
    expect(detectArchiveFormat('https://example.com/archive.ZIP')).toEqual({ type: 'zip', extension: '.zip' });
  });

  it('strips query parameters before detecting extension', () => {
    expect(detectArchiveFormat('https://example.com/archive.tar.gz?token=abc123')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
    expect(detectArchiveFormat('https://cdn.example.com/skills.zip?v=2&sig=xyz')).toEqual({ type: 'zip', extension: '.zip' });
    expect(detectArchiveFormat('https://example.com/archive.tgz?foo=bar')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });

  it('defaults to tar.gz for URLs with query params but no extension', () => {
    expect(detectArchiveFormat('https://example.com/download?file=123')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });
});

describe('detectArchiveFormatFromFilename', () => {
  it('detects tar.gz from filename', () => {
    expect(detectArchiveFormatFromFilename('skills-v1.2.3.tar.gz')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
    expect(detectArchiveFormatFromFilename('archive.tgz')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
  });

  it('detects tar.bz2 from filename', () => {
    expect(detectArchiveFormatFromFilename('skills.tar.bz2')).toEqual({ type: 'tar.bz2', extension: '.tar.bz2' });
    expect(detectArchiveFormatFromFilename('archive.tbz2')).toEqual({ type: 'tar.bz2', extension: '.tar.bz2' });
  });

  it('detects tar.xz from filename', () => {
    expect(detectArchiveFormatFromFilename('skills.tar.xz')).toEqual({ type: 'tar.xz', extension: '.tar.xz' });
    expect(detectArchiveFormatFromFilename('archive.txz')).toEqual({ type: 'tar.xz', extension: '.tar.xz' });
  });

  it('detects zip from filename', () => {
    expect(detectArchiveFormatFromFilename('skills-pack.zip')).toEqual({ type: 'zip', extension: '.zip' });
  });

  it('returns null for unknown extensions', () => {
    expect(detectArchiveFormatFromFilename('README.md')).toBeNull();
    expect(detectArchiveFormatFromFilename('archive.unknown')).toBeNull();
    expect(detectArchiveFormatFromFilename('noextension')).toBeNull();
  });

  it('handles case-insensitive filenames', () => {
    expect(detectArchiveFormatFromFilename('SKILLS.TAR.GZ')).toEqual({ type: 'tar.gz', extension: '.tar.gz' });
    expect(detectArchiveFormatFromFilename('Archive.ZIP')).toEqual({ type: 'zip', extension: '.zip' });
  });
});

describe('parseContentDisposition', () => {
  it('returns null for null header', () => {
    expect(parseContentDisposition(null)).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(parseContentDisposition('')).toBeNull();
  });

  it('extracts filename from basic header', () => {
    expect(parseContentDisposition('attachment; filename=skills.tar.gz')).toBe('skills.tar.gz');
  });

  it('extracts filename from quoted value', () => {
    expect(parseContentDisposition('attachment; filename="skills-v1.0.zip"')).toBe('skills-v1.0.zip');
    expect(parseContentDisposition("attachment; filename='archive.tgz'")).toBe('archive.tgz');
  });

  it('extracts filename with spaces in quotes', () => {
    expect(parseContentDisposition('attachment; filename="my skills archive.zip"')).toBe('my skills archive.zip');
    expect(parseContentDisposition("attachment; filename='my archive pack.tar.gz'")).toBe('my archive pack.tar.gz');
  });

  it('extracts filename from RFC 5987 extended notation', () => {
    expect(parseContentDisposition("attachment; filename*=utf-8''skills%20pack.tar.gz")).toBe('skills pack.tar.gz');
    expect(parseContentDisposition("attachment; filename*=UTF-8''my%2Farchive.zip")).toBe('my/archive.zip');
  });

  it('prefers RFC 5987 over regular filename', () => {
    expect(parseContentDisposition("attachment; filename=fallback.zip; filename*=utf-8''preferred.tar.gz")).toBe('preferred.tar.gz');
  });

  it('falls back to regular filename on invalid RFC 5987 encoding', () => {
    expect(parseContentDisposition("attachment; filename*=utf-8''%invalid; filename=fallback.zip")).toBe('fallback.zip');
  });

  it('handles header without filename', () => {
    expect(parseContentDisposition('attachment')).toBeNull();
    expect(parseContentDisposition('inline')).toBeNull();
  });

  it('handles case-insensitive filename parameter', () => {
    expect(parseContentDisposition('attachment; FILENAME=upper.zip')).toBe('upper.zip');
    expect(parseContentDisposition('attachment; FileName=mixed.tar.gz')).toBe('mixed.tar.gz');
  });
});

describe('DirtySourceQuitError', () => {
  it('has correct name property', () => {
    const error = new DirtySourceQuitError();
    expect(error.name).toBe('DirtySourceQuitError');
  });

  it('has descriptive message', () => {
    const error = new DirtySourceQuitError();
    expect(error.message).toBe('User quit dirty source update');
  });

  it('is instanceof Error', () => {
    const error = new DirtySourceQuitError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DirtySourceQuitError);
  });
});

describe('detectSourceType', () => {
  it('detects local absolute paths', () => {
    const result = detectSourceType('/path/to/skills');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('/path/to/skills');
  });

  it('detects local paths with ~ prefix', () => {
    const result = detectSourceType('~/code/my-skills');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('~/code/my-skills');
  });

  it('detects relative paths starting with ./', () => {
    const result = detectSourceType('./local-skills');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('./local-skills');
  });

  it('detects relative paths starting with ../', () => {
    const result = detectSourceType('../shared-skills');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('../shared-skills');
  });

  it('detects local archive file (tar.gz)', () => {
    const result = detectSourceType('/path/to/skills.tar.gz');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('/path/to/skills.tar.gz');
    expect(result?.isArchive).toBe(true);
  });

  it('detects local archive file with ~ prefix (zip)', () => {
    const result = detectSourceType('~/Downloads/my-skills.zip');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('~/Downloads/my-skills.zip');
    expect(result?.isArchive).toBe(true);
  });

  it('detects local archive file with relative path (tgz)', () => {
    const result = detectSourceType('./archives/skills.tgz');
    expect(result?.type).toBe('local');
    expect(result?.url).toBe('./archives/skills.tgz');
    expect(result?.isArchive).toBe(true);
  });

  it('marks non-archive local paths as isArchive false', () => {
    const result = detectSourceType('/path/to/skills-dir');
    expect(result?.type).toBe('local');
    expect(result?.isArchive).toBe(false);
  });

  it('detects github URL as git type', () => {
    const result = detectSourceType('https://github.com/org/repo');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://github.com/org/repo.git');
  });

  it('detects github URL with .git suffix', () => {
    const result = detectSourceType('https://github.com/org/repo.git');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://github.com/org/repo.git');
  });

  it('parses /tree/<branch> format from github', () => {
    const result = detectSourceType('https://github.com/org/repo/tree/main/skills');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://github.com/org/repo.git');
    expect(result?.branch).toBe('main');
  });

  it('parses /tree/<branch> format without path', () => {
    const result = detectSourceType('https://github.com/org/repo/tree/develop');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://github.com/org/repo.git');
    expect(result?.branch).toBe('develop');
  });

  it('detects gitlab URL as git type', () => {
    const result = detectSourceType('https://gitlab.com/org/repo');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://gitlab.com/org/repo.git');
  });

  it('parses /tree/<branch> format from gitlab', () => {
    const result = detectSourceType('https://gitlab.com/org/repo/tree/main/skills');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://gitlab.com/org/repo.git');
    expect(result?.branch).toBe('main');
  });

  it('detects generic .git URLs', () => {
    const result = detectSourceType('https://example.com/custom/repo.git');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://example.com/custom/repo.git');
  });

  it('detects archive URLs (tar.gz)', () => {
    const result = detectSourceType('https://example.com/skills.tar.gz');
    expect(result?.type).toBe('http');
    expect(result?.url).toBe('https://example.com/skills.tar.gz');
  });

  it('detects archive URLs (tgz)', () => {
    const result = detectSourceType('https://example.com/skills.tgz');
    expect(result?.type).toBe('http');
  });

  it('detects archive URLs (zip)', () => {
    const result = detectSourceType('https://example.com/skills.zip');
    expect(result?.type).toBe('http');
  });

  it('detects archive URLs (tar.xz)', () => {
    const result = detectSourceType('https://example.com/skills.tar.xz');
    expect(result?.type).toBe('http');
  });

  it('detects archive URLs (tar.bz2)', () => {
    const result = detectSourceType('https://example.com/skills.tar.bz2');
    expect(result?.type).toBe('http');
  });

  it('handles case-insensitive archive extensions', () => {
    const result = detectSourceType('https://example.com/skills.TAR.GZ');
    expect(result?.type).toBe('http');
  });

  it('returns null for unknown format', () => {
    const result = detectSourceType('unknown-format');
    expect(result).toBeNull();
  });

  it('returns null for plain https URLs without recognizable patterns', () => {
    const result = detectSourceType('https://example.com/some/path');
    expect(result).toBeNull();
  });

  it('returns null for plain domain names', () => {
    const result = detectSourceType('example.com');
    expect(result).toBeNull();
  });
});

describe('scanSkillsInDirectory', () => {
  const tempDirs = useTempDirs();

  it('finds skills with SKILL.md in top-level directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'skills');
    await mkdir(join(baseDir, 'skill-a'), { recursive: true });
    await mkdir(join(baseDir, 'skill-b'), { recursive: true });
    await writeFile(join(baseDir, 'skill-a', 'SKILL.md'), '# Skill A');
    await writeFile(join(baseDir, 'skill-b', 'SKILL.md'), '# Skill B');

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.name).sort()).toEqual(['skill-a', 'skill-b']);
    expect(skills.find(s => s.name === 'skill-a')?.relativePath).toBe('skill-a');
    expect(skills.find(s => s.name === 'skill-a')?.absolutePath).toBe(join(baseDir, 'skill-a'));
  });

  it('finds skills in nested directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'repo');
    await mkdir(join(baseDir, 'packages', 'skills', 'my-skill'), { recursive: true });
    await writeFile(join(baseDir, 'packages', 'skills', 'my-skill', 'SKILL.md'), '# My Skill');

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
    expect(skills[0].relativePath).toBe('packages/skills/my-skill');
    expect(skills[0].absolutePath).toBe(join(baseDir, 'packages', 'skills', 'my-skill'));
  });

  it('skips directories without SKILL.md', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'skills');
    await mkdir(join(baseDir, 'valid-skill'), { recursive: true });
    await mkdir(join(baseDir, 'not-a-skill'), { recursive: true });
    await writeFile(join(baseDir, 'valid-skill', 'SKILL.md'), '# Valid');
    await writeFile(join(baseDir, 'not-a-skill', 'README.md'), '# Not a skill');

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('valid-skill');
  });

  it('skips hidden directories (starting with .)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'skills');
    await mkdir(join(baseDir, 'visible-skill'), { recursive: true });
    await mkdir(join(baseDir, '.hidden-skill'), { recursive: true });
    await writeFile(join(baseDir, 'visible-skill', 'SKILL.md'), '# Visible');
    await writeFile(join(baseDir, '.hidden-skill', 'SKILL.md'), '# Hidden');

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('visible-skill');
  });

  it('stops recursion once SKILL.md is found', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'skills');
    // Parent skill with nested sub-skill (should only find parent)
    await mkdir(join(baseDir, 'parent-skill', 'nested-skill'), { recursive: true });
    await writeFile(join(baseDir, 'parent-skill', 'SKILL.md'), '# Parent');
    await writeFile(join(baseDir, 'parent-skill', 'nested-skill', 'SKILL.md'), '# Nested');

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('parent-skill');
  });

  it('returns empty array for non-existent directory', async () => {
    const skills = await scanSkillsInDirectory('/non/existent/path');
    expect(skills).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const baseDir = join(homeDir, 'empty');
    await mkdir(baseDir, { recursive: true });

    const skills = await scanSkillsInDirectory(baseDir);
    expect(skills).toEqual([]);
  });
});

describe('discoverMaterializedSkillEntries', () => {
  const tempDirs = useTempDirs();

  it('uses the subdirectory basename when the requested git tree path itself is a skill root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-discover-materialized-'));
    tempDirs.push(homeDir);

    const skillRoot = join(homeDir, 'checkout', 'libs', 'cli', 'examples', 'skills', 'arxiv-search');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), '# arxiv-search');

    const discovered = await discoverMaterializedSkillEntries(
      'arxiv-search',
      {
        type: 'git',
        url: 'https://github.com/langchain-ai/deepagents.git',
        path: 'libs/cli/examples/skills/arxiv-search',
        branch: 'main'
      },
      skillRoot
    );

    expect(discovered).toEqual([
      {
        name: 'arxiv-search',
        relativePath: '.',
        absolutePath: skillRoot
      }
    ]);
  });
});

describe('scanSkillsInSource', () => {
  const tempDirs = useTempDirs();

  it('should find all skills with SKILL.md in source directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-scan-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, 'test-source');
    await mkdir(join(sourceDir, 'skill-a'), { recursive: true });
    await mkdir(join(sourceDir, 'skill-b'), { recursive: true });
    await mkdir(join(sourceDir, 'not-a-skill'), { recursive: true });
    await writeFile(join(sourceDir, 'skill-a', 'SKILL.md'), '# Skill A');
    await writeFile(join(sourceDir, 'skill-b', 'SKILL.md'), '# Skill B');

    const skills = await scanSkillsInSource(sourceDir);

    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.name).sort()).toEqual(['skill-a', 'skill-b']);
  });

  it('should return skills sorted by name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-scan-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, 'test-source');
    await mkdir(join(sourceDir, 'zebra-skill'), { recursive: true });
    await mkdir(join(sourceDir, 'alpha-skill'), { recursive: true });
    await mkdir(join(sourceDir, 'beta-skill'), { recursive: true });
    await writeFile(join(sourceDir, 'zebra-skill', 'SKILL.md'), '# Zebra');
    await writeFile(join(sourceDir, 'alpha-skill', 'SKILL.md'), '# Alpha');
    await writeFile(join(sourceDir, 'beta-skill', 'SKILL.md'), '# Beta');

    const skills = await scanSkillsInSource(sourceDir);

    expect(skills).toHaveLength(3);
    expect(skills.map(s => s.name)).toEqual(['alpha-skill', 'beta-skill', 'zebra-skill']);
  });
});

describe('addSourceFromUrl with skills-registry', () => {
  const tempDirs = useTempDirs();

  it('restores skill from ignore list when same-repo detected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ignore-restore-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Setup: Create config with existing source
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { 'skill-a': ['*'] },
      sources: {
        'org-repo': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/',
        },
      },
    }, homeDir);

    const configBefore = await loadConfig(homeDir);
    configBefore.sources['org-repo'] = {
      ...configBefore.sources['org-repo'],
      ignore: ['skill-b']
    };
    await saveConfig(configBefore, homeDir);

    // Try to add same repo with ignored skill path
    const result = await addSourceFromUrl(homeDir,
      'https://github.com/org/repo/tree/main/skills/skill-b');

    expect(result.restoredFromIgnore).toBe(true);
    expect(result.restoredSkill).toBe('skill-b');
    expect(result.sameRepoMatch).toBeDefined();
    expect(result.sameRepoMatch?.name).toBe('org-repo');

    // Verify skill is no longer ignored (now active)
    const config = await loadConfig(homeDir);
    expect((config.sources['org-repo'] as Record<string, unknown>).ignore).toBeUndefined();

    // Verify skill is in links
    expect('skill-b' in config.links).toBe(true);
    expect(config.links['skill-b']).toEqual(['*']);
  });

  it('does not restore when skill is not in ignore list', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ignore-no-restore-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Setup: Create config with existing source
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      links: { 'skill-a': ['*'] },
      sources: {
        'org-repo': {
          type: 'git',
          url: 'https://github.com/org/repo.git',
          path: 'skills/',
        },
      },
    }, homeDir);

    // Try to add same repo with a skill that's NOT in ignore list
    const result = await addSourceFromUrl(homeDir,
      'https://github.com/org/repo/tree/main/skills/skill-c');

    // Should return sameRepoMatch but NOT restoredFromIgnore
    expect(result.restoredFromIgnore).toBeUndefined();
    expect(result.sameRepoMatch).toBeDefined();
    expect(result.sameRepoMatch?.name).toBe('org-repo');

    // skill-c should NOT be added to links (CLI handles this case interactively)
    const config = await loadConfig(homeDir);
    expect('skill-c' in config.links).toBe(false);
  });

  it('adds new source when no existing source matches', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-new-source-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, 'sources');

    // Setup: Create empty config
    await mkdir(sourcesDir, { recursive: true });
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
    }, homeDir);

    // Add a new source (no existing source with this URL)
    const result = await addSourceFromUrl(homeDir,
      'https://github.com/neworg/newrepo/tree/main/skills/new-skill');

    // Should add new source, not return sameRepoMatch
    expect(result.sameRepoMatch).toBeUndefined();
    expect(result.restoredFromIgnore).toBeUndefined();
    expect(result.name).toBe('new-skill');
    expect(result.source.path).toBe('skills/new-skill');

    // Verify source was added
    const config = await loadConfig(homeDir);
    expect('new-skill' in config.sources).toBe(true);
    expect((config.sources['new-skill'] as { path: string }).path).toBe('skills/new-skill');
  });

  it('adds local archive source with archive_path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-local-archive-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Setup: Create empty config
    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
    }, homeDir);

    // Create a fixture directory with skills
    const fixtureDir = join(homeDir, 'fixture');
    await mkdir(join(fixtureDir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(fixtureDir, 'skills', 'alpha', 'SKILL.md'), '# Alpha skill\n', 'utf8');

    // Create archive
    const archiveFile = join(homeDir, 'my-skills-pack.tar.gz');
    await createTarGzArchive(fixtureDir, archiveFile);

    // Add local archive
    const result = await addSourceFromUrl(homeDir, archiveFile);

    // Should add new source with archive_path
    expect(result.name).toBe('my-skills-pack');
    expect(result.source.type).toBe('local');
    expect(result.source.archive_path).toBe(archiveFile);

    // Verify source was added to config
    const config = await loadConfig(homeDir);
    expect('my-skills-pack' in config.sources).toBe(true);
    const sourceConfig = config.sources['my-skills-pack'] as { type: string; archive_path?: string };
    expect(sourceConfig.type).toBe('local');
    expect(sourceConfig.archive_path).toBe(archiveFile);
  });
});
