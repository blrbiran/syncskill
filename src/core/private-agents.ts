import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../utils/utils.js';

export interface ComputeLinkTargetsConfig {
  agents: Record<string, string>;
  private_agents?: string[];
}

export interface ComputeLinkTargetsResult {
  targets: string[];
}

/**
 * Pure function: compute default link targets based on config.
 * Returns ["agents"] + detected private agents whose directories exist.
 */
export async function computeDefaultLinkTargets(
  homeDir: string,
  config: ComputeLinkTargetsConfig
): Promise<ComputeLinkTargetsResult> {
  const targets: string[] = ['agents'];
  const privateAgents = config.private_agents ?? [];

  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    if (!privateAgents.includes(agentName)) {
      continue;
    }

    const resolvedPath = agentPath.replace(/^~/, homeDir);
    if (await pathExists(resolvedPath)) {
      targets.push(agentName);
    }
  }

  return { targets };
}

export interface EnsureSharedDirResult {
  created: boolean;
  path: string;
}

/**
 * Side-effect function: ensure ~/.agents/skills/ directory exists.
 * Creates it if missing and prints a message.
 */
export async function ensureSharedSkillsDirectory(
  homeDir: string
): Promise<EnsureSharedDirResult> {
  const sharedDir = join(homeDir, '.agents', 'skills');

  if (await pathExists(sharedDir)) {
    return { created: false, path: sharedDir };
  }

  await mkdir(sharedDir, { recursive: true });
  console.log('Created ~/.agents/skills/');
  console.log('  This is the standard shared skills directory for agents that support it.');
  console.log('  Skills linked here are available to: claude, windsurf, codex, ...');

  return { created: true, path: sharedDir };
}
