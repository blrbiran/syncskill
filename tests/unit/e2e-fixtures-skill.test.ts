// tests/unit/e2e-fixtures-skill.test.ts
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Skill Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createSkillDir creates a skill directory with SKILL.md', async () => {
    const { createSkillDir } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    const skillPath = await createSkillDir(tempDir, 'my-skill');

    const stats = await stat(skillPath);
    expect(stats.isDirectory()).toBe(true);

    const content = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
    expect(content).toContain('# my-skill');
  });

  it('createSkillDir accepts custom content', async () => {
    const { createSkillDir } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    const customContent = '# Custom Skill\n\nThis is custom.';
    const skillPath = await createSkillDir(tempDir, 'custom', customContent);

    const content = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
    expect(content).toBe(customContent);
  });

  it('createMultipleSkills creates multiple skill directories', async () => {
    const { createMultipleSkills } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    await createMultipleSkills(tempDir, ['skill-a', 'skill-b', 'skill-c']);

    for (const name of ['skill-a', 'skill-b', 'skill-c']) {
      const stats = await stat(join(tempDir, name));
      expect(stats.isDirectory()).toBe(true);
    }
  });
});
