import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfiguredServer, loadConfig, getSyncPaths, type ConfiguredServer } from './config/config.js';
import { isNotFoundError } from './utils/utils.js';
import { getDiffRows, getStatusRows, reconcileManifest } from './core/conflict.js';
import {
  loadServerManifest,
  refreshLocalManifest,
  saveServerManifest,
  setManifestPreview,
  type ManifestDirection,
  type ManifestStatus,
  type ServerManifest
} from './core/manifest.js';
import {
  loadReceiverBackupIfExists,
  mergeRefreshedReceiverBackup,
  saveReceiverBackup,
} from './core/server.js';
import { createTransportRuntime, refreshRemoteManifestFromServer, scanRemoteAgents } from './core/transport.js';

export interface RefreshStoredManifestOptions {
  all?: boolean;
  local?: boolean;
  remote?: boolean;
  server?: string;
  now?: string;
  /** Tester #474: false computes the refreshed manifests without writing anything (read-only commands). */
  persist?: boolean;
}

export async function listTrackedServers(homeDir: string): Promise<string[]> {
  const [configuredServers, storedServers] = await Promise.all([
    listConfiguredServers(homeDir),
    listStoredServers(homeDir)
  ]);

  return [...new Set([...configuredServers, ...storedServers])].sort();
}

export async function loadTrackedManifests(homeDir: string, server?: string): Promise<ServerManifest[]> {
  const servers = await resolveTargetServers(homeDir, server);
  const manifests = await Promise.all(servers.map(async (name) => reconcileManifest(await loadServerManifest(homeDir, name))));

  return manifests.sort((left, right) => left.server.localeCompare(right.server));
}

export function shouldRefreshLocal(options: RefreshStoredManifestOptions): boolean {
  if (options.all === true) {
    return true;
  }

  return options.local === true || options.remote !== true;
}

export function shouldRefreshRemote(options: RefreshStoredManifestOptions): boolean {
  if (options.all === true) {
    return true;
  }

  return options.remote === true;
}

export async function refreshStoredManifests(
  homeDir: string,
  options: RefreshStoredManifestOptions = {}
): Promise<ServerManifest[]> {
  const refreshLocal = shouldRefreshLocal(options);
  const refreshRemote = shouldRefreshRemote(options);
  const updatedAt = options.now ?? new Date().toISOString();
  const persist = options.persist !== false;
  const servers = await resolveTargetServers(homeDir, options.server);
  const manifests: ServerManifest[] = [];

  const config = refreshRemote ? await loadConfig(homeDir) : null;

  for (const server of servers) {
    const loaded = refreshLocal
      ? await refreshLocalManifest(homeDir, server, updatedAt, persist)
      : await loadServerManifest(homeDir, server);
    let reconciled = reconcileManifest(loaded);

    if (refreshRemote) {
      const configuredServer = getConfiguredServer(config ?? await loadConfig(homeDir), server);
      const runtime = createTransportRuntime();
      const refreshedRemote = await refreshRemoteManifestFromServer(
        configuredServer,
        runtime,
        reconciled,
        updatedAt
      );
      if (persist) await saveServerManifest(homeDir, refreshedRemote);

      if (persist && options.server === server) {
        await saveRefreshedReceiverBackup(homeDir, configuredServer, runtime, updatedAt);
      }

      manifests.push(refreshedRemote);
      continue;
    }

    if (persist) await saveServerManifest(homeDir, reconciled);
    manifests.push(reconciled);
  }

  return manifests.sort((left, right) => left.server.localeCompare(right.server));
}

export interface StatusJsonSkill {
  name: string;
  status: ManifestStatus;
  action: ManifestDirection;
  local_hash: string | null;
  remote_hash: string | null;
  baseline_hash: string | null;
  recorded_hash: string | null;
}

export interface StatusJsonServer {
  server: string;
  skills: StatusJsonSkill[];
}

export function formatStatusLines(manifests: ServerManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    getStatusRows(manifest).map((row) => `${row.skill}\t${row.server}\t${row.direction}\t${row.status}`)
  );
}

export function buildStatusJson(manifests: ServerManifest[]): { servers: StatusJsonServer[] } {
  return {
    servers: manifests.map((manifest) => ({
      server: manifest.server,
      skills: getStatusRows(manifest).map((row) => ({
        name: row.skill,
        status: row.status,
        action: row.direction,
        local_hash: row.local_hash,
        remote_hash: row.remote_hash,
        baseline_hash: row.recorded_hash,
        recorded_hash: row.recorded_hash
      }))
    }))
  };
}

export function formatDiffLines(manifest: ServerManifest): string[] {
  return getDiffRows(manifest).map(
    (row) =>
      `${row.skill}\t${row.direction}\t${row.local_hash ?? '-'}\t${row.remote_hash ?? '-'}\t${row.recorded_hash ?? '-'}`
  );
}

/** Tester #474: `readOnly` (status, any --dry-run) refreshes in memory only -- the command reads the refreshed manifests
 * through loadServerManifest's preview and nothing under the sync dir is written. */
export async function autoRefreshManifests(homeDir: string, enabled: boolean, options: { readOnly?: boolean } = {}): Promise<void> {
  setManifestPreview(homeDir, null);
  if (!enabled) {
    return;
  }

  try {
    if (options.readOnly === true) {
      setManifestPreview(homeDir, await refreshStoredManifests(homeDir, { local: true, persist: false }));
      return;
    }
    await refreshStoredManifests(homeDir, { local: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARNING: auto refresh failed: ${message}`);
  }
}

async function saveRefreshedReceiverBackup(
  homeDir: string,
  server: ConfiguredServer,
  runtime: ReturnType<typeof createTransportRuntime>,
  updatedAt: string
): Promise<void> {
  const previous = await loadReceiverBackupIfExists(homeDir, server.name);
  const scanned = await scanRemoteAgents(server, runtime, { deploy: false });
  const backup = mergeRefreshedReceiverBackup(previous, server, scanned, updatedAt);
  await saveReceiverBackup(homeDir, backup);
}

async function listConfiguredServers(homeDir: string): Promise<string[]> {
  try {
    return Object.keys((await loadConfig(homeDir)).servers).sort();
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function listStoredServers(homeDir: string): Promise<string[]> {
  const { manifestsDir } = getSyncPaths(homeDir);
  // Tester #474: listing does not create the directory (status must write nothing); none yet means no stored manifests.
  let entries;
  try {
    entries = await readdir(manifestsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}

async function resolveTargetServers(homeDir: string, server?: string): Promise<string[]> {
  if (typeof server === 'string') {
    return [server];
  }

  return listTrackedServers(homeDir);
}
