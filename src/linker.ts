import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expandTargetAgents, getSyncPaths, KNOWN_AGENT_DIRS, loadConfig, saveConfig, type SyncSkillConfig } from './config/config.js';
import { buildSkillsIndex, saveSkillsIndex } from './source.js';
import { isNotFoundError, pathExists } from './utils/utils.js';

export interface ScanOptions {
  allAgents: boolean;
  dryRun?: boolean;
}

export interface LinkRequest {
  all: boolean;
  skillName?: string;
}

export interface LinkStatus {
  skill: string;
  agent: string;
  state: 'linked' | 'missing' | 'copied' | 'broken';
}

const STATUS_SYMBOLS: Record<LinkStatus['state'], string> = {
  linked: '✓',
  copied: '⚠',
  missing: '·',
  broken: '✗',
};

export function formatLinkStatusMatrix(statuses: LinkStatus[], verbose: boolean): string {
  if (statuses.length === 0) {
    return 'No skills configured.';
  }

  // Group by skill, collect unique agents
  const skillMap = new Map<string, Map<string, LinkStatus['state']>>();
  const agents = new Set<string>();

  for (const status of statuses) {
    if (!skillMap.has(status.skill)) {
      skillMap.set(status.skill, new Map());
    }
    skillMap.get(status.skill)!.set(status.agent, status.state);
    agents.add(status.agent);
  }

  const agentList = Array.from(agents).sort();
  const skillList = Array.from(skillMap.keys()).sort();

  // Calculate column widths
  const skillColWidth = Math.max(5, ...skillList.map(s => s.length));
  const agentColWidth = verbose ? 8 : 3;

  // Build header
  const lines: string[] = [];
  lines.push('Link Status');
  lines.push('');

  const headerParts = ['Skill'.padEnd(skillColWidth)];
  for (const agent of agentList) {
    headerParts.push(agent.padStart(agentColWidth + 2));
  }
  lines.push(headerParts.join('  '));
  lines.push('─'.repeat(skillColWidth + agentList.length * (agentColWidth + 4)));

  // Build rows
  for (const skill of skillList) {
    const rowParts = [skill.padEnd(skillColWidth)];
    const skillStatuses = skillMap.get(skill)!;

    for (const agent of agentList) {
      const state = skillStatuses.get(agent) ?? 'missing';
      const display = verbose ? state.padStart(agentColWidth + 2) : STATUS_SYMBOLS[state].padStart(agentColWidth + 2);
      rowParts.push(display);
    }
    lines.push(rowParts.join('  '));
  }

  // Legend (only for symbol mode)
  if (!verbose) {
    lines.push('');
    lines.push('Legend: ✓ linked  ⚠ copied  · missing  ✗ broken');
  }

  return lines.join('\n');
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

export async function discoverSkills(homeDir: string, { allAgents, dryRun }: ScanOptions): Promise<string[]> {
  const config = await loadConfig(homeDir);
  const existingLinks = new Set(Object.keys(config.links));

  // When skills/ is empty, trigger auto-migration like init does (skip in dry-run mode)
  const existingSkills = await listLocalSkills(homeDir);
  if (existingSkills.length === 0 && !dryRun) {
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

  // Skip saving config in dry-run mode
  if (!dryRun) {
    await saveConfig(config, homeDir);
  }

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

// pathExists is now imported from utils.ts

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

export async function unlinkSkillFromAgent(
  homeDir: string,
  skillName: string,
  agentName: string
): Promise<void> {
  const config = await loadConfig(homeDir);
  const agentPath = config.agents[agentName];
  if (!agentPath) {
    return;
  }

  const linkPath = join(agentPath, skillName);
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      await rm(linkPath);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

export async function collectLinkStatus(homeDir: string): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const results: LinkStatus[] = [];

  for (const skill of Object.keys(config.links).sort()) {
    const agents = expandTargetAgents(config, config.links[skill] ?? []);

    for (const agent of agents) {
      const targetDir = join(config.agents[agent], skill);

      try {
        const lstats = await lstat(targetDir);

        if (lstats.isSymbolicLink()) {
          // Check if symlink target exists
          try {
            await stat(targetDir); // follows symlink
            results.push({ skill, agent, state: 'linked' });
          } catch {
            // Symlink exists but target doesn't - broken
            results.push({ skill, agent, state: 'broken' });
          }
        } else {
          results.push({ skill, agent, state: 'copied' });
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          results.push({ skill, agent, state: 'missing' });
          continue;
        }
        throw error;
      }
    }
  }

  return results;
}

export interface UnmanagedSkill {
  name: string;
  path: string;
  agent: string;
}

export interface StaleLink {
  skill: string;
  agent: string;
  path: string;
}

export interface ReconcileResult {
  removed: string[];   // Paths that were cleaned up
  skipped: string[];   // Paths skipped (not managed by syncskill)
  errors: string[];    // Paths that failed to clean up
}

export interface StaleLinksBySkill {
  [skillName: string]: StaleLink[];
}

export async function findUnmanagedSkills(homeDir: string): Promise<UnmanagedSkill[]> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const managedSkills = new Set(await listLocalSkills(homeDir));
  const unmanaged: UnmanagedSkill[] = [];

  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    const resolvedPath = agentPath.replace(/^~/, homeDir);

    try {
      const entries = await readdir(resolvedPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(resolvedPath, entry.name);

        // Check if it's a symlink pointing to our managed skills
        try {
          const linkTarget = await readlink(skillPath);
          if (linkTarget.startsWith(skillsDir)) continue;
        } catch {
          // Not a symlink, or error reading - continue checking
        }

        // Check if skill has SKILL.md (valid skill directory)
        try {
          await readFile(join(skillPath, 'SKILL.md'), 'utf8');

          if (!managedSkills.has(entry.name)) {
            unmanaged.push({
              name: entry.name,
              path: skillPath,
              agent: agentName
            });
          }
        } catch {
          // No SKILL.md, skip
        }
      }
    } catch {
      // Agent directory doesn't exist or not accessible
    }
  }

  return unmanaged;
}

/**
 * Find stale links - symlinks in agent directories that point to syncskill-managed skills
 * but are no longer configured in config.links for that agent.
 */
export async function findStaleLinks(
  homeDir: string,
  skillNames?: string[]
): Promise<StaleLinksBySkill> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const staleBySkill: StaleLinksBySkill = {};

  // If specific skills provided, only check those; otherwise check all configured links
  const skillsToCheck = skillNames ?? Object.keys(config.links);

  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    const resolvedPath = agentPath.replace(/^~/, homeDir);

    try {
      const entries = await readdir(resolvedPath, { withFileTypes: true });

      for (const entry of entries) {
        const skillPath = join(resolvedPath, entry.name);
        const skillName = entry.name;

        // Only check skills we're interested in
        if (skillNames && !skillNames.includes(skillName)) {
          continue;
        }

        // Check if it's a symlink pointing to our managed skills directory
        try {
          const linkTarget = await readlink(skillPath);
          if (!linkTarget.startsWith(skillsDir)) {
            // Not managed by syncskill, skip
            continue;
          }

          // Check if this skill-agent combination is still in config
          const configuredAgents = expandTargetAgents(config, config.links[skillName] ?? []);
          if (!configuredAgents.includes(agentName)) {
            // This link is stale - skill exists in agent but not configured
            if (!staleBySkill[skillName]) {
              staleBySkill[skillName] = [];
            }
            staleBySkill[skillName].push({
              skill: skillName,
              agent: agentName,
              path: skillPath
            });
          }
        } catch {
          // Not a symlink or error reading, skip
        }
      }
    } catch {
      // Agent directory doesn't exist or not accessible
    }
  }

  return staleBySkill;
}

/**
 * Reconcile stale symlinks in agent directories.
 *
 * A link is considered stale if:
 * - It's a symlink pointing to a syncskill-managed path (.syncskill/skills/)
 * - The skill was removed from config.links OR the agent was removed from the skill's targets
 *
 * @param skillNames - Specific skills to check, or empty array for all skills in all agent dirs
 * @param config - The current SyncSkillConfig
 * @returns ReconcileResult with removed paths, skipped paths, and errors
 */
export function reconcileStaleLinks(
  skillNames: string[],
  config: SyncSkillConfig
): Promise<ReconcileResult> {
  return reconcileStaleLinksImpl(skillNames, config);
}

async function reconcileStaleLinksImpl(
  skillNames: string[],
  config: SyncSkillConfig
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    removed: [],
    skipped: [],
    errors: []
  };

  // Build a set of valid (skill, agent) pairs from config
  const validPairs = new Set<string>();
  for (const [skill, targets] of Object.entries(config.links)) {
    const agents = expandTargetAgents(config, targets);
    for (const agent of agents) {
      validPairs.add(`${skill}:${agent}`);
    }
  }

  // Check each agent directory for stale links
  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(agentPath, { withFileTypes: true });
    } catch {
      // Agent directory doesn't exist, skip
      continue;
    }

    for (const entry of entries) {
      const skillName = entry.name;

      // In single-skill mode, only check the specified skills
      if (skillNames.length > 0 && !skillNames.includes(skillName)) {
        continue;
      }

      const targetPath = join(agentPath, skillName);

      // Skip if not a symlink (real directories should not be touched)
      let lstats: import('node:fs').Stats;
      try {
        lstats = await lstat(targetPath);
      } catch {
        continue;
      }

      if (!lstats.isSymbolicLink()) {
        result.skipped.push(targetPath);
        continue;
      }

      // Check if symlink points to a syncskill-managed path
      let linkTarget: string;
      try {
        linkTarget = await readlink(targetPath);
      } catch {
        continue;
      }

      // Only manage symlinks that point to .syncskill/skills/
      if (!linkTarget.includes('.syncskill') || !linkTarget.includes('skills')) {
        result.skipped.push(targetPath);
        continue;
      }

      // Check if this (skill, agent) pair is still valid
      const pairKey = `${skillName}:${agentName}`;
      if (validPairs.has(pairKey)) {
        // Still valid, skip
        continue;
      }

      // Stale link detected - remove it
      try {
        await rm(targetPath, { force: true });
        result.removed.push(targetPath);
      } catch (error) {
        result.errors.push(`Failed to remove ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return result;
}
