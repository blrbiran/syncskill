import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

// Re-export types from types.ts
export type { SyncPaths, ConflictResolution, SyncSkillConfig, ConfiguredServer, SourceConfig } from './types.js';
import type { SyncPaths, ConflictResolution, SyncSkillConfig, ConfiguredServer } from './types.js';

export const KNOWN_AGENT_DIRS = {
  claude: '.claude/skills',
  agents: '.agents/skills',
  cursor: '.cursor/skills',
  windsurf: '.windsurf/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  antigravity: '.gemini/antigravity/skills',
  kiro: '.kiro/skills',
  augment: '.augment/skills',
  amp: '.config/agents/skills',
  cline: '.cline/skills',
  opencode: '.config/opencode/skills',
  qwen: '.qwen/skills',
  openclaw: '.openclaw/skills',
  hermes: '.hermes/skills',
  qoder: '.qoder/skills',
  aone_copilot: '.aone_copilot/skills'
} as const;

export function getSyncDir(homeDir = homedir()): string {
  return join(homeDir, '.syncskill');
}

export function getSyncPaths(homeDir = homedir()): SyncPaths {
  const syncDir = getSyncDir(homeDir);

  return {
    syncDir,
    configFile: join(syncDir, 'config.yaml'),
    skillsDir: join(syncDir, 'skills'),
    manifestsDir: join(syncDir, 'manifests'),
    tempDir: join(syncDir, '.tmp'),
    historyFile: join(syncDir, 'manifest_history.json'),
    backupsDir: join(syncDir, 'backups')
  };
}

export async function detectAgents(homeDir = homedir()): Promise<Record<string, string>> {
  const detected = await Promise.all(
    Object.entries(KNOWN_AGENT_DIRS).map(async ([agent, relativePath]) => {
      const fullPath = join(homeDir, relativePath);

      try {
        await access(fullPath);
        return [agent, fullPath] as const;
      } catch {
        return null;
      }
    })
  );

  return Object.fromEntries(detected.filter((entry): entry is readonly [string, string] => entry !== null));
}

export function createDefaultConfig(homeDir = homedir(), agents: Record<string, string> = {}): SyncSkillConfig {
  void homeDir;

  return {
    version: 1,
    conflict_resolution: 'manual',
    agents,
    links: {},
    servers: {},
    sources: {}
  };
}

export function validateConfig(value: unknown): SyncSkillConfig {
  if (!isRecord(value)) {
    throw new Error('Config must be an object');
  }

  if (!('version' in value)) {
    throw new Error('Config is missing required key: version');
  }

  if (!('agents' in value)) {
    throw new Error('Config is missing required key: agents');
  }

  if (!('links' in value) || value.links === undefined) {
    throw new Error('Config is missing required key: links');
  }

  return {
    version: value.version as number,
    conflict_resolution: isConflictResolution(value.conflict_resolution)
      ? value.conflict_resolution
      : 'manual',
    agents: normalizeAgents(value.agents),
    links: normalizeLinks(value.links),
    servers: isRecord(value.servers) ? value.servers : {},
    sources: isRecord(value.sources) ? value.sources : {}
  };
}

export async function loadConfig(homeDir = homedir()): Promise<SyncSkillConfig> {
  const { configFile } = getSyncPaths(homeDir);
  const raw = await readFile(configFile, 'utf8');

  return validateConfig(YAML.parse(raw));
}

export async function saveConfig(config: SyncSkillConfig, homeDir = homedir()): Promise<void> {
  const { syncDir, configFile } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  await writeFile(configFile, YAML.stringify(config), 'utf8');
}

export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return '';
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function setConfigValue(
  config: SyncSkillConfig,
  dottedPath: string,
  value: unknown
): SyncSkillConfig {
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  const segments = dottedPath.split('.');
  let cursor: Record<string, unknown> = next;

  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];

    if (!isRecord(current)) {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments.at(-1) as string] = value;

  return validateConfig(next);
}

export function expandTargetAgents(config: SyncSkillConfig, targets: string[]): string[] {
  if (targets.includes('*')) {
    return Object.keys(config.agents).sort();
  }

  return [...new Set(targets)].sort();
}

export function getConfiguredServer(config: SyncSkillConfig, name: string): ConfiguredServer {
  const raw = config.servers[name];

  if (raw === undefined) {
    throw new Error(`Server not found: ${name}`);
  }

  if (!isRecord(raw) || typeof raw.host !== 'string') {
    throw new Error(`Server config is invalid: ${name}`);
  }

  return {
    name,
    host: raw.host,
    ...(typeof raw.user === 'string' ? { user: raw.user } : {}),
    ...(typeof raw.port === 'number' ? { port: raw.port } : {}),
    ...(typeof raw.identity_file === 'string' ? { identity_file: raw.identity_file } : {}),
    remote_agents: isRecord(raw.remote_agents)
      ? Object.fromEntries(
          Object.entries(raw.remote_agents).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConflictResolution(value: unknown): value is ConflictResolution {
  return value === 'manual' || value === 'keep-local' || value === 'keep-remote';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeAgents(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const agents: Record<string, string> = {};

  for (const [key, path] of Object.entries(value)) {
    if (typeof path === 'string') {
      agents[key] = path;
    }
  }

  return agents;
}

function normalizeLinks(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, targets]) => [key, normalizeStringArray(targets)])
  );
}

export function getConfigPaths(config: SyncSkillConfig): Array<{ path: string; value: unknown }> {
  const paths: Array<{ path: string; value: unknown }> = [];

  function walk(obj: unknown, currentPath: string): void {
    if (obj === null || typeof obj !== 'object') {
      paths.push({ path: currentPath, value: obj });
      return;
    }

    if (Array.isArray(obj)) {
      paths.push({ path: currentPath, value: obj });
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      walk(value, nextPath);
    }
  }

  walk(config, '');
  return paths.filter(p => p.path !== '');
}
