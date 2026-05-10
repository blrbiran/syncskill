import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfiguredServer, loadConfig, getSyncPaths } from './config.js';
import { isNotFoundError } from './utils.js';
import { getDiffRows, getStatusRows, reconcileManifest } from './conflict.js';
import {
  loadServerManifest,
  refreshLocalManifest,
  saveServerManifest,
  type ServerManifest
} from './manifest.js';
import { createTransportRuntime, refreshRemoteManifestFromServer } from './transport.js';

export interface RefreshStoredManifestOptions {
  all?: boolean;
  local?: boolean;
  remote?: boolean;
  server?: string;
  now?: string;
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
  const servers = await resolveTargetServers(homeDir, options.server);
  const manifests: ServerManifest[] = [];

  const config = refreshRemote ? await loadConfig(homeDir) : null;

  for (const server of servers) {
    const loaded = refreshLocal
      ? await refreshLocalManifest(homeDir, server, updatedAt)
      : await loadServerManifest(homeDir, server);
    let reconciled = reconcileManifest(loaded);

    if (refreshRemote) {
      const refreshedRemote = await refreshRemoteManifestFromServer(
        getConfiguredServer(config ?? await loadConfig(homeDir), server),
        createTransportRuntime(),
        reconciled,
        updatedAt
      );
      await saveServerManifest(homeDir, refreshedRemote);
      manifests.push(refreshedRemote);
      continue;
    }

    await saveServerManifest(homeDir, reconciled);
    manifests.push(reconciled);
  }

  return manifests.sort((left, right) => left.server.localeCompare(right.server));
}

export function formatStatusLines(manifests: ServerManifest[]): string[] {
  return manifests.flatMap((manifest) =>
    getStatusRows(manifest).map((row) => `${row.skill}\t${row.server}\t${row.direction}\t${row.status}`)
  );
}

export function formatDiffLines(manifest: ServerManifest): string[] {
  return getDiffRows(manifest).map(
    (row) =>
      `${row.skill}\t${row.direction}\t${row.local_hash ?? '-'}\t${row.remote_hash ?? '-'}\t${row.recorded_hash ?? '-'}`
  );
}

export async function autoRefreshManifests(homeDir: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  try {
    await refreshStoredManifests(homeDir, { local: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARNING: auto refresh failed: ${message}`);
  }
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
  await mkdir(manifestsDir, { recursive: true });
  const entries = await readdir(manifestsDir, { withFileTypes: true });

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
