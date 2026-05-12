import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@inquirer/prompts';

import {
  createDefaultConfig,
  detectAgents,
  getSyncPaths,
  KNOWN_AGENT_DIRS,
  loadConfig,
  saveConfig,
  type SyncSkillConfig
} from './config/config.js';
import { installSyncskillSkill } from './install.js';

export interface InitializeRepoOptions {
  skipSources?: boolean;
  skipSkill?: boolean;
  yes?: boolean;
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

  // Prompt to install syncskill skill
  if (!options.skipSkill) {
    const { skillsDir } = getSyncPaths(homeDir);
    const syncskillPath = join(skillsDir, 'syncskill');

    const alreadyExists = await exists(syncskillPath);

    if (!alreadyExists) {
      let shouldInstall = options.yes ?? false;

      // Skip interactive prompt if not a TTY (e.g., in tests or CI)
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;

      if (!options.yes && isTTY) {
        shouldInstall = await confirm({
          message: 'Would you like to install the syncskill skill?\nThis skill helps AI agents manage skills using syncskill commands.',
          default: true
        });
      }

      if (shouldInstall) {
        const result = await installSyncskillSkill(homeDir);
        if (!result.alreadyInstalled) {
          console.log('✓ Installed syncskill skill');
          if (result.linkedAgents && result.linkedAgents.length > 0) {
            console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
          }
        }
      } else {
        console.log('You can install later with: syncskill install');
      }
    }
  }

  const serverCount = Object.keys(config.servers).length;
  if (serverCount >= 3) {
    console.log(`\nDetected ${serverCount} servers. Auto-refresh may be slow.`);
    console.log('Use --no-refresh to skip refresh, then run "syncskill refresh" manually as needed.');
  }
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
  const sourceRoots = Object.values(KNOWN_AGENT_DIRS).map((dir) => join(homeDir, dir));

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
