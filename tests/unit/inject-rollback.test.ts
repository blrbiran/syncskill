import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectSkills } from '../../src/inject.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('injectSkills rollback', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inject-rollback-')); });
  afterEach(async () => {
    await chmod(join(root, 'home', '.syncskill', 'skills', 'alpha', 'secret.txt'), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  // Rollback must only delete what this call created; a directory that merely
  // looks like staging (another run's, or the user's) has to survive a failure.
  it.skipIf(isRoot)('never removes a pre-existing .syncskill-inject-* directory when the copy fails', async () => {
    const home = join(root, 'home');
    const skillDir = join(home, '.syncskill', 'skills', 'alpha');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# alpha', 'utf8');
    await writeFile(join(skillDir, 'secret.txt'), 'x', 'utf8');
    await chmod(join(skillDir, 'secret.txt'), 0o000);
    await writeFile(join(home, '.syncskill', 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {}, sources: {}
    }), 'utf8');

    const target = join(root, 'target');
    await mkdir(join(target, '.syncskill-inject-keep'), { recursive: true });
    await writeFile(join(target, '.syncskill-inject-keep', 'userfile'), 'mine', 'utf8');
    // the name the pre-fix code used for its own staging: a collision must not make rollback delete it
    const pidNamed = `.syncskill-inject-${process.pid}`;
    await mkdir(join(target, pidNamed), { recursive: true });
    await writeFile(join(target, pidNamed, 'userfile'), 'other run', 'utf8');

    await expect(injectSkills(home, { skills: ['alpha'], profile: null, target })).rejects.toThrow();

    expect(await readFile(join(target, '.syncskill-inject-keep', 'userfile'), 'utf8')).toBe('mine');
    expect(await readFile(join(target, pidNamed, 'userfile'), 'utf8')).toBe('other run');
    expect((await readdir(target)).sort()).toEqual(['.syncskill-inject-keep', pidNamed].sort());
  });
});
