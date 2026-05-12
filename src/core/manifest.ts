import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { getSyncPaths } from '../config/config.js';
import { reconcileManifest } from './conflict.js';
import { isNotFoundError } from '../utils/utils.js';

export async function listLocalSkillNames(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);

  await mkdir(skillsDir, { recursive: true });

  const entries = await readdir(skillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function hashSkillDirectory(skillDir: string): Promise<string> {
  const files = await collectFileEntries(skillDir);
  const hash = createHash('md5');

  for (const file of files) {
    hash.update(Buffer.from(file.relativePath, 'utf8'));
    hash.update(file.contents);
  }

  return hash.digest('hex');
}

export type ManifestDirection = 'push' | 'pull' | 'skip' | 'conflict';
export type ManifestStatus = 'in-sync' | 'local-changed' | 'remote-changed' | 'conflict' | 'new';

export interface ManifestSkillState {
  local_hash: string | null;
  remote_hash: string | null;
  recorded_hash: string | null;
  direction: ManifestDirection;
  status: ManifestStatus;
}

export interface ServerManifest {
  version: 1;
  server: string;
  updated_at: string;
  skills: Record<string, ManifestSkillState>;
}

export interface ManifestHistoryEntry {
  skill: string;
  server: string;
  old_hash: string | null;
  new_hash: string | null;
  direction: 'local' | 'remote';
  updated_at: string;
}

export interface ManifestHistory {
  version: 1;
  entries: ManifestHistoryEntry[];
}

export async function buildLocalSkillHashes(homeDir: string): Promise<Record<string, string>> {
  const { skillsDir } = getSyncPaths(homeDir);
  const skillNames = await listLocalSkillNames(homeDir);
  const entries = await Promise.all(
    skillNames.map(async (skillName) => [skillName, await hashSkillDirectory(join(skillsDir, skillName))] as const)
  );

  return Object.fromEntries(entries);
}

export function createEmptyManifest(server: string, updatedAt = nowIso()): ServerManifest {
  return {
    version: 1,
    server,
    updated_at: updatedAt,
    skills: {}
  };
}

export async function loadServerManifest(homeDir: string, server: string): Promise<ServerManifest> {
  const { manifestsDir } = getSyncPaths(homeDir);
  const manifestFile = join(manifestsDir, `${server}.json`);

  try {
    const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Partial<ServerManifest>;

    return {
      version: 1,
      server,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
      skills: Object.fromEntries(
        Object.entries(raw.skills ?? {}).map(([skill, state]) => [skill, normalizeSkillState(state)])
      )
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return createEmptyManifest(server);
    }
    throw error;
  }
}

export async function saveServerManifest(homeDir: string, manifest: ServerManifest): Promise<void> {
  const { manifestsDir } = getSyncPaths(homeDir);
  await mkdir(manifestsDir, { recursive: true });
  await writeFile(join(manifestsDir, `${manifest.server}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function loadManifestHistory(homeDir: string): Promise<ManifestHistory> {
  const { historyFile } = getSyncPaths(homeDir);

  try {
    const raw = JSON.parse(await readFile(historyFile, 'utf8')) as Partial<ManifestHistory>;

    return {
      version: 1,
      entries: Array.isArray(raw.entries) ? raw.entries.flatMap(normalizeHistoryEntry) : []
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

export async function saveManifestHistory(homeDir: string, history: ManifestHistory): Promise<void> {
  const { historyFile, syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  await writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

export function applyRemoteSnapshot(
  manifest: ServerManifest,
  remoteHashes: Record<string, string>,
  updatedAt: string
): ServerManifest {
  const skillNames = [...new Set([...Object.keys(manifest.skills), ...Object.keys(remoteHashes)])].sort();

  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      skillNames.map((skill) => {
        const previous = manifest.skills[skill] ?? createEmptySkillState();

        return [
          skill,
          {
            ...previous,
            remote_hash: remoteHashes[skill] ?? null
          }
        ];
      })
    )
  });
}

export function rebuildRemoteManifestFromHashes(
  manifest: ServerManifest,
  remoteHashes: Record<string, string>,
  updatedAt: string
): ServerManifest {
  const skillNames = Object.keys(remoteHashes).sort();

  return {
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      skillNames.map((skill) => {
        const previous = manifest.skills[skill] ?? createEmptySkillState();
        const remoteHash = remoteHashes[skill];

        return [
          skill,
          {
            ...previous,
            remote_hash: remoteHash,
            direction: 'pull',
            status: previous.recorded_hash === null ? 'new' : previous.recorded_hash === remoteHash ? 'in-sync' : 'remote-changed'
          }
        ];
      })
    )
  };
}

export function collectRemoteHistoryEntries(
  previous: ServerManifest,
  next: ServerManifest,
  updatedAt: string
): ManifestHistoryEntry[] {
  const skillNames = [...new Set([...Object.keys(previous.skills), ...Object.keys(next.skills)])].sort();

  return skillNames.flatMap((skill) => {
    const before = previous.skills[skill]?.remote_hash ?? null;
    const after = next.skills[skill]?.remote_hash ?? null;

    if (before === after) {
      return [];
    }

    return [
      {
        skill,
        server: next.server,
        old_hash: before,
        new_hash: after,
        direction: 'remote',
        updated_at: updatedAt
      }
    ];
  });
}

export function finalizePushedSkills(
  manifest: ServerManifest,
  skills: string[],
  updatedAt: string
): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill) || state.local_hash === null) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            remote_hash: state.local_hash,
            recorded_hash: state.local_hash
          }
        ];
      })
    )
  });
}

export function finalizePulledSkills(
  manifest: ServerManifest,
  skills: string[],
  updatedAt: string
): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill) || state.remote_hash === null) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            local_hash: state.remote_hash,
            recorded_hash: state.remote_hash
          }
        ];
      })
    )
  });
}

export async function refreshLocalManifest(
  homeDir: string,
  server: string,
  updatedAt = nowIso()
): Promise<ServerManifest> {
  const manifest = await loadServerManifest(homeDir, server);
  const history = await loadManifestHistory(homeDir);
  const localHashes = await buildLocalSkillHashes(homeDir);
  const skillNames = [...new Set([...Object.keys(manifest.skills), ...Object.keys(localHashes)])].sort();
  const nextSkills: Record<string, ManifestSkillState> = {};

  for (const skill of skillNames) {
    const previous = manifest.skills[skill] ?? createEmptySkillState();
    const nextLocalHash = localHashes[skill] ?? null;

    if (previous.local_hash !== null && previous.local_hash !== nextLocalHash) {
      history.entries.push({
        skill,
        server: 'local',
        old_hash: previous.local_hash,
        new_hash: nextLocalHash,
        direction: 'local',
        updated_at: updatedAt
      });
    }

    nextSkills[skill] = {
      ...previous,
      local_hash: nextLocalHash
    };
  }

  const nextManifest: ServerManifest = {
    ...manifest,
    updated_at: updatedAt,
    skills: nextSkills
  };

  await saveServerManifest(homeDir, nextManifest);
  await saveManifestHistory(homeDir, history);

  return nextManifest;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptySkillState(): ManifestSkillState {
  return {
    local_hash: null,
    remote_hash: null,
    recorded_hash: null,
    direction: 'skip',
    status: 'in-sync'
  };
}

function normalizeSkillState(value: unknown): ManifestSkillState {
  const state = (value ?? {}) as Partial<ManifestSkillState>;

  return {
    local_hash: typeof state.local_hash === 'string' ? state.local_hash : null,
    remote_hash: typeof state.remote_hash === 'string' ? state.remote_hash : null,
    recorded_hash: typeof state.recorded_hash === 'string' ? state.recorded_hash : null,
    direction: state.direction === 'push' || state.direction === 'pull' || state.direction === 'conflict' ? state.direction : 'skip',
    status:
      state.status === 'local-changed' ||
      state.status === 'remote-changed' ||
      state.status === 'conflict' ||
      state.status === 'new'
        ? state.status
        : 'in-sync'
  };
}

function normalizeHistoryEntry(value: unknown): ManifestHistoryEntry[] {
  if (!isRecord(value)) {
    return [];
  }

  const direction = value.direction === 'local' || value.direction === 'remote' ? value.direction : null;
  const skill = typeof value.skill === 'string' ? value.skill : null;
  const server = typeof value.server === 'string' ? value.server : null;
  const updatedAt = typeof value.updated_at === 'string' ? value.updated_at : null;

  if (direction === null || skill === null || server === null || updatedAt === null) {
    return [];
  }

  return [
    {
      skill,
      server,
      old_hash: typeof value.old_hash === 'string' ? value.old_hash : null,
      new_hash: typeof value.new_hash === 'string' ? value.new_hash : null,
      direction,
      updated_at: updatedAt
    }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface FileEntry {
  relativePath: string;
  contents: Buffer;
}

async function collectFileEntries(rootDir: string, currentDir = rootDir): Promise<FileEntry[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFileEntries(rootDir, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      const stat = await lstat(fullPath);

      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
    }

    files.push({
      relativePath: relative(rootDir, fullPath).replaceAll('\\', '/'),
      contents: await readFile(fullPath)
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
