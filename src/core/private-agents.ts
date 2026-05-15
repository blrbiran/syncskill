import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../utils/utils.js';

export interface ComputeLinkTargetsConfig {
  agents: Record<string, string>;
  private_agents?: string[];
}

export interface ComputeLinkTargetsOptions {
  createSharedDir?: boolean;
}

export interface ComputeLinkTargetsResult {
  targets: string[];
  created: boolean;
}

export async function computeDefaultLinkTargets(
  homeDir: string,
  config: ComputeLinkTargetsConfig,
  options: ComputeLinkTargetsOptions = {}
): Promise<ComputeLinkTargetsResult> {
  const targets: string[] = ['agents'];
  const privateAgents = config.private_agents ?? [];
  let created = false;

  const sharedDir = join(homeDir, '.agents', 'skills');
  if (!(await pathExists(sharedDir)) && options.createSharedDir) {
    await mkdir(sharedDir, { recursive: true });
    created = true;
    console.log('Created ~/.agents/skills/');
    console.log('  This is the standard shared skills directory for agents that support it.');
    console.log('  Skills linked here are available to: claude, windsurf, codex, ...');
  }

  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    if (!privateAgents.includes(agentName)) {
      continue;
    }

    const resolvedPath = agentPath.replace(/^~/, homeDir);
    if (await pathExists(resolvedPath)) {
      targets.push(agentName);
    }
  }

  return { targets, created };
}
