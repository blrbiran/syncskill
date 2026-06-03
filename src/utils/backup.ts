import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getSyncPaths } from '../config/config.js';
import { pathExists } from './utils.js';

interface CopyDirectorySnapshotOptions {
  sourcePath: string;
  destinationPath: string;
  dereference?: boolean;
}

async function copyDirectorySnapshot(options: CopyDirectorySnapshotOptions): Promise<void> {
  const { sourcePath, destinationPath, dereference = false } = options;

  await rm(destinationPath, { recursive: true, force: true });
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true, dereference });
}

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

  await copyDirectorySnapshot({
    sourcePath: skillPath,
    destinationPath: skillBackupDir,
    dereference: true
  });

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

export function getRestorePreBackupDir(homeDir: string, skillName: string): string {
  return join(getSyncPaths(homeDir).backupsDir, 'skills', skillName, 'pre-restore');
}

export interface BackupSkillBeforePullOptions {
  homeDir: string;
  skillName: string;
  skillPath: string;
}

export interface RestoreSkillFromPullBackupOptions {
  homeDir: string;
  skillName: string;
  targetPath: string;
}

export async function backupSkillBeforePull(options: BackupSkillBeforePullOptions): Promise<string> {
  const { homeDir, skillName, skillPath } = options;
  const backupDir = getPullBackupDir(homeDir, skillName);

  await copyDirectorySnapshot({
    sourcePath: skillPath,
    destinationPath: backupDir
  });

  return backupDir;
}

export async function restoreSkillFromPullBackup(options: RestoreSkillFromPullBackupOptions): Promise<void> {
  const { homeDir, skillName, targetPath } = options;
  const backupPath = getPullBackupDir(homeDir, skillName);
  const preRestoreBackupPath = getRestorePreBackupDir(homeDir, skillName);
  const preRestoreSource = (await pathExists(targetPath)) ? targetPath : backupPath;

  await copyDirectorySnapshot({
    sourcePath: preRestoreSource,
    destinationPath: preRestoreBackupPath
  });
  await copyDirectorySnapshot({
    sourcePath: backupPath,
    destinationPath: targetPath
  });
  await rm(backupPath, { recursive: true, force: true });
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
