import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupSkillToSidecar, getSidecarBackupDir, backupDirtySkillsToSidecar } from '../../src/utils/backup.js';

describe('backup - sidecar pattern', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `syncskill-backup-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getSidecarBackupDir', () => {
    it('returns sidecar path next to source', () => {
      const sourcePath = '/path/to/skills/my-source';
      const result = getSidecarBackupDir(sourcePath);
      expect(result).toBe('/path/to/skills/my-source.syncskill-pre-update-backup');
    });
  });

  describe('backupSkillToSidecar', () => {
    it('copies skill to sidecar directory', async () => {
      const sourcePath = join(tempDir, 'my-source');
      const skillPath = join(sourcePath, 'my-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, 'SKILL.md'), '# Test Skill');
      await writeFile(join(skillPath, 'index.ts'), 'export const x = 1;');

      const backupPath = await backupSkillToSidecar({
        sourcePath,
        skillName: 'my-skill',
        skillPath
      });

      const expectedBackupDir = join(tempDir, 'my-source.syncskill-pre-update-backup', 'my-skill');
      expect(backupPath).toBe(expectedBackupDir);

      const skillMd = await readFile(join(expectedBackupDir, 'SKILL.md'), 'utf8');
      expect(skillMd).toBe('# Test Skill');
    });
  });

  describe('backupDirtySkillsToSidecar', () => {
    it('backs up multiple skills', async () => {
      const sourcePath = join(tempDir, 'my-source');

      // Create skills
      const skill1Path = join(sourcePath, 'skill-1');
      const skill2Path = join(sourcePath, 'skill-2');
      await mkdir(skill1Path, { recursive: true });
      await mkdir(skill2Path, { recursive: true });
      await writeFile(join(skill1Path, 'SKILL.md'), '# Skill 1');
      await writeFile(join(skill2Path, 'SKILL.md'), '# Skill 2');

      const result = await backupDirtySkillsToSidecar({
        sourcePath,
        dirtySkills: [
          { name: 'skill-1', path: skill1Path },
          { name: 'skill-2', path: skill2Path }
        ]
      });

      expect(result.sidecarDir).toBe(join(tempDir, 'my-source.syncskill-pre-update-backup'));
      expect(result.backedUp).toHaveLength(2);
      expect(result.backedUp[0].name).toBe('skill-1');
      expect(result.backedUp[1].name).toBe('skill-2');
    });
  });
});
