import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncPaths } from '../config/config.js';
import { isNotFoundError } from '../utils/utils.js';

export interface GitUpdateRecord {
  type: 'git';
  before_commit: string;
  after_commit: string;
  stash_commit: string;
  timestamp: string;
}

export interface HttpUpdateRecord {
  type: 'http';
  backup_path: string;
  dirty_skills: string[];
  timestamp: string;
}

export type UpdateRecord = GitUpdateRecord | HttpUpdateRecord;
export type UpdateHistory = Record<string, UpdateRecord>;

function getUpdateHistoryPath(homeDir: string): string {
  return join(getSyncPaths(homeDir).syncDir, 'update-history.json');
}

export async function loadUpdateHistory(homeDir: string): Promise<UpdateHistory> {
  const historyPath = getUpdateHistoryPath(homeDir);

  try {
    const content = await readFile(historyPath, 'utf8');
    return JSON.parse(content) as UpdateHistory;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

export async function saveUpdateHistory(homeDir: string, history: UpdateHistory): Promise<void> {
  const { syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  const historyPath = getUpdateHistoryPath(homeDir);
  await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

export async function recordGitOverwrite(homeDir: string, sourceName: string, record: GitUpdateRecord): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  history[sourceName] = record;
  await saveUpdateHistory(homeDir, history);
}

export async function recordHttpOverwrite(homeDir: string, sourceName: string, record: HttpUpdateRecord): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  history[sourceName] = record;
  await saveUpdateHistory(homeDir, history);
}

export async function clearSourceHistory(homeDir: string, sourceName: string): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  delete history[sourceName];
  await saveUpdateHistory(homeDir, history);
}

export async function getSourceHistory(homeDir: string, sourceName: string): Promise<UpdateRecord | null> {
  const history = await loadUpdateHistory(homeDir);
  return history[sourceName] ?? null;
}
