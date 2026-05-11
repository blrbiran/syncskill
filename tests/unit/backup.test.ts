import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BackupMeta,
  loadBackupMeta,
  saveBackupMeta,
  getBackupDir,
  backupSkill
} from '../../src/backup.js';

describe('backup', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `backup-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getBackupDir', () => {
    it('returns correct path for source and skill', () => {
      const result = getBackupDir('/home/user/.syncskill/backups', 'my-source', 'my-skill');
      expect(result).toBe('/home/user/.syncskill/backups/my-source/my-skill');
    });
  });

  describe('loadBackupMeta', () => {
    it('returns empty meta when file does not exist', async () => {
      const meta = await loadBackupMeta(join(testDir, 'nonexistent'));
      expect(meta).toEqual({});
    });

    it('loads existing meta file', async () => {
      const metaDir = join(testDir, 'source1');
      await mkdir(metaDir, { recursive: true });
      const expected: BackupMeta = {
        'skill-a': {
          backed_up_at: '2026-05-11T12:00:00Z',
          reason: 'force-update',
          original_hash: 'abc123'
        }
      };
      await writeFile(join(metaDir, '_meta.json'), JSON.stringify(expected));

      const meta = await loadBackupMeta(metaDir);
      expect(meta).toEqual(expected);
    });
  });

  describe('saveBackupMeta', () => {
    it('creates meta file with entries', async () => {
      const metaDir = join(testDir, 'source2');
      await mkdir(metaDir, { recursive: true });

      const meta: BackupMeta = {
        'skill-x': {
          backed_up_at: '2026-05-11T14:00:00Z',
          reason: 'force-update',
          original_hash: 'def456'
        }
      };

      await saveBackupMeta(metaDir, meta);

      const content = await readFile(join(metaDir, '_meta.json'), 'utf8');
      expect(JSON.parse(content)).toEqual(meta);
    });
  });

  describe('backupSkill', () => {
    it('copies skill directory and updates meta', async () => {
      const backupsDir = join(testDir, 'backups');
      const skillPath = join(testDir, 'skills', 'my-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, 'SKILL.md'), '# Test Skill');

      const result = await backupSkill({
        backupsDir,
        sourceName: 'test-source',
        skillName: 'my-skill',
        skillPath,
        originalHash: 'hash123'
      });

      expect(result).toBe(join(backupsDir, 'test-source', 'my-skill'));

      const content = await readFile(join(result, 'SKILL.md'), 'utf8');
      expect(content).toBe('# Test Skill');

      const meta = await loadBackupMeta(join(backupsDir, 'test-source'));
      expect(meta['my-skill']).toBeDefined();
      expect(meta['my-skill'].original_hash).toBe('hash123');
      expect(meta['my-skill'].reason).toBe('force-update');
    });
  });
});
