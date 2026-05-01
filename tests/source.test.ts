import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config.js';
import { listSources, loadSourceState, materializeSource, updateSource } from '../src/source.js';

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
});
