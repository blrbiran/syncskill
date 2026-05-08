import { cp, lstat, mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expandTargetAgents, getSyncPaths, KNOWN_AGENT_DIRS, loadConfig, saveConfig, type SyncSkillConfig } from './config.js';
import { buildSkillsIndex, saveSkillsIndex } from './source.js';

export interface ScanOptions {
  allAgents: boolean;
}

export interface LinkRequest {
  all: boolean;
  skillName?: string;
}

export interface LinkStatus {
  skill: string;
  agent: string;
  state: 'linked' | 'missing' | 'copied';
}

export async function listLocalSkills(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);

  await mkdir(skillsDir, { recursive: true });

  const entries = await readdir(skillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function discoverSkills(homeDir: string, { allAgents }: ScanOptions): Promise<string[]> {
  const config = await loadConfig(homeDir);
  const existingLinks = new Set(Object.keys(config.links));

  // When skills/ is empty, trigger auto-migration like init does
  const existingSkills = await listLocalSkills(homeDir);
  if (existingSkills.length === 0) {
    await migrateSkillsFromAgentDirs(homeDir, config, allAgents);
  }

  const discoveredSkills = await listLocalSkills(homeDir);
  const addedSkills: string[] = [];

  for (const skill of discoveredSkills) {
    // Track skills that are new (weren't in links before this call)
    if (existingLinks.has(skill)) {
      continue;
    }

    if (!(skill in config.links)) {
      config.links[skill] = allAgents ? ['*'] : [];
    }
    addedSkills.push(skill);
  }

  await saveConfig(config, homeDir);

  return addedSkills;
}

async function migrateSkillsFromAgentDirs(homeDir: string, config: SyncSkillConfig, allAgents: boolean): Promise<void> {
  const { skillsDir } = getSyncPaths(homeDir);
  const sourceRoots = Object.values(KNOWN_AGENT_DIRS).map((dir) => join(homeDir, dir));

  for (const root of sourceRoots) {
    const skillDirs = await listSkillDirectoriesFiltered(root);

    for (const skill of skillDirs) {
      const source = join(root, skill);
      const target = join(skillsDir, skill);

      if (await pathExists(target)) {
        continue;
      }

      // Skip symlinks (only copy regular directories)
      const sourceStat = await lstat(source);
      if (sourceStat.isSymbolicLink()) {
        continue;
      }

      await cp(source, target, { recursive: true });

      if (!config.links[skill]) {
        config.links[skill] = allAgents ? ['*'] : [];
      }
    }
  }
}

async function listSkillDirectoriesFiltered(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureLinkedDirectory(
  sourceDir: string,
  targetDir: string
): Promise<'linked' | 'copied'> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(dirname(targetDir), { recursive: true });

  try {
    await symlink(sourceDir, targetDir);
    return 'linked';
  } catch {
    try {
      await symlink(sourceDir, targetDir, 'junction');
      return 'linked';
    } catch {
      await cp(sourceDir, targetDir, { recursive: true });
      return 'copied';
    }
  }
}

export async function linkConfiguredSkills(homeDir: string, request: LinkRequest): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const skillNames = request.all
    ? Object.keys(config.links).sort()
    : request.skillName
      ? [request.skillName]
      : [];
  const { skillsDir } = getSyncPaths(homeDir);
  const results: LinkStatus[] = [];

  for (const skill of skillNames) {
    const sourceDir = join(skillsDir, skill);
    const sourceStat = await stat(sourceDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Skill source directory not found: ${sourceDir}`);
      }

      throw error;
    });

    if (!sourceStat.isDirectory()) {
      throw new Error(`Skill source path is not a directory: ${sourceDir}`);
    }

    const agents = expandTargetAgents(config, config.links[skill] ?? []);

    for (const agent of agents) {
      const state = await ensureLinkedDirectory(sourceDir, join(config.agents[agent], skill));
      results.push({ skill, agent, state });
    }
  }

  // Generate skills-index.json when linking all skills
  if (request.all) {
    const index = await buildSkillsIndex(homeDir);
    await saveSkillsIndex(homeDir, index);
  }

  return results;
}

export async function unlinkSkill(homeDir: string, skillName: string): Promise<void> {
  const config = await loadConfig(homeDir);
  const agents = expandTargetAgents(config, config.links[skillName] ?? []);

  await Promise.all(agents.map((agent) => rm(join(config.agents[agent], skillName), { recursive: true, force: true })));
}

export async function collectLinkStatus(homeDir: string): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const results: LinkStatus[] = [];

  for (const skill of Object.keys(config.links).sort()) {
    const agents = expandTargetAgents(config, config.links[skill] ?? []);

    for (const agent of agents) {
      const targetDir = join(config.agents[agent], skill);

      try {
        const stat = await lstat(targetDir);

        if (stat.isSymbolicLink()) {
          await readlink(targetDir);
          results.push({ skill, agent, state: 'linked' });
        } else {
          results.push({ skill, agent, state: 'copied' });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          results.push({ skill, agent, state: 'missing' });
          continue;
        }

        throw error;
      }
    }
  }

  return results;
}
