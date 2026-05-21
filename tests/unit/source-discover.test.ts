import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { discoverSourceSkills } from '../../src/source/discover.js';

describe('source/discover', () => {
  const tempDirs = useTempDirs();

  it('discovers top-level skill directories containing SKILL.md', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-discover-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, 'skill-a'), { recursive: true });
    await mkdir(join(homeDir, 'skill-b'), { recursive: true });
    await mkdir(join(homeDir, 'not-a-skill'), { recursive: true });
    await writeFile(join(homeDir, 'skill-a', 'SKILL.md'), '# Skill A');
    await writeFile(join(homeDir, 'skill-b', 'SKILL.md'), '# Skill B');
    await writeFile(join(homeDir, 'not-a-skill', 'README.md'), '# Not a skill');

    const skills = await discoverSourceSkills(homeDir);

    expect(skills).toEqual([
      { name: 'skill-a', path: join(homeDir, 'skill-a') },
      { name: 'skill-b', path: join(homeDir, 'skill-b') }
    ]);
  });

  it('returns empty array when source path does not exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-discover-'));
    tempDirs.push(homeDir);

    const skills = await discoverSourceSkills(join(homeDir, 'missing'));

    expect(skills).toEqual([]);
  });

  it('ignores files and nested directories without top-level SKILL.md', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-discover-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, 'container', 'nested-skill'), { recursive: true });
    await writeFile(join(homeDir, 'container', 'nested-skill', 'SKILL.md'), '# Nested Skill');
    await writeFile(join(homeDir, 'plain-file.txt'), 'hello');

    const skills = await discoverSourceSkills(homeDir);

    expect(skills).toEqual([]);
  });
});
