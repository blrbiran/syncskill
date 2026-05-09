import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncPaths } from './config.js';

export interface IgnoredSkillEntry {
  path: string;
  source: string;
  reason: 'duplicate' | 'user-choice' | 'conflict';
  kept?: {
    path: string;
    source: string;
  };
  ignored_at: string;
}

export interface SkillsIgnore {
  version: 1;
  ignored: Record<string, IgnoredSkillEntry>;
}

export function getSkillsIgnorePath(homeDir: string): string {
  const { syncDir } = getSyncPaths(homeDir);
  return join(syncDir, 'skills-ignore.json');
}

export async function loadSkillsIgnore(homeDir: string): Promise<SkillsIgnore> {
  const path = getSkillsIgnorePath(homeDir);

  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as SkillsIgnore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, ignored: {} };
    }
    throw error;
  }
}

export async function saveSkillsIgnore(homeDir: string, ignore: SkillsIgnore): Promise<void> {
  const path = getSkillsIgnorePath(homeDir);
  await writeFile(path, JSON.stringify(ignore, null, 2), 'utf8');
}

export function isSkillIgnored(ignore: SkillsIgnore, skillName: string): boolean {
  return skillName in ignore.ignored;
}

export function addIgnoredSkill(
  ignore: SkillsIgnore,
  skillName: string,
  entry: Omit<IgnoredSkillEntry, 'ignored_at'>
): SkillsIgnore {
  return {
    ...ignore,
    ignored: {
      ...ignore.ignored,
      [skillName]: {
        ...entry,
        ignored_at: new Date().toISOString()
      }
    }
  };
}

export function removeIgnoredSkill(ignore: SkillsIgnore, skillName: string): SkillsIgnore {
  const { [skillName]: _, ...rest } = ignore.ignored;
  return { ...ignore, ignored: rest };
}
