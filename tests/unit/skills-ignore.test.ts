import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSkillsIgnore,
  saveSkillsIgnore,
  isSkillIgnored,
  addIgnoredSkill,
  removeIgnoredSkill
} from '../../src/skills-ignore.js';

describe('skills-ignore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `skills-ignore-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads empty ignore file when none exists', async () => {
    const ignore = await loadSkillsIgnore(tempDir);
    expect(ignore.version).toBe(1);
    expect(ignore.ignored).toEqual({});
  });

  it('saves and loads ignore entries', async () => {
    const ignore = addIgnoredSkill(
      { version: 1, ignored: {} },
      'test-skill',
      {
        path: '/path/to/skill',
        source: 'my-source',
        reason: 'duplicate',
        kept: { path: '/path/to/other', source: 'other-source' }
      }
    );

    await saveSkillsIgnore(tempDir, ignore);
    const loaded = await loadSkillsIgnore(tempDir);

    expect(isSkillIgnored(loaded, 'test-skill')).toBe(true);
    expect(loaded.ignored['test-skill'].reason).toBe('duplicate');
  });

  it('removes ignored skill', () => {
    let ignore = addIgnoredSkill(
      { version: 1, ignored: {} },
      'test-skill',
      { path: '/path', source: 'src', reason: 'user-choice' }
    );

    expect(isSkillIgnored(ignore, 'test-skill')).toBe(true);

    ignore = removeIgnoredSkill(ignore, 'test-skill');

    expect(isSkillIgnored(ignore, 'test-skill')).toBe(false);
  });
});
