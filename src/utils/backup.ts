import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function getSidecarBackupDir(sourcePath: string): string {
  return `${sourcePath}.syncskill-pre-update-backup`;
}

export interface BackupSkillToSidecarOptions {
  sourcePath: string;
  skillName: string;
  skillPath: string;
}

export async function backupSkillToSidecar(options: BackupSkillToSidecarOptions): Promise<string> {
  const { sourcePath, skillName, skillPath } = options;

  const sidecarDir = getSidecarBackupDir(sourcePath);
  const skillBackupDir = join(sidecarDir, skillName);

  await mkdir(skillBackupDir, { recursive: true });
  await cp(skillPath, skillBackupDir, { recursive: true });

  return skillBackupDir;
}

export interface BackupDirtySkillsToSidecarOptions {
  sourcePath: string;
  dirtySkills: Array<{ name: string; path: string }>;
}

export interface SidecarBackupResult {
  sidecarDir: string;
  backedUp: Array<{ name: string; backupPath: string }>;
}

export async function backupDirtySkillsToSidecar(
  options: BackupDirtySkillsToSidecarOptions
): Promise<SidecarBackupResult> {
  const { sourcePath, dirtySkills } = options;
  const sidecarDir = getSidecarBackupDir(sourcePath);
  const backedUp: Array<{ name: string; backupPath: string }> = [];

  for (const skill of dirtySkills) {
    const backupPath = await backupSkillToSidecar({
      sourcePath,
      skillName: skill.name,
      skillPath: skill.path
    });
    backedUp.push({ name: skill.name, backupPath });
  }

  return { sidecarDir, backedUp };
}
