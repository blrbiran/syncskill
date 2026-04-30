import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SyncPaths {
  syncDir: string;
  configFile: string;
  skillsDir: string;
  manifestsDir: string;
  tempDir: string;
  historyFile: string;
}

export function getSyncDir(homeDir = homedir()): string {
  return join(homeDir, '.syncskill');
}

export function getSyncPaths(homeDir = homedir()): SyncPaths {
  const syncDir = getSyncDir(homeDir);

  return {
    syncDir,
    configFile: join(syncDir, 'config.yaml'),
    skillsDir: join(syncDir, 'skills'),
    manifestsDir: join(syncDir, 'manifests'),
    tempDir: join(syncDir, '.tmp'),
    historyFile: join(syncDir, 'manifest_history.json')
  };
}
