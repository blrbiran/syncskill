import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFoundError } from './utils.js';

export interface BackupMetaEntry {
  backed_up_at: string;
  reason: 'force-update';
  original_hash: string;
}

export type BackupMeta = Record<string, BackupMetaEntry>;

export function getBackupDir(backupsDir: string, sourceName: string, skillName: string): string {
  return join(backupsDir, sourceName, skillName);
}

export async function loadBackupMeta(sourceBackupDir: string): Promise<BackupMeta> {
  const metaPath = join(sourceBackupDir, '_meta.json');

  try {
    const content = await readFile(metaPath, 'utf8');
    return JSON.parse(content) as BackupMeta;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

export async function saveBackupMeta(sourceBackupDir: string, meta: BackupMeta): Promise<void> {
  await mkdir(sourceBackupDir, { recursive: true });
  const metaPath = join(sourceBackupDir, '_meta.json');
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export interface BackupSkillOptions {
  backupsDir: string;
  sourceName: string;
  skillName: string;
  skillPath: string;
  originalHash: string;
}

export async function backupSkill(options: BackupSkillOptions): Promise<string> {
  const { backupsDir, sourceName, skillName, skillPath, originalHash } = options;

  const sourceBackupDir = join(backupsDir, sourceName);
  const skillBackupDir = getBackupDir(backupsDir, sourceName, skillName);

  await mkdir(skillBackupDir, { recursive: true });
  await cp(skillPath, skillBackupDir, { recursive: true });

  const meta = await loadBackupMeta(sourceBackupDir);
  meta[skillName] = {
    backed_up_at: new Date().toISOString(),
    reason: 'force-update',
    original_hash: originalHash
  };
  await saveBackupMeta(sourceBackupDir, meta);

  return skillBackupDir;
}

export interface BackupDirtySkillsOptions {
  backupsDir: string;
  sourceName: string;
  dirtySkills: Array<{ name: string; path: string; hash: string }>;
}

export interface BackupResult {
  backedUp: Array<{ name: string; backupPath: string }>;
}

export async function backupDirtySkills(options: BackupDirtySkillsOptions): Promise<BackupResult> {
  const { backupsDir, sourceName, dirtySkills } = options;
  const backedUp: Array<{ name: string; backupPath: string }> = [];

  for (const skill of dirtySkills) {
    const backupPath = await backupSkill({
      backupsDir,
      sourceName,
      skillName: skill.name,
      skillPath: skill.path,
      originalHash: skill.hash
    });
    backedUp.push({ name: skill.name, backupPath });
  }

  return { backedUp };
}
