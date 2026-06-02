import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getSyncPaths } from '../config/config.js';

export function getSidecarBackupDir(homeDir: string, sourceName: string): string {
  return join(getSyncPaths(homeDir).backupsDir, 'sources', sourceName, 'pre-update');
}

export interface BackupSkillToSidecarOptions {
  homeDir: string;
  sourceName: string;
  skillName: string;
  skillPath: string;
}

export async function backupSkillToSidecar(options: BackupSkillToSidecarOptions): Promise<string> {
  const { homeDir, sourceName, skillName, skillPath } = options;

  const sidecarDir = getSidecarBackupDir(homeDir, sourceName);
  const skillBackupDir = join(sidecarDir, skillName);

  await mkdir(skillBackupDir, { recursive: true });
  await cp(skillPath, skillBackupDir, { recursive: true });

  return skillBackupDir;
}

export interface BackupDirtySkillsToSidecarOptions {
  homeDir: string;
  sourceName: string;
  dirtySkills: Array<{ name: string; path: string }>;
}

export interface SidecarBackupResult {
  sidecarDir: string;
  backedUp: Array<{ name: string; backupPath: string }>;
}

export function getPullBackupDir(homeDir: string, skillName: string): string {
  return join(getSyncPaths(homeDir).backupsDir, 'skills', skillName, 'pre-pull');
}

export interface BackupSkillBeforePullOptions {
  homeDir: string;
  skillName: string;
  skillPath: string;
}

export async function backupSkillBeforePull(options: BackupSkillBeforePullOptions): Promise<string> {
  const { homeDir, skillName, skillPath } = options;
  const backupDir = getPullBackupDir(homeDir, skillName);

  await rm(backupDir, { recursive: true, force: true });
  await mkdir(dirname(backupDir), { recursive: true });
  await cp(skillPath, backupDir, { recursive: true });

  return backupDir;
}

export async function backupDirtySkillsToSidecar(
  options: BackupDirtySkillsToSidecarOptions
): Promise<SidecarBackupResult> {
  const { homeDir, sourceName, dirtySkills } = options;
  const sidecarDir = getSidecarBackupDir(homeDir, sourceName);
  const backedUp: Array<{ name: string; backupPath: string }> = [];

  for (const skill of dirtySkills) {
    const backupPath = await backupSkillToSidecar({
      homeDir,
      sourceName,
      skillName: skill.name,
      skillPath: skill.path
    });
    backedUp.push({ name: skill.name, backupPath });
  }

  return { sidecarDir, backedUp };
}
