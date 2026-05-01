import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getSyncPaths } from '../src/config.js';
import { buildLocalSkillHashes, hashSkillDirectory } from '../src/manifest.js';

describe('manifest hashing', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('hashSkillDirectory sorts relative paths and ignores symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const skillDir = join(homeDir, '.syncskill', 'skills', 'demo');
    await mkdir(join(skillDir, 'b'), { recursive: true });
    await mkdir(join(skillDir, 'a'), { recursive: true });
    await writeFile(join(skillDir, 'b', 'second.txt'), 'second', 'utf8');
    await writeFile(join(skillDir, 'a', 'first.txt'), 'first', 'utf8');
    await symlink(join(skillDir, 'a', 'first.txt'), join(skillDir, 'link.txt'));

    const withSymlink = await hashSkillDirectory(skillDir);

    await rm(join(skillDir, 'link.txt'));

    const withoutSymlink = await hashSkillDirectory(skillDir);

    expect(withSymlink).toMatch(/^[a-f0-9]{32}$/);
    expect(withSymlink).toBe(withoutSymlink);
  });

  it('buildLocalSkillHashes returns hashes for all local skills in name order', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-manifest-'));
    tempDirs.push(homeDir);

    const { skillsDir } = getSyncPaths(homeDir);
    await mkdir(join(skillsDir, 'welcome'), { recursive: true });
    await mkdir(join(skillsDir, 'ops'), { recursive: true });
    await writeFile(join(skillsDir, 'welcome', 'SKILL.md'), '# welcome', 'utf8');
    await writeFile(join(skillsDir, 'ops', 'SKILL.md'), '# ops', 'utf8');

    const hashes = await buildLocalSkillHashes(homeDir);

    expect(Object.keys(hashes)).toEqual(['ops', 'welcome']);
    expect(hashes.ops).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.welcome).toMatch(/^[a-f0-9]{32}$/);
    expect(hashes.ops).not.toBe(hashes.welcome);
  });
});
