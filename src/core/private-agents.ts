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

const ENSURE_SHARED_DIR_TIMEOUT_MS = 2000;

/**
 * Side-effect function: ensure ~/.agents/skills/ directory exists.
 * Creates it if missing and prints a message.
 * Returns null if the operation times out (2 seconds).
 */
export async function ensureSharedSkillsDirectory(
  homeDir: string
): Promise<EnsureSharedDirResult | null> {
  const sharedDir = join(homeDir, '.agents', 'skills');

  try {
    const existsResult = await Promise.race([
      pathExists(sharedDir),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), ENSURE_SHARED_DIR_TIMEOUT_MS)
      )
    ]);

    if (existsResult === 'timeout') {
      console.warn('Warning: Checking ~/.agents/skills/ timed out after 2s');
      return null;
    }

    if (existsResult === true) {
      return { created: false, path: sharedDir };
    }

    const mkdirResult = await Promise.race([
      mkdir(sharedDir, { recursive: true }).then(() => 'done' as const),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), ENSURE_SHARED_DIR_TIMEOUT_MS)
      )
    ]);

    if (mkdirResult === 'timeout') {
      console.warn('Warning: Creating ~/.agents/skills/ timed out after 2s');
      return null;
    }

    console.log('Created ~/.agents/skills/');
    console.log('  This is the standard shared skills directory for agents that support it.');
    console.log('  Skills linked here are available to: claude, windsurf, codex, ...');

    return { created: true, path: sharedDir };
  } catch {
    console.warn('Warning: Failed to ensure ~/.agents/skills/ directory');
    return null;
  }
}
