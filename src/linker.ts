import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { expandMaterializedTargetAgents, expandTargetAgents, getSyncPaths, KNOWN_AGENT_DIRS, loadConfig, resolveAgentPath, saveConfig, type SyncSkillConfig } from './config/config.js';
import { ensureDefaultLinkTargets } from './core/private-agents.js';
import { rebuildRegistryV2 } from './core/registry-builder.js';
import { saveSkillsRegistryV2 } from './core/skills-registry.js';
import { discoverActiveSourceSkillNames, resolveLinkedSkillSourcePath } from './source.js';
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
  state: 'linked' | 'missing' | 'copied' | 'broken' | 'unconfigured' | 'failed';
  error?: string;
}

const STATUS_SYMBOLS: Record<LinkStatus['state'], string> = {
  linked: '✓',
  copied: '⚠',
  missing: '·',
  broken: '✗',
  unconfigured: '-',
  failed: '!',
};

export function formatLinkStatusMatrix(statuses: LinkStatus[], verbose: boolean, privateAgents: string[] = []): string {
  if (statuses.length === 0) {
    return 'No managed local skills or configured agents.';
  }

  // Group by skill, collect unique agents
  const skillMap = new Map<string, Map<string, LinkStatus['state']>>();
  const agents = new Set<string>();
  const privateAgentSet = new Set(privateAgents);

  for (const status of statuses) {
    if (!skillMap.has(status.skill)) {
      skillMap.set(status.skill, new Map());
    }
    skillMap.get(status.skill)!.set(status.agent, status.state);
    agents.add(status.agent);
  }

  const agentList = Array.from(agents).sort();
  const skillList = Array.from(skillMap.keys()).sort();
  const displayAgentNames = agentList.map((agent) => privateAgentSet.has(agent) ? `${agent}*` : agent);

  // Calculate column widths
  const skillColWidth = Math.max(5, ...skillList.map(s => s.length));
  const stateLabelWidth = Math.max(...Object.keys(STATUS_SYMBOLS).map((label) => label.length));
  const agentColWidth = Math.max(verbose ? stateLabelWidth : 3, ...displayAgentNames.map((name) => name.length));

  // Build header
  const lines: string[] = [];
  lines.push('Realized Link Status');
  lines.push('Current on-disk state for managed skills × agents. Use `syncskill link` to edit configured targets.');
  lines.push('Symbols: `-` = not configured, `·` = configured but missing on disk.');
  lines.push('');

  const headerParts = ['Skill'.padEnd(skillColWidth)];
  for (const agentName of displayAgentNames) {
    headerParts.push(agentName.padStart(agentColWidth + 2));
  }
  lines.push(headerParts.join('  '));
  lines.push('─'.repeat(skillColWidth + agentList.length * (agentColWidth + 4)));

  // Build rows
  for (const skill of skillList) {
    const rowParts = [skill.padEnd(skillColWidth)];
    const skillStatuses = skillMap.get(skill)!;

    for (const agent of agentList) {
      const state = skillStatuses.get(agent) ?? 'unconfigured';
      const display = verbose ? state.padStart(agentColWidth + 2) : STATUS_SYMBOLS[state].padStart(agentColWidth + 2);
      rowParts.push(display);
    }
    lines.push(rowParts.join('  '));
  }

  lines.push('');
  if (!verbose) {
    lines.push('Legend: ✓ linked  ⚠ copied  · missing  ✗ broken  - unconfigured');
  }
  if (displayAgentNames.some((name) => name.endsWith('*'))) {
    lines.push('* = private agent (requires separate link)');
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

  // Git and http sources are copied into ~/.syncskill/skills/, but local ones
  // stay where they are, so scanning that directory alone silently misses every
  // skill a local source holds. Source discovery honours each source's `ignore`.
  const discoveredSkills = [
    ...new Set([
      ...await listLocalSkills(homeDir),
      ...await discoverActiveSourceSkillNames(homeDir, config.sources)
    ])
  ].sort();
  const addedSkills: string[] = [];

  for (const skill of discoveredSkills) {
    // Track skills that are new (weren't in links before this call)
    if (existingLinks.has(skill)) {
      continue;
    }

    if (!(skill in config.links)) {
      config.links[skill] = allAgents ? await ensureDefaultLinkTargets(homeDir, config) : [];
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
        config.links[skill] = allAgents ? await ensureDefaultLinkTargets(homeDir, config) : [];
      }
    }
  }
}

/**
 * List real skill directories under an agent directory.
 *
 * Agent directories also hold bookkeeping directories from other tools
 * (`.curator_backups`, `.omc`, `.system`, ...). Adopting those as skills
 * pollutes config.links and later breaks `link build`, so require both a
 * non-hidden name and a SKILL.md marker.
 */
async function listSkillDirectoriesFiltered(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();

    const checked = await Promise.all(
      candidates.map(async (name) => (await isSkillDirectory(join(root, name))) ? name : null)
    );

    return checked.filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

async function isSkillDirectory(dir: string): Promise<boolean> {
  return pathExists(join(dir, 'SKILL.md'));
}

async function resolveConfiguredSkillSourceDir(homeDir: string, skill: string): Promise<string> {
  const { skillsDir } = getSyncPaths(homeDir);
  const managedPath = join(skillsDir, skill);

  try {
    const managedStat = await stat(managedPath);
    if (!managedStat.isDirectory()) {
      throw new Error(`Skill source path is not a directory: ${managedPath}`);
    }
    return managedPath;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const localSourcePath = await resolveLinkedSkillSourcePath(homeDir, skill);
  if (localSourcePath) {
    const localSourceStat = await stat(localSourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Skill source directory not found: ${localSourcePath}`);
      }

      throw error;
    });

    if (!localSourceStat.isDirectory()) {
      throw new Error(`Skill source path is not a directory: ${localSourcePath}`);
    }

    return localSourcePath;
  }

  throw new Error(`Skill source directory not found: ${managedPath}`);
}

async function readResolvedLinkTarget(targetPath: string): Promise<string | null> {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isSymbolicLink()) {
      return null;
    }

    return resolve(dirname(targetPath), await readlink(targetPath));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function isManagedSkillLink(homeDir: string, skillName: string, targetPath: string): Promise<boolean> {
  const linkTarget = await readResolvedLinkTarget(targetPath);
  if (!linkTarget) {
    return false;
  }

  const { skillsDir } = getSyncPaths(homeDir);
  const managedPath = resolve(join(skillsDir, skillName));
  if (linkTarget === managedPath) {
    return true;
  }

  const localSourcePath = await resolveLinkedSkillSourcePath(homeDir, skillName);
  return localSourcePath !== null && linkTarget === resolve(localSourcePath);
}

export async function ensureLinkedDirectory(
  sourceDir: string,
  targetDir: string
): Promise<'linked' | 'copied'> {
  const currentTarget = await readResolvedLinkTarget(targetDir);
  if (currentTarget === resolve(sourceDir)) {
    return 'linked';
  }

  try {
    const existing = await lstat(targetDir);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace existing non-symlink target: ${targetDir}`);
    }
    await rm(targetDir, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

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

function resolveMaterializedAgentPath(config: SyncSkillConfig, agent: string, homeDir: string): string {
  if (agent === 'agents') {
    return join(homeDir, '.agents', 'skills');
  }

  return resolveAgentPath(config.agents[agent], homeDir);
}

interface MaterializedAgentDirectory {
  representativeAgent: string;
  logicalAgents: string[];
  scanPath: string;
  canonicalPath: string;
}

async function canonicalizeAgentPath(agentPath: string): Promise<string> {
  try {
    return await realpath(agentPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return resolve(agentPath);
    }

    throw error;
  }
}

function listMaterializedAgentNames(config: SyncSkillConfig): string[] {
  return [...new Set([...Object.keys(config.agents), 'agents'])];
}

async function buildMaterializedAgentDirectoryIndex(
  config: SyncSkillConfig,
  homeDir: string
): Promise<{
  agentCanonicalPaths: Map<string, string>;
  directories: MaterializedAgentDirectory[];
}> {
  const agentCanonicalPaths = new Map<string, string>();
  const groupedDirectories = new Map<string, Array<{ agent: string; path: string }>>();

  for (const agent of listMaterializedAgentNames(config)) {
    const path = resolveMaterializedAgentPath(config, agent, homeDir);
    const canonicalPath = await canonicalizeAgentPath(path);
    agentCanonicalPaths.set(agent, canonicalPath);

    const entries = groupedDirectories.get(canonicalPath) ?? [];
    entries.push({ agent, path });
    groupedDirectories.set(canonicalPath, entries);
  }

  const directories = [...groupedDirectories.entries()].map(([canonicalPath, entries]) => {
    const representative = entries.find((entry) => resolve(entry.path) === canonicalPath) ?? entries[0];

    return {
      representativeAgent: representative.agent,
      logicalAgents: entries.map((entry) => entry.agent),
      scanPath: representative.path,
      canonicalPath
    };
  });

  return { agentCanonicalPaths, directories };
}

function buildValidDirectoryPairs(
  config: SyncSkillConfig,
  agentCanonicalPaths: Map<string, string>
): Set<string> {
  const validPairs = new Set<string>();

  for (const [skill, targets] of Object.entries(config.links)) {
    const agents = expandMaterializedTargetAgents(config, targets);
    for (const agent of agents) {
      const canonicalPath = agentCanonicalPaths.get(agent);
      if (canonicalPath) {
        validPairs.add(`${skill}:${canonicalPath}`);
      }
    }
  }

  return validPairs;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function linkConfiguredSkills(homeDir: string, request: LinkRequest): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const skillNames = request.all
    ? Object.keys(config.links).sort()
    : request.skillName
      ? [request.skillName]
      : [];
  const results: LinkStatus[] = [];

  for (const skill of skillNames) {
    const agents = expandMaterializedTargetAgents(config, config.links[skill] ?? []);

    let sourceDir: string;
    try {
      sourceDir = await resolveConfiguredSkillSourceDir(homeDir, skill);
    } catch (error) {
      // A single unusable entry must not abort a whole `link build` run.
      // Explicit single-skill requests still fail loudly.
      if (!request.all) {
        throw error;
      }
      for (const agent of agents) {
        results.push({ skill, agent, state: 'failed', error: describeError(error) });
      }
      continue;
    }

    for (const agent of agents) {
      const agentPath = resolveMaterializedAgentPath(config, agent, homeDir);
      try {
        const state = await ensureLinkedDirectory(sourceDir, join(agentPath, skill));
        results.push({ skill, agent, state });
      } catch (error) {
        if (!request.all) {
          throw error;
        }
        results.push({ skill, agent, state: 'failed', error: describeError(error) });
      }
    }
  }

  // Generate skills-registry.json when linking all skills
  if (request.all) {
    const registry = await rebuildRegistryV2(homeDir, config);
    await saveSkillsRegistryV2(homeDir, registry);
  }

  return results;
}

export async function unlinkSkill(homeDir: string, skillName: string): Promise<void> {
  const config = await loadConfig(homeDir);
  const agents = expandMaterializedTargetAgents(config, config.links[skillName] ?? []);

  await Promise.all(agents.map((agent) => {
    const agentPath = resolveMaterializedAgentPath(config, agent, homeDir);
    return rm(join(agentPath, skillName), { recursive: true, force: true });
  }));
}

export async function unlinkSkillFromAgent(
  homeDir: string,
  skillName: string,
  agentName: string
): Promise<void> {
  const config = await loadConfig(homeDir);
  const agentPath = agentName === 'agents'
    ? join(homeDir, '.agents', 'skills')
    : config.agents[agentName]
      ? resolveAgentPath(config.agents[agentName], homeDir)
      : null;
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
  const localSkills = await listLocalSkills(homeDir);
  const sourceSkills = [...await discoverActiveSourceSkillNames(homeDir, config.sources)];
  const skillNames = [...new Set([...localSkills, ...sourceSkills, ...Object.keys(config.links)])].sort();
  const configuredAgentNames = new Set(Object.keys(config.agents));
  for (const targets of Object.values(config.links)) {
    if (targets.includes('agents')) {
      configuredAgentNames.add('agents');
    }
  }
  const agentNames = [...configuredAgentNames].sort();

  for (const skill of skillNames) {
    const configuredAgents = new Set(expandMaterializedTargetAgents(config, config.links[skill] ?? []));

    for (const agent of agentNames) {
      const agentPath = resolveMaterializedAgentPath(config, agent, homeDir);
      const targetDir = join(agentPath, skill);

      try {
        const lstats = await lstat(targetDir);

        if (lstats.isSymbolicLink()) {
          try {
            await stat(targetDir);
            if (await isManagedSkillLink(homeDir, skill, targetDir)) {
              results.push({ skill, agent, state: 'linked' });
            } else {
              results.push({ skill, agent, state: 'broken' });
            }
          } catch {
            results.push({ skill, agent, state: 'broken' });
          }
        } else {
          results.push({ skill, agent, state: 'copied' });
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          results.push({
            skill,
            agent,
            state: configuredAgents.has(agent) ? 'missing' : 'unconfigured'
          });
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
  const managedSkills = new Set([
    ...await listLocalSkills(homeDir),
    ...await discoverActiveSourceSkillNames(homeDir, config.sources)
  ]);
  const unmanaged: UnmanagedSkill[] = [];

  for (const [agentName, rawAgentPath] of Object.entries(config.agents)) {
    const agentPath = resolveAgentPath(rawAgentPath, homeDir);

    try {
      const entries = await readdir(agentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(agentPath, entry.name);

        // Check if it's a symlink already managed by syncskill
        try {
          if (await isManagedSkillLink(homeDir, entry.name, skillPath)) continue;
        } catch {
          // Not a managed symlink, or error reading - continue checking
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
  const staleBySkill: StaleLinksBySkill = {};
  const { agentCanonicalPaths, directories } = await buildMaterializedAgentDirectoryIndex(config, homeDir);
  const validPairs = buildValidDirectoryPairs(config, agentCanonicalPaths);

  for (const directory of directories) {
    try {
      const entries = await readdir(directory.scanPath, { withFileTypes: true });

      for (const entry of entries) {
        const skillPath = join(directory.scanPath, entry.name);
        const skillName = entry.name;

        if (skillNames && !skillNames.includes(skillName)) {
          continue;
        }

        try {
          if (!(await isManagedSkillLink(homeDir, skillName, skillPath))) {
            continue;
          }

          if (validPairs.has(`${skillName}:${directory.canonicalPath}`)) {
            continue;
          }

          if (!staleBySkill[skillName]) {
            staleBySkill[skillName] = [];
          }
          staleBySkill[skillName].push({
            skill: skillName,
            agent: directory.representativeAgent,
            path: skillPath
          });
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
 * @param homeDir - The home directory (for resolving ~ in agent paths)
 * @param skillNames - Specific skills to check, or empty array for all skills in all agent dirs
 * @param config - The current SyncSkillConfig
 * @returns ReconcileResult with removed paths, skipped paths, and errors
 */
export function reconcileStaleLinks(
  homeDir: string,
  skillNames: string[],
  config: SyncSkillConfig
): Promise<ReconcileResult> {
  return reconcileStaleLinksImpl(homeDir, skillNames, config);
}

async function reconcileStaleLinksImpl(
  homeDir: string,
  skillNames: string[],
  config: SyncSkillConfig
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    removed: [],
    skipped: [],
    errors: []
  };

  const { agentCanonicalPaths, directories } = await buildMaterializedAgentDirectoryIndex(config, homeDir);
  const validPairs = buildValidDirectoryPairs(config, agentCanonicalPaths);

  for (const directory of directories) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directory.scanPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillName = entry.name;

      if (skillNames.length > 0 && !skillNames.includes(skillName)) {
        continue;
      }

      const targetPath = join(directory.scanPath, skillName);

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

      if (!(await isManagedSkillLink(homeDir, skillName, targetPath))) {
        result.skipped.push(targetPath);
        continue;
      }

      const pairKey = `${skillName}:${directory.canonicalPath}`;
      if (validPairs.has(pairKey)) {
        continue;
      }

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
