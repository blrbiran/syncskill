import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncPaths } from './config.js';
import { isNotFoundError } from './utils.js';

export interface SkillRegistryEntry {
  path: string;
  origin: string;
  type: 'manual' | 'git' | 'http' | 'local';
  status: 'active' | 'ignored';
  ignored_reason?: 'duplicate' | 'user-choice' | 'conflict';
  ignored_at?: string;
  kept_by?: string;
}

export interface SkillsRegistry {
  version: 1;
  skills: Record<string, SkillRegistryEntry>;
}

export function getSkillsRegistryPath(homeDir: string): string {
  const { syncDir } = getSyncPaths(homeDir);
  return join(syncDir, 'skills-registry.json');
}

export async function loadSkillsRegistry(homeDir: string): Promise<SkillsRegistry> {
  const path = getSkillsRegistryPath(homeDir);

  try {
    const content = await readFile(path, 'utf8');
    return normalizeSkillsRegistry(JSON.parse(content));
  } catch (error) {
    if (isNotFoundError(error)) {
      return { version: 1, skills: {} };
    }
    throw error;
  }
}

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

export async function saveSkillsRegistry(homeDir: string, registry: SkillsRegistry): Promise<void> {
  const path = getSkillsRegistryPath(homeDir);
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function isSkillIgnored(registry: SkillsRegistry, skillName: string): boolean {
  const entry = registry.skills[skillName];
  return entry !== undefined && entry.status === 'ignored';
}

export function isSkillActive(registry: SkillsRegistry, skillName: string): boolean {
  const entry = registry.skills[skillName];
  return entry !== undefined && entry.status === 'active';
}

export function getActiveSkills(registry: SkillsRegistry): Record<string, SkillRegistryEntry> {
  const active: Record<string, SkillRegistryEntry> = {};
  for (const [name, entry] of Object.entries(registry.skills)) {
    if (entry.status === 'active') {
      active[name] = entry;
    }
  }
  return active;
}

export function getIgnoredSkills(registry: SkillsRegistry): Record<string, SkillRegistryEntry> {
  const ignored: Record<string, SkillRegistryEntry> = {};
  for (const [name, entry] of Object.entries(registry.skills)) {
    if (entry.status === 'ignored') {
      ignored[name] = entry;
    }
  }
  return ignored;
}

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

export function removeSkill(registry: SkillsRegistry, skillName: string): SkillsRegistry {
  const { [skillName]: _, ...rest } = registry.skills;
  return { ...registry, skills: rest };
}

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
