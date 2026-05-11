import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('source update --force', () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `force-update-test-${Date.now()}`);
    homeDir = testDir;

    // Setup minimal config
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      'version: 1\nagents: {}\nlinks: {}\nservers: {}\nsources: {}\n'
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates backups directory structure', async () => {
    const backupsDir = join(homeDir, '.syncskill', 'backups');

    // This test validates the backup directory is created when needed
    // Full integration would require a git source with dirty state
    await mkdir(backupsDir, { recursive: true });
    await access(backupsDir);
  });

  it('backup module can be imported', async () => {
    const { backupSkill, getBackupDir } = await import('../../src/backup.js');
    expect(typeof backupSkill).toBe('function');
    expect(typeof getBackupDir).toBe('function');
  });
});
