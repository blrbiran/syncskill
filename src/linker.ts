import { mkdir, readdir } from 'node:fs/promises';

import { getSyncPaths, loadConfig, saveConfig } from './config.js';

export interface ScanOptions {
  allAgents: boolean;
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

export async function scanSkills(homeDir: string, { allAgents }: ScanOptions): Promise<string[]> {
  const config = await loadConfig(homeDir);
  const discoveredSkills = await listLocalSkills(homeDir);
  const addedSkills: string[] = [];

  for (const skill of discoveredSkills) {
    if (skill in config.links) {
      continue;
    }

    config.links[skill] = allAgents ? ['*'] : [];
    addedSkills.push(skill);
  }

  await saveConfig(config, homeDir);

  return addedSkills;
}
