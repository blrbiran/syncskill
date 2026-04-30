import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createDefaultConfig,
  detectAgents,
  getSyncPaths,
  loadConfig,
  saveConfig,
  type SyncSkillConfig
} from './config.js';

export interface InitializeRepoOptions {
  skipSources?: boolean;
}

export async function initializeRepo(homeDir: string, options: InitializeRepoOptions = {}): Promise<void> {
  const { syncDir, skillsDir, manifestsDir, tempDir, configFile } = getSyncPaths(homeDir);

  await Promise.all([
    mkdir(syncDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
    mkdir(manifestsDir, { recursive: true }),
    mkdir(tempDir, { recursive: true })
  ]);

  const detectedAgents = await detectAgents(homeDir);
  const config = (await exists(configFile)) ? await loadConfig(homeDir) : createDefaultConfig(homeDir, detectedAgents);

  await copyConfigExample(homeDir);

  if (!options.skipSources) {
    await migrateSkills(homeDir, config);
  }

  config.agents = {
    ...config.agents,
    ...detectedAgents
  };

  await saveConfig(config, homeDir);
}

async function copyConfigExample(homeDir: string): Promise<void> {
  const target = join(getSyncPaths(homeDir).syncDir, 'config.example.yaml');

  if (await exists(target)) {
    return;
  }

  const source = new URL('../config.example.yaml', import.meta.url);
  const content = await readFile(source, 'utf8');
  await writeFile(target, content, 'utf8');
}

async function migrateSkills(homeDir: string, config: SyncSkillConfig): Promise<void> {
  const { skillsDir } = getSyncPaths(homeDir);
  const sourceRoots = [join(homeDir, '.claude', 'skills'), join(homeDir, '.agents', 'skills')];

  for (const root of sourceRoots) {
    const skillDirs = await listSkillDirectories(root);

    for (const skill of skillDirs) {
      const source = join(root, skill);
      const target = join(skillsDir, skill);

      if (await exists(target)) {
        continue;
      }

      await cp(source, target, { recursive: true });

      if (!config.links[skill]) {
        config.links[skill] = ['*'];
      }
    }
  }
}

async function listSkillDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
