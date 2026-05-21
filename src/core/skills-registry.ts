import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncPaths } from '../config/config.js';
import type { SyncSkillConfig } from '../config/config.js';
import { hashSkillDirectory } from './manifest.js';
import { isNotFoundError } from '../utils/utils.js';

export interface SkillRegistryEntry {
  path: string;
  origin: string;
  type: 'manual' | 'git' | 'http' | 'local';
  status: 'active' | 'ignored';
  ignored_reason?: 'duplicate' | 'user-choice' | 'conflict';
  ignored_at?: string;
  kept_by?: string;
  last_update_hash?: string;  // Only for HTTP sources, used for dirty detection
}

export interface IgnoredSkillEntry {
  reason: 'duplicate' | 'user-choice' | 'conflict';
  ignored_at: string;
  kept_by?: string;
}

export interface HttpBaseline {
  hash: string;
  source: string;
}

export interface SkillsRegistry {
  version: number;
  skills: Record<string, SkillRegistryEntry>;
}

export interface SkillsRegistryV2 {
  version: 2;
  ignored: Record<string, IgnoredSkillEntry>;
  http_baselines: Record<string, HttpBaseline>;
}

export function getSkillsRegistryPath(homeDir: string): string {
  const { syncDir } = getSyncPaths(homeDir);
  return join(syncDir, 'skills-registry.json');
}

/**
 * @deprecated Use loadSkillsRegistryV2 instead. This function will be removed in v3.
 */
export async function loadSkillsRegistry(homeDir: string): Promise<SkillsRegistry> {
  const path = getSkillsRegistryPath(homeDir);

  try {
    const content = await readFile(path, 'utf8');
    try {
      return normalizeSkillsRegistry(JSON.parse(content));
    } catch {
      return { version: 1, skills: {} };
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return { version: 1, skills: {} };
    }
    throw error;
  }
}

/**
 * @deprecated Use normalizeRegistryV2 instead. This function will be removed in v3.
 */
export function normalizeSkillsRegistry(value: unknown): SkillsRegistry {
  if (typeof value !== 'object' || value === null) {
    return { version: 1, skills: {} };
  }

  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.skills !== 'object' || obj.skills === null) {
    return { version: 1, skills: {} };
  }

  return value as SkillsRegistry;
}

/**
 * @deprecated Use saveSkillsRegistryV2 instead. This function will be removed in v3.
 */
export async function saveSkillsRegistry(homeDir: string, registry: SkillsRegistry): Promise<void> {
  const { syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  const path = getSkillsRegistryPath(homeDir);
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function createEmptyRegistryV2(): SkillsRegistryV2 {
  return { version: 2, ignored: {}, http_baselines: {} };
}

export async function loadSkillsRegistryV2(homeDir: string): Promise<SkillsRegistryV2> {
  const path = getSkillsRegistryPath(homeDir);

  try {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content);

    if (parsed.version === 2) {
      return normalizeRegistryV2(parsed);
    }

    if (parsed.version === 1) {
      return migrateV1ToV2(normalizeSkillsRegistry(parsed));
    }

    return createEmptyRegistryV2();
  } catch (error) {
    if (isNotFoundError(error)) {
      return createEmptyRegistryV2();
    }
    throw error;
  }
}

function normalizeRegistryV2(value: unknown): SkillsRegistryV2 {
  if (typeof value !== 'object' || value === null) {
    return createEmptyRegistryV2();
  }

  const obj = value as Record<string, unknown>;
  if (obj.version !== 2) {
    return createEmptyRegistryV2();
  }

  return {
    version: 2,
    ignored: typeof obj.ignored === 'object' && obj.ignored !== null
      ? obj.ignored as Record<string, IgnoredSkillEntry>
      : {},
    http_baselines: typeof obj.http_baselines === 'object' && obj.http_baselines !== null
      ? obj.http_baselines as Record<string, HttpBaseline>
      : {}
  };
}

function migrateV1ToV2(v1: SkillsRegistry): SkillsRegistryV2 {
  const v2 = createEmptyRegistryV2();

  for (const [skillName, entry] of Object.entries(v1.skills)) {
    if (entry.status === 'ignored' && entry.ignored_reason) {
      v2.ignored[skillName] = {
        reason: entry.ignored_reason,
        ignored_at: entry.ignored_at ?? new Date().toISOString(),
        ...(entry.kept_by && { kept_by: entry.kept_by })
      };
    }

    if (entry.type === 'http' && entry.last_update_hash) {
      v2.http_baselines[skillName] = {
        hash: entry.last_update_hash,
        source: entry.origin
      };
    }
  }

  return v2;
}

export async function saveSkillsRegistryV2(homeDir: string, registry: SkillsRegistryV2): Promise<void> {
  const { syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  const path = getSkillsRegistryPath(homeDir);
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function isSkillIgnoredV2(registry: SkillsRegistryV2, skillName: string): boolean {
  return skillName in registry.ignored;
}

export function ignoreSkillV2(
  registry: SkillsRegistryV2,
  skillName: string,
  reason: 'duplicate' | 'user-choice' | 'conflict',
  keptBy?: string
): SkillsRegistryV2 {
  return {
    ...registry,
    ignored: {
      ...registry.ignored,
      [skillName]: {
        reason,
        ignored_at: new Date().toISOString(),
        ...(keptBy && { kept_by: keptBy })
      }
    }
  };
}

export function unignoreSkillV2(registry: SkillsRegistryV2, skillName: string): SkillsRegistryV2 {
  const { [skillName]: _, ...rest } = registry.ignored;
  return { ...registry, ignored: rest };
}

export function setHttpBaselineV2(
  registry: SkillsRegistryV2,
  skillName: string,
  hash: string,
  source: string
): SkillsRegistryV2 {
  return {
    ...registry,
    http_baselines: {
      ...registry.http_baselines,
      [skillName]: { hash, source }
    }
  };
}

export function getHttpBaselineV2(
  registry: SkillsRegistryV2,
  skillName: string
): HttpBaseline | null {
  return registry.http_baselines[skillName] ?? null;
}

export function removeHttpBaselineV2(registry: SkillsRegistryV2, skillName: string): SkillsRegistryV2 {
  const { [skillName]: _, ...rest } = registry.http_baselines;
  return { ...registry, http_baselines: rest };
}

/**
 * @deprecated Use isSkillIgnoredV2 instead. This function will be removed in v3.
 */
export function isSkillIgnored(registry: SkillsRegistry, skillName: string): boolean {
  const entry = registry.skills[skillName];
  return entry !== undefined && entry.status === 'ignored';
}

/**
 * @deprecated v2 registry does not track active status. Derive from filesystem instead.
 */
export function isSkillActive(registry: SkillsRegistry, skillName: string): boolean {
  const entry = registry.skills[skillName];
  return entry !== undefined && entry.status === 'active';
}

/**
 * @deprecated v2 registry does not track active status. Derive from filesystem instead.
 */
export function getActiveSkills(registry: SkillsRegistry): Record<string, SkillRegistryEntry> {
  const active: Record<string, SkillRegistryEntry> = {};
  for (const [name, entry] of Object.entries(registry.skills)) {
    if (entry.status === 'active') {
      active[name] = entry;
    }
  }
  return active;
}

/**
 * @deprecated Use SkillsRegistryV2.ignored instead.
 */
export function getIgnoredSkills(registry: SkillsRegistry): Record<string, SkillRegistryEntry> {
  const ignored: Record<string, SkillRegistryEntry> = {};
  for (const [name, entry] of Object.entries(registry.skills)) {
    if (entry.status === 'ignored') {
      ignored[name] = entry;
    }
  }
  return ignored;
}

/**
 * @deprecated v2 registry does not track active skills. Skills are active by default unless ignored.
 */
export function addActiveSkill(
  registry: SkillsRegistry,
  skillName: string,
  entry: { path: string; origin: string; type: SkillRegistryEntry['type'] }
): SkillsRegistry {
  return {
    ...registry,
    skills: {
      ...registry.skills,
      [skillName]: {
        ...entry,
        status: 'active'
      }
    }
  };
}

/**
 * @deprecated Use ignoreSkillV2 instead.
 */
export function addIgnoredSkill(
  registry: SkillsRegistry,
  skillName: string,
  entry: {
    path: string;
    origin: string;
    type: SkillRegistryEntry['type'];
    ignored_reason: 'duplicate' | 'user-choice' | 'conflict';
    kept_by?: string;
  }
): SkillsRegistry {
  return {
    ...registry,
    skills: {
      ...registry.skills,
      [skillName]: {
        ...entry,
        status: 'ignored',
        ignored_at: new Date().toISOString()
      }
    }
  };
}

/**
 * @deprecated v2 registry does not track skill existence. Use unignoreSkillV2 to restore ignored skills.
 */
export function removeSkill(registry: SkillsRegistry, skillName: string): SkillsRegistry {
  const { [skillName]: _, ...rest } = registry.skills;
  return { ...registry, skills: rest };
}

/**
 * @deprecated Use unignoreSkillV2 instead.
 */
export function activateSkill(registry: SkillsRegistry, skillName: string): SkillsRegistry {
  const entry = registry.skills[skillName];
  if (!entry) return registry;

  const { ignored_reason, ignored_at, kept_by, ...rest } = entry;
  return {
    ...registry,
    skills: {
      ...registry.skills,
      [skillName]: { ...rest, status: 'active' }
    }
  };
}

/**
 * @deprecated Use ignoreSkillV2 instead.
 */
export function ignoreSkill(
  registry: SkillsRegistry,
  skillName: string,
  reason: 'duplicate' | 'user-choice' | 'conflict',
  keptBy?: string
): SkillsRegistry {
  const entry = registry.skills[skillName];
  if (!entry) return registry;

  return {
    ...registry,
    skills: {
      ...registry.skills,
      [skillName]: {
        ...entry,
        status: 'ignored',
        ignored_reason: reason,
        ignored_at: new Date().toISOString(),
        ...(keptBy && { kept_by: keptBy })
      }
    }
  };
}

/**
 * @deprecated Use rebuildRegistryV2 from registry-builder.ts instead.
 */
export async function rebuildSkillsRegistry(
  homeDir: string,
  config: SyncSkillConfig
): Promise<SkillsRegistry> {
  const { skillsDir } = getSyncPaths(homeDir);
  const registry: SkillsRegistry = { version: 1, skills: {} };

  // 1. Scan ~/.syncskill/skills/ for manual skills
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(skillsDir, entry.name);
      const skillMdPath = join(skillPath, 'SKILL.md');

      try {
        await access(skillMdPath);
        registry.skills[entry.name] = {
          path: skillPath,
          origin: 'manual',
          type: 'manual',
          status: 'active'
        };
      } catch {
        // No SKILL.md, skip
      }
    }
  } catch {
    // skillsDir may not exist
  }

  // 2. Scan sources from config
  for (const [sourceName, sourceRaw] of Object.entries(config.sources)) {
    const source = sourceRaw as Record<string, unknown>;
    const sourcePath = source.path as string | undefined;
    const sourceType = source.type as string | undefined;
    const ignoreList = (source.ignore as string[]) ?? [];

    if (!sourcePath || !sourceType) continue;

    try {
      const entries = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(sourcePath, entry.name);
        const skillMdPath = join(skillPath, 'SKILL.md');

        try {
          await access(skillMdPath);

          const isIgnored = ignoreList.includes(entry.name);
          const entryData: SkillRegistryEntry = {
            path: skillPath,
            origin: sourceName,
            type: sourceType as 'git' | 'http' | 'local',
            status: isIgnored ? 'ignored' : 'active'
          };

          if (isIgnored) {
            entryData.ignored_reason = 'user-choice';
            entryData.ignored_at = new Date().toISOString();
          }

          // For HTTP sources, compute last_update_hash
          if (sourceType === 'http' && !isIgnored) {
            try {
              entryData.last_update_hash = await hashSkillDirectory(skillPath);
            } catch {
              // Hash computation failed, skip
            }
          }

          // Don't overwrite if already exists from manual (manual takes precedence)
          if (!registry.skills[entry.name]) {
            registry.skills[entry.name] = entryData;
          }
        } catch {
          // No SKILL.md, skip
        }
      }
    } catch {
      // Source path may not exist
    }
  }

  return registry;
}
