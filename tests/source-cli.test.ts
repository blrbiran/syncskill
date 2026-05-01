import { access, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { createProgram } from '../src/index.js';
import { loadSourceState } from '../src/source.js';

describe('source CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
        '--store',
        '.'
      ],
      { from: 'node' }
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      sources: {
        shared: {
          type: 'local',
          url: sourceRoot,
          store: '.'
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
        '--store',
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
          store: 'skills',
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
          '--store',
          '.'
        ],
        { from: 'node' }
      )
    ).rejects.toThrow('Skill path is already occupied: alpha');

    await expect(loadConfig(homeDir)).resolves.toMatchObject({ sources: {} });
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
        '--store',
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
        '--store',
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
        '--store',
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
        '--store',
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
