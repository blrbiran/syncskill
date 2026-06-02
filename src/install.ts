import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSyncPaths, loadConfig, saveConfig } from './config/config.js';
import { ensureDefaultLinkTargets } from './core/private-agents.js';
import { linkConfiguredSkills } from './linker.js';
import { addSourceFromUrl, DiscoveredSkill } from './source.js';
import { pathExists } from './utils/utils.js';

/**
 * Get the path to the embedded syncskill skill in dist/skills/syncskill/
 */
export function getEmbeddedSkillPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);
  return join(distDir, 'skills', 'syncskill');
}

export interface InstallSyncskillSkillResult {
  alreadyInstalled: boolean;
  installedPath?: string;
  linkedAgents?: string[];
}

/**
 * Install the embedded syncskill skill to ~/.syncskill/skills/syncskill/
 */
export async function installSyncskillSkill(homeDir: string): Promise<InstallSyncskillSkillResult> {
  const { skillsDir } = getSyncPaths(homeDir);
  const targetPath = join(skillsDir, 'syncskill');

  if (await pathExists(targetPath)) {
    return { alreadyInstalled: true };
  }

  const sourcePath = getEmbeddedSkillPath();

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Embedded syncskill skill not found at: ${sourcePath}`);
  }

  await mkdir(skillsDir, { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true });

  const config = await loadConfig(homeDir);
  if (!config.links['syncskill']) {
    config.links['syncskill'] = await ensureDefaultLinkTargets(homeDir, config);
    await saveConfig(config, homeDir);
  }

  const linkResults = await linkConfiguredSkills(homeDir, { all: false, skillName: 'syncskill' });

  const linkedAgents = [...new Set(linkResults.map((result) => result.agent))].sort();

  return {
    alreadyInstalled: false,
    installedPath: targetPath,
    linkedAgents
  };
}

export interface InstallFromSourceOptions {
  name?: string;
  path?: string;
  skillSubdir?: string;
  branch?: string;
  skipPrompt?: boolean;
  onSelectSkills?: (skills: DiscoveredSkill[], existingSkills: Set<string>) => Promise<string[]>;
}

export interface InstallFromSourceResult {
  sourceName: string;
  installedSkills: string[];
  linkedAgents: string[];
}

/**
 * Install skills from a URL or local path (delegates to source add + link)
 */
export async function installFromSource(
  homeDir: string,
  urlOrPath: string,
  options: InstallFromSourceOptions = {}
): Promise<InstallFromSourceResult> {
  const result = await addSourceFromUrl(homeDir, urlOrPath, {
    name: options.name,
    path: options.path,
    skillSubdir: options.skillSubdir,
    branch: options.branch,
    skipPrompt: options.skipPrompt,
    onSelectSkills: options.onSelectSkills
  });

  const config = await loadConfig(homeDir);
  const linkedAgentSet = new Set<string>();

  const installedSkills: string[] = [];
  for (const [skillName, agents] of Object.entries(config.links)) {
    if (agents.length > 0) {
      const linkResults = await linkConfiguredSkills(homeDir, { all: false, skillName });
      installedSkills.push(skillName);
      for (const result of linkResults) {
        linkedAgentSet.add(result.agent);
      }
    }
  }

  return {
    sourceName: result.name,
    installedSkills,
    linkedAgents: [...linkedAgentSet].sort()
  };
}
