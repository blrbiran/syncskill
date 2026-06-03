import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfiguredServer, getSyncPaths, loadConfig, type ConfiguredServer } from '../config/config.js';
import { isNotFoundError } from '../utils/utils.js';
import { probeServerAccess, type ServerProbeResult } from './transport.js';

export type ProbeLine = ServerProbeResult;

export interface ReceiverBackup {
  version: 1;
  server: string;
  updated_at: string;
  remote_agents: Record<string, string>;
  links: Record<string, string[]>;
}

const EMPTY_BACKUP_UPDATED_AT = '1970-01-01T00:00:00.000Z';

export function formatServerListLines(names: string[]): string[] {
  return [...names].sort();
}

export function formatServerShowLines(backup: ReceiverBackup): string[] {
  return [
    `version\t${backup.version}`,
    `server\t${backup.server}`,
    `updated_at\t${backup.updated_at}`,
    ...formatRemoteAgentLines(backup),
    ...formatRemoteLinkLines(backup)
  ];
}

export function formatRemoteAgentLines(backup: ReceiverBackup): string[] {
  return Object.entries(backup.remote_agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, remotePath]) => `remote_agent\t${agent}\t${remotePath}`);
}

export function formatRemoteLinkLines(backup: ReceiverBackup): string[] {
  return Object.entries(backup.links)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skill, agents]) => `link\t${skill}\t${[...agents].sort().join(',')}`);
}

export function formatProbeLines(results: ProbeLine[]): string[] {
  return results.map((result) => `${result.check}\t${result.ok ? 'ok' : 'fail'}\t${result.detail}`);
}

export function createEmptyReceiverBackup(server: string): ReceiverBackup {
  return {
    version: 1,
    server,
    updated_at: EMPTY_BACKUP_UPDATED_AT,
    remote_agents: {},
    links: {}
  };
}

export function expandReceiverLinkAgents(backup: ReceiverBackup, skill: string): string[] {
  const targets = backup.links[skill] ?? [];

  if (targets.includes('*')) {
    return Object.keys(backup.remote_agents).sort();
  }

  return [...new Set(targets)].sort();
}

export async function listServers(homeDir: string): Promise<string[]> {
  return Object.keys((await loadConfig(homeDir)).servers).sort();
}

export async function showServer(homeDir: string, name: string): Promise<ReceiverBackup> {
  return loadReceiverBackup(homeDir, name);
}

export async function loadReceiverBackup(homeDir: string, server: string): Promise<ReceiverBackup> {
  return (await loadReceiverBackupIfExists(homeDir, server)) ?? createEmptyReceiverBackup(server);
}

export async function loadReceiverBackupIfExists(homeDir: string, server: string): Promise<ReceiverBackup | null> {
  try {
    const raw = await readFile(getReceiverBackupFile(homeDir, server), 'utf8');
    return validateReceiverBackup(server, JSON.parse(raw));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

export async function saveReceiverBackup(homeDir: string, backup: ReceiverBackup): Promise<void> {
  const receiversDir = getReceiversDir(homeDir);
  const filePath = getReceiverBackupFile(homeDir, backup.server);
  const tempPath = `${filePath}.tmp`;

  await mkdir(receiversDir, { recursive: true });
  await writeFile(tempPath, JSON.stringify(backup, null, 2) + '\n', 'utf8');
  await rename(tempPath, filePath);
}

export async function probeServer(homeDir: string, name: string): Promise<ProbeLine[]> {
  return probeServerAccess(getConfiguredServer(await loadConfig(homeDir), name));
}

function getReceiversDir(homeDir: string): string {
  return join(getSyncPaths(homeDir).syncDir, 'receivers');
}

function getReceiverBackupFile(homeDir: string, server: string): string {
  return join(getReceiversDir(homeDir), `${server}.json`);
}

function validateReceiverBackup(server: string, value: unknown): ReceiverBackup {
  if (!isRecord(value)) {
    return createEmptyReceiverBackup(server);
  }

  return {
    version: 1,
    server: typeof value.server === 'string' ? value.server : server,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : EMPTY_BACKUP_UPDATED_AT,
    remote_agents: normalizeStringRecord(value.remote_agents),
    links: normalizeLinks(value.links)
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function normalizeLinks(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, agents]) => [key, normalizeStringArray(agents)])
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
