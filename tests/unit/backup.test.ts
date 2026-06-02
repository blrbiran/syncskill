import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupDirtySkillsToSidecar,
  backupSkillBeforePull,
  backupSkillToSidecar,
  getPullBackupDir,
  getSidecarBackupDir
} from '../../src/utils/backup.js';

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
      const result = getSidecarBackupDir('/tmp/home', 'my-source');
      expect(result).toBe('/tmp/home/.syncskill/.backups/sources/my-source/pre-update');
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
        homeDir: tempDir,
        sourceName: 'my-source',
        skillName: 'my-skill',
        skillPath
      });

      const expectedBackupDir = join(tempDir, '.syncskill', '.backups', 'sources', 'my-source', 'pre-update', 'my-skill');
      expect(backupPath).toBe(expectedBackupDir);

      const skillMd = await readFile(join(expectedBackupDir, 'SKILL.md'), 'utf8');
      expect(skillMd).toBe('# Test Skill');
    });

    it('replaces any previous sidecar backup and dereferences symlinked skills', async () => {
      const checkoutDir = join(tempDir, '.syncskill', '.sources', 'http-source', 'checkout');
      const materializedDir = join(tempDir, '.syncskill', 'skills');
      const sourceSkillDir = join(checkoutDir, 'http-skill');
      const skillPath = join(materializedDir, 'http-skill');
      const existingBackupDir = join(tempDir, '.syncskill', '.backups', 'sources', 'http-source', 'pre-update', 'http-skill');
      await mkdir(sourceSkillDir, { recursive: true });
      await mkdir(materializedDir, { recursive: true });
      await mkdir(existingBackupDir, { recursive: true });
      await writeFile(join(existingBackupDir, 'SKILL.md'), '# stale backup');
      await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Symlink Skill');
      await writeFile(join(sourceSkillDir, 'notes.txt'), 'copied contents');
      await import('node:fs/promises').then(({ symlink }) => symlink(sourceSkillDir, skillPath, 'dir'));

      const backupPath = await backupSkillToSidecar({
        homeDir: tempDir,
        sourceName: 'http-source',
        skillName: 'http-skill',
        skillPath
      });

      expect(backupPath).toBe(existingBackupDir);
      await expect(readFile(join(existingBackupDir, 'SKILL.md'), 'utf8')).resolves.toBe('# Symlink Skill');
      await expect(readFile(join(existingBackupDir, 'notes.txt'), 'utf8')).resolves.toBe('copied contents');
    });
  });

  describe('getPullBackupDir', () => {
    it('returns pre-pull backup path for a skill', () => {
      const result = getPullBackupDir('/tmp/home', 'my-skill');
      expect(result).toBe('/tmp/home/.syncskill/.backups/skills/my-skill/pre-pull');
    });
  });

  describe('backupSkillBeforePull', () => {
    it('replaces any previous pre-pull backup with current local contents', async () => {
      const skillPath = join(tempDir, '.syncskill', 'skills', 'my-skill');
      const existingBackup = getPullBackupDir(tempDir, 'my-skill');
      await mkdir(skillPath, { recursive: true });
      await mkdir(existingBackup, { recursive: true });
      await writeFile(join(existingBackup, 'SKILL.md'), '# stale backup');
      await writeFile(join(skillPath, 'SKILL.md'), '# Current Skill');

      const backupPath = await backupSkillBeforePull({
        homeDir: tempDir,
        skillName: 'my-skill',
        skillPath
      });

      expect(backupPath).toBe(existingBackup);
      await expect(readFile(join(existingBackup, 'SKILL.md'), 'utf8')).resolves.toBe('# Current Skill');
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
        homeDir: tempDir,
        sourceName: 'my-source',
        dirtySkills: [
          { name: 'skill-1', path: skill1Path },
          { name: 'skill-2', path: skill2Path }
        ]
      });

      expect(result.sidecarDir).toBe(join(tempDir, '.syncskill', '.backups', 'sources', 'my-source', 'pre-update'));
      expect(result.backedUp).toHaveLength(2);
      expect(result.backedUp[0].name).toBe('skill-1');
      expect(result.backedUp[1].name).toBe('skill-2');
    });
  });
});
