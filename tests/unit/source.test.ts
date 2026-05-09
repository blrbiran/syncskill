import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import YAML, { stringify } from 'yaml';

import { createDefaultConfig, getSyncPaths, loadConfig, saveConfig } from '../../src/config.js';
import type { SyncSkillConfig } from '../../src/config.js';
import { addSourceFromUrl, buildSkillsIndex, classifySameRepoScenario, detectArchiveFormat, detectGitDefaultBranch, detectSourceType, discoverAllSkills, discoverSourceSkills, findExistingSourceByUrl, findOrphanSkills, handleSameRepoMerge, listSources, loadSourceState, loadSkillsIndex, materializeSource, normalizeSkillsIndex, resolveSkillPath, SameRepoScenario, saveSkillsIndex, scanSkillsInDirectory, updateSource } from '../../src/source.js';
import type { SkillsIndex } from '../../src/source.js';
import { addIgnoredSkill, isSkillIgnored, loadSkillsIgnore, saveSkillsIgnore } from '../../src/skills-ignore.js';

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

  return startHttpServer((request, response) => {
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
  return startHttpServer((request, response) => {
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
  handler: Parameters<typeof createServer>[0]
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
  const tempDirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    delete process.env.SYNCSKILL_TEST_FAIL_RENAME_TO;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
          zeta: { type: 'git', url: '/tmp/zeta.git', store: 'skills', ref: 'main' },
          alpha: { type: 'local', url: '/tmp/local-skills', store: '.' },
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
        store: '.'
      },
      {
        name: 'zeta',
        type: 'git',
        url: '/tmp/zeta.git',
        store: 'skills',
        ref: 'main'
      }
    ]);
  });

  it('materializeSource symlinks local-source skills into the sync store and records state', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha', 'beta']);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sourceRoot, 'alpha'));
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['alpha', 'beta'],
      updated_at: '2026-05-01T00:00:00.000Z'
    });
  });

  it('materializeSource removes stale local-source skills from a previous state file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    await mkdir(join(sourceRoot, 'beta'), { recursive: true });
    await writeFile(join(sourceRoot, 'beta', 'SKILL.md'), '# beta\n', 'utf8');

    await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'beta'), { recursive: true, force: true });
    await mkdir(join(sourceRoot, 'gamma'), { recursive: true });
    await writeFile(join(sourceRoot, 'gamma', 'SKILL.md'), '# gamma\n', 'utf8');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T01:00:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['gamma']);
    await expect(loadSourceState(homeDir, 'shared')).resolves.toEqual({
      materialized_skills: ['gamma'],
      updated_at: '2026-05-01T01:00:00.000Z'
    });
    await expect(access(join(homeDir, '.syncskill', 'skills', 'beta'))).rejects.toThrow();
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'gamma'))).resolves.toBe(join(sourceRoot, 'gamma'));
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
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await rm(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true, force: true });
    await symlink(foreignRoot, join(homeDir, '.syncskill', 'skills', 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
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
      { type: 'local', url: sourceRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    await rm(join(sourceRoot, 'alpha'), { recursive: true, force: true });
    await rm(join(skillsDir, 'alpha'), { recursive: true, force: true });
    await symlink('../../foreign', join(skillsDir, 'alpha'), 'dir');

    const result = await materializeSource(
      homeDir,
      'shared',
      { type: 'local', url: sourceRoot, store: '.' },
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
      materializeSource(homeDir, 'shared', { type: 'local', url: sourceRoot, store: '../outside' }, '2026-05-01T00:00:00.000Z')
    ).rejects.toThrow('Local source store must stay within the source root');
  });

  it('materializeSource clones a git source and copies skill files into the sync store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    const result = await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
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

  it('materializeSource downloads an http source archive, extracts checkout, and copies skills into the sync store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const fixtureDir = join(homeDir, 'http-fixture');
    const archiveFile = join(homeDir, 'http-source.tar.gz');
    await mkdir(join(fixtureDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(fixtureDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha http\n', 'utf8');
    await createTarGzArchive(fixtureDir, archiveFile);

    const server = await startArchiveServer(archiveFile);
    cleanups.push(server.close);

    const result = await materializeSource(
      homeDir,
      'http-source',
      { type: 'http', url: server.url, store: 'source.store' },
      '2026-05-01T02:30:00.000Z'
    );

    expect(result.materialized_skills).toEqual(['alpha']);
    await expect(readFile(join(homeDir, '.syncskill', '.sources', 'http-source', 'checkout', 'source.store', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe(
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
    await mkdir(join(fixtureDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(fixtureDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha http\n', 'utf8');
    await createTarGzArchive(fixtureDir, archiveFile);

    const goodServer = await startArchiveServer(archiveFile);
    cleanups.push(goodServer.close);

    await materializeSource(
      homeDir,
      'http-source',
      { type: 'http', url: goodServer.url, store: 'source.store' },
      '2026-05-01T02:30:00.000Z'
    );

    const failingServer = await startFailingArchiveServer();
    cleanups.push(failingServer.close);

    await expect(
      materializeSource(
        homeDir,
        'http-source',
        { type: 'http', url: failingServer.url, store: 'source.store' },
        '2026-05-01T02:31:00.000Z'
      )
    ).rejects.toThrow('Failed to download HTTP source archive: 500 Internal Server Error');

    await expect(readFile(join(homeDir, '.syncskill', '.sources', 'http-source', 'checkout', 'source.store', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# alpha http\n'
    );
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toBe('# alpha http\n');
    await expect(loadSourceState(homeDir, 'http-source')).resolves.toEqual({
      materialized_skills: ['alpha'],
      updated_at: '2026-05-01T02:30:00.000Z'
    });
  });

  it('updateSource refreshes an existing git-owned skill directory when the skill name stays the same', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
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
          'git-source': { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', '2026-05-01T03:00:00.000Z');

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
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
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
          'git-source': { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v2\n', 'utf8');
    await commitAll(workRepoDir, 'refresh alpha');
    await git(['push', 'origin', 'main'], workRepoDir);

    process.env.SYNCSKILL_TEST_FAIL_RENAME_TO = 'alpha';

    await expect(updateSource(homeDir, 'git-source', '2026-05-01T03:00:00.000Z')).rejects.toThrow('simulated rename failure');

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
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
    await commitAll(workRepoDir, 'initial source');
    await git(['push', '-u', 'origin', 'main'], workRepoDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'alpha', 'SKILL.md'), '# occupied\n', 'utf8');

    await expect(
      materializeSource(
        homeDir,
        'git-source',
        { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
        '2026-05-01T02:00:00.000Z'
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');
  });

  it('updateSource refreshes a git source checkout, removes stale skills, and keeps new ones', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-'));
    tempDirs.push(homeDir);

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# alpha v1\n', 'utf8');
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
          'git-source': { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' }
        }
      },
      homeDir
    );

    await materializeSource(
      homeDir,
      'git-source',
      { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
      '2026-05-01T02:00:00.000Z'
    );

    await rm(join(workRepoDir, 'source.store', 'alpha'), { recursive: true, force: true });
    await mkdir(join(workRepoDir, 'source.store', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'beta', 'SKILL.md'), '# beta v2\n', 'utf8');
    await commitAll(workRepoDir, 'update source');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', '2026-05-01T03:00:00.000Z');

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
      { type: 'local', url: sharedRoot, store: '.' },
      '2026-05-01T00:00:00.000Z'
    );

    const { bareRepoDir, workRepoDir } = await createGitSourceFixture(homeDir);
    await mkdir(join(workRepoDir, 'source.store', 'alpha'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'alpha', 'SKILL.md'), '# git alpha\n', 'utf8');
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
          'git-source': { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' }
        }
      },
      homeDir
    );

    await expect(
      materializeSource(
        homeDir,
        'git-source',
        { type: 'git', url: bareRepoDir, store: 'source.store', ref: 'main' },
        '2026-05-01T02:00:00.000Z'
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');

    await rm(join(workRepoDir, 'source.store', 'alpha'), { recursive: true, force: true });
    await mkdir(join(workRepoDir, 'source.store', 'beta'), { recursive: true });
    await writeFile(join(workRepoDir, 'source.store', 'beta', 'SKILL.md'), '# git beta\n', 'utf8');
    await commitAll(workRepoDir, 'replace alpha with beta');
    await git(['push', 'origin', 'main'], workRepoDir);

    const result = await updateSource(homeDir, 'git-source', '2026-05-01T03:00:00.000Z');

    expect(result.materialized_skills).toEqual(['beta']);
    await expect(readlink(join(homeDir, '.syncskill', 'skills', 'alpha'))).resolves.toBe(join(sharedRoot, 'alpha'));
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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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
          store: '.'
        }
      }
    }, homeDir);

    const config = await loadConfig(homeDir);
    const skills = await discoverAllSkills(homeDir, config);

    expect(skills.sort()).toEqual(['local-skill', 'source-skill']);
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
          store: '.'
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
          store: '.'
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
        'source-one': { type: 'git', url: 'https://example.com/repo.git', store: '.' },
        'source-two': { type: 'git', url: 'https://example.com/other.git', store: '.' },
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
        'source-one': { type: 'git', url: 'https://example.com/repo.git', store: '.' },
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
        'source-one': { type: 'git', url: 'https://example.com/repo.git', store: '.' },
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

describe('skills-index', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('saves skills index with manual and source skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-index-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const index: SkillsIndex = {
      version: 1,
      skills: {
        'manual-skill': {
          path: join(syncDir, 'skills', 'manual-skill'),
          origin: 'manual',
          type: 'manual',
        },
        'source-skill': {
          path: join(syncDir, 'sources', 'my-repo', '.claude', 'source-skill'),
          origin: 'my-repo',
          type: 'git',
        },
      },
    };

    await saveSkillsIndex(homeDir, index);

    const saved = JSON.parse(await readFile(join(syncDir, 'skills-index.json'), 'utf-8'));
    expect(saved).toEqual(index);
  });

  it('loads existing skills index', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-index-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const index: SkillsIndex = {
      version: 1,
      skills: {
        'test-skill': {
          path: '/some/path',
          origin: 'manual',
          type: 'manual',
        },
      },
    };
    await writeFile(join(syncDir, 'skills-index.json'), JSON.stringify(index));

    const loaded = await loadSkillsIndex(homeDir);
    expect(loaded).toEqual(index);
  });

  it('returns empty index when file does not exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-index-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });

    const loaded = await loadSkillsIndex(homeDir);
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
    await writeFile(
      join(syncDir, 'config.yaml'),
      YAML.stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'manual-skill': ['*'], 'source-skill': ['*'] },
        sources: { 'my-source': { type: 'git', url: 'https://example.com/repo.git', store: 'materialized' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    const index = await buildSkillsIndex(homeDir);

    expect(index.version).toBe(1);
    expect(index.skills['manual-skill']).toEqual({
      path: join(skillsDir, 'manual-skill'),
      origin: 'manual',
      type: 'manual',
    });
    expect(index.skills['source-skill']).toEqual({
      path: expect.stringContaining('source-skill'),
      origin: 'my-source',
      type: 'git',
    });
  });
});

describe('findExistingSourceByUrl', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns matching source when URL matches', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: {},
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'sources/repo',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    const result = await findExistingSourceByUrl(homeDir, 'https://github.com/org/repo.git');

    expect(result).not.toBeNull();
    expect(result?.name).toBe('existing-source');
    expect(result?.source.url).toBe('https://github.com/org/repo.git');
  });

  it('returns null when no matching URL', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-same-repo-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: {},
        sources: {
          'other-source': {
            type: 'git',
            url: 'https://github.com/org/other.git',
            store: 'sources/other',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('scenario 1: removes skill from ignore when re-adding within multi-skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'existing-source');

    // Create source with ignore list
    await mkdir(join(sourcesDir, 'checkout', 'skills', 'skill1'), { recursive: true });
    await writeFile(join(sourcesDir, 'checkout', 'skills', 'skill1', 'SKILL.md'), '# Skill 1');
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: {},
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/',
            ignore: ['skill1'],
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/skill1',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/skill1',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/skill1',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/skill1',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    expect(source.store).toBe('skills/');
  });

  it('scenario 4: increments suffix when .2 already exists', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-merge-suffix-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { skill1: ['*'], skill2: ['*'] },
        sources: {
          'existing-source': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/skill1',
          },
          'existing-source.2': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'examples/skill2',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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

describe('normalizeSkillsIndex edge cases', () => {
  it('returns empty index for null', () => {
    expect(normalizeSkillsIndex(null)).toEqual({ version: 1, skills: {} });
  });

  it('returns empty index for wrong version', () => {
    expect(normalizeSkillsIndex({ version: 2, skills: {} })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty index for missing skills field', () => {
    expect(normalizeSkillsIndex({ version: 1 })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty index for non-object skills', () => {
    expect(normalizeSkillsIndex({ version: 1, skills: 'invalid' })).toEqual({ version: 1, skills: {} });
  });

  it('returns empty index for array input', () => {
    expect(normalizeSkillsIndex([])).toEqual({ version: 1, skills: {} });
  });

  it('returns empty index for primitive input', () => {
    expect(normalizeSkillsIndex('string')).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsIndex(123)).toEqual({ version: 1, skills: {} });
    expect(normalizeSkillsIndex(undefined)).toEqual({ version: 1, skills: {} });
  });
});

describe('buildSkillsIndex manual skill priority', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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
    await writeFile(
      join(syncDir, 'config.yaml'),
      YAML.stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'shared-skill': ['*'] },
        sources: { 'my-source': { type: 'git', url: 'https://example.com/repo.git', store: 'materialized' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    expect(result?.ref).toBe('main');
  });

  it('parses /tree/<branch> format without path', () => {
    const result = detectSourceType('https://github.com/org/repo/tree/develop');
    expect(result?.type).toBe('git');
    expect(result?.url).toBe('https://github.com/org/repo.git');
    expect(result?.ref).toBe('develop');
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
    expect(result?.ref).toBe('main');
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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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

describe('addSourceFromUrl with skills-ignore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('restores skill from ignore list when same-repo detected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ignore-restore-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Setup: Create config with existing source
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { 'skill-a': ['*'] },
        sources: {
          'org-repo': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Add skill-b to ignore list
    let ignore = await loadSkillsIgnore(homeDir);
    ignore = addIgnoredSkill(ignore, 'skill-b', {
      path: 'skills/skill-b',
      source: 'org-repo',
      reason: 'user-choice'
    });
    await saveSkillsIgnore(homeDir, ignore);

    // Verify skill-b is in ignore list
    const beforeIgnore = await loadSkillsIgnore(homeDir);
    expect(isSkillIgnored(beforeIgnore, 'skill-b')).toBe(true);

    // Try to add same repo with ignored skill path
    const result = await addSourceFromUrl(homeDir,
      'https://github.com/org/repo/tree/main/skills/skill-b');

    expect(result.restoredFromIgnore).toBe(true);
    expect(result.restoredSkill).toBe('skill-b');
    expect(result.sameRepoMatch).toBeDefined();
    expect(result.sameRepoMatch?.name).toBe('org-repo');

    // Verify skill is no longer in ignore
    const updatedIgnore = await loadSkillsIgnore(homeDir);
    expect(isSkillIgnored(updatedIgnore, 'skill-b')).toBe(false);

    // Verify skill is in links
    const config = await loadConfig(homeDir);
    expect('skill-b' in config.links).toBe(true);
    expect(config.links['skill-b']).toEqual(['*']);
  });

  it('does not restore when skill is not in ignore list', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ignore-no-restore-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');

    // Setup: Create config with existing source
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: { 'skill-a': ['*'] },
        sources: {
          'org-repo': {
            type: 'git',
            url: 'https://github.com/org/repo.git',
            store: 'skills/',
          },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

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
    await mkdir(syncDir, { recursive: true });
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: {},
        links: {},
        sources: {},
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    // Add a new source (no existing source with this URL)
    const result = await addSourceFromUrl(homeDir,
      'https://github.com/neworg/newrepo/tree/main/skills/new-skill');

    // Should add new source, not return sameRepoMatch
    expect(result.sameRepoMatch).toBeUndefined();
    expect(result.restoredFromIgnore).toBeUndefined();
    expect(result.name).toBe('new-skill');

    // Verify source was added
    const config = await loadConfig(homeDir);
    expect('new-skill' in config.sources).toBe(true);
  });
});
