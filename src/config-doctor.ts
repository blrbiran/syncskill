import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SyncSkillConfig } from './config.js';
import { loadSkillsRegistry, saveSkillsRegistry, getSkillsRegistryPath, type SkillsRegistry } from './skills-registry.js';

export const DiagnosticCode = {
  NO_VALID_AGENTS: 'NO_VALID_AGENTS',
  AGENT_PATH_INVALID: 'AGENT_PATH_INVALID',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  SOURCE_PATH_INVALID: 'SOURCE_PATH_INVALID',
  REGISTRY_MISSING: 'REGISTRY_MISSING',
  REGISTRY_CORRUPT: 'REGISTRY_CORRUPT',
  REGISTRY_STALE: 'REGISTRY_STALE',
  REGISTRY_ORPHAN: 'REGISTRY_ORPHAN'
} as const;

export type DiagnosticCodeType = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export interface DiagnosticItem {
  code: DiagnosticCodeType;
  severity: 'error' | 'warning';
  message: string;
  path: string;
  suggestion?: string;
}

export interface DiagnosticReport {
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  isHealthy: boolean;
  canProceed: boolean;
}

export interface RepairOptions {
  removeInvalidSkillLinks: boolean;
  removeInvalidAgentLinks: boolean;
  removeInvalidAgents: boolean;
  removeInvalidSources: boolean;
  removeStaleRegistryEntries: boolean;
  addOrphanRegistryEntries: boolean;
}

export async function checkAgentPaths(
  agents: Record<string, string>
): Promise<DiagnosticItem[]> {
  const entries = Object.entries(agents);
  if (entries.length === 0) {
    return [];
  }

  const results = await Promise.all(
    entries.map(async ([name, path]) => {
      try {
        await access(path);
        return { name, path, valid: true };
      } catch {
        return { name, path, valid: false };
      }
    })
  );

  const validCount = results.filter((r) => r.valid).length;
  const invalidResults = results.filter((r) => !r.valid);

  if (validCount === 0 && entries.length > 0) {
    return [
      {
        code: DiagnosticCode.NO_VALID_AGENTS,
        severity: 'error',
        message: 'All agent paths are invalid. At least one is required.',
        path: 'agents'
      }
    ];
  }

  return invalidResults.map((r) => ({
    code: DiagnosticCode.AGENT_PATH_INVALID,
    severity: 'warning' as const,
    message: `Path does not exist: ${r.path}`,
    path: `agents.${r.name}`,
    suggestion: `Remove "${r.name}" from agents`
  }));
}

export function checkSkillReferences(
  links: Record<string, string[]>,
  existingSkills: Set<string>
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  for (const [skill, targets] of Object.entries(links)) {
    if (targets.length === 0) {
      continue;
    }

    if (!existingSkills.has(skill)) {
      items.push({
        code: DiagnosticCode.SKILL_NOT_FOUND,
        severity: 'warning',
        message: `Skill "${skill}" not found in ~/.syncskill/skills/ or sources`,
        path: `links.${skill}`,
        suggestion: `Remove "${skill}" from links`
      });
    }
  }

  return items;
}

export function checkAgentReferences(
  links: Record<string, string[]>,
  configuredAgents: Set<string>
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  for (const [skill, targets] of Object.entries(links)) {
    const missingAgents = targets.filter(
      (agent) => agent !== '*' && !configuredAgents.has(agent)
    );

    for (const agent of missingAgents) {
      items.push({
        code: DiagnosticCode.AGENT_NOT_CONFIGURED,
        severity: 'warning',
        message: `Agent "${agent}" not configured in agents`,
        path: `links.${skill}`,
        suggestion: `Remove "${agent}" from links.${skill} targets`
      });
    }
  }

  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function checkSourcePaths(
  sources: Record<string, unknown>
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];

  for (const [name, sourceDef] of Object.entries(sources)) {
    if (!isRecord(sourceDef)) continue;
    if (sourceDef.type !== 'local') continue;
    if (typeof sourceDef.path !== 'string') continue;

    try {
      await access(sourceDef.path);
    } catch {
      items.push({
        code: DiagnosticCode.SOURCE_PATH_INVALID,
        severity: 'warning',
        message: `Path does not exist: ${sourceDef.path}`,
        path: `sources.${name}`,
        suggestion: `Remove "${name}" from sources`
      });
    }
  }

  return items;
}

/**
 * Discover existing skills by scanning skillsDir and sources.
 * Only directories containing SKILL.md are considered valid skills.
 */
async function discoverExistingSkills(
  skillsDir: string,
  sources: Record<string, unknown>
): Promise<Set<string>> {
  const skills = new Set<string>();

  // Check manual skills dir
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          await access(join(skillsDir, entry.name, 'SKILL.md'));
          skills.add(entry.name);
        } catch {
          // No SKILL.md - not a valid skill
        }
      }
    }
  } catch {
    // skillsDir may not exist
  }

  // Check sources
  for (const sourceRaw of Object.values(sources)) {
    if (!isRecord(sourceRaw)) continue;
    const sourcePath = sourceRaw.path as string | undefined;
    if (!sourcePath) continue;

    try {
      const entries = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            await access(join(sourcePath, entry.name, 'SKILL.md'));
            skills.add(entry.name);
          } catch {
            // No SKILL.md - not a valid skill
          }
        }
      }
    } catch {
      // Source path may not exist
    }
  }

  return skills;
}

export async function checkRegistryHealth(
  homeDir: string,
  config: SyncSkillConfig,
  skillsDir: string
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];
  const registryPath = getSkillsRegistryPath(homeDir);

  // 1. Check if registry file exists
  try {
    await access(registryPath);
  } catch {
    items.push({
      code: DiagnosticCode.REGISTRY_MISSING,
      severity: 'warning',
      message: 'skills-registry.json does not exist',
      path: 'skills-registry.json',
      suggestion: 'Run `syncskill doctor --rebuild-registry` to create'
    });
    return items;
  }

  // 2. Try to load and parse
  let registry;
  try {
    registry = await loadSkillsRegistry(homeDir);
  } catch {
    items.push({
      code: DiagnosticCode.REGISTRY_CORRUPT,
      severity: 'warning',
      message: 'skills-registry.json is corrupt or invalid',
      path: 'skills-registry.json',
      suggestion: 'Run `syncskill doctor --rebuild-registry` to rebuild'
    });
    return items;
  }

  // 3. Check for stale entries (path doesn't exist)
  for (const [skillName, entry] of Object.entries(registry.skills)) {
    try {
      await access(entry.path);
    } catch {
      items.push({
        code: DiagnosticCode.REGISTRY_STALE,
        severity: 'warning',
        message: `Skill path does not exist: ${entry.path}`,
        path: `registry.${skillName}`,
        suggestion: `Remove stale entry for "${skillName}"`
      });
    }
  }

  // 4. Check for orphans (skills exist but not in registry)
  const existingSkills = await discoverExistingSkills(skillsDir, config.sources);
  for (const skillName of existingSkills) {
    if (!registry.skills[skillName]) {
      items.push({
        code: DiagnosticCode.REGISTRY_ORPHAN,
        severity: 'warning',
        message: `Skill "${skillName}" exists but is not in registry`,
        path: `registry.${skillName}`,
        suggestion: 'Run `syncskill doctor --rebuild-registry` to add'
      });
    }
  }

  return items;
}

export async function diagnoseConfig(
  config: SyncSkillConfig,
  skillsDir: string,
  homeDir?: string
): Promise<DiagnosticReport> {
  const errors: DiagnosticItem[] = [];
  const warnings: DiagnosticItem[] = [];

  const agentItems = await checkAgentPaths(config.agents);
  for (const item of agentItems) {
    if (item.severity === 'error') {
      errors.push(item);
    } else {
      warnings.push(item);
    }
  }

  const existingSkills = await discoverExistingSkills(skillsDir, config.sources);
  const skillItems = checkSkillReferences(config.links, existingSkills);
  warnings.push(...skillItems);

  const configuredAgents = new Set(Object.keys(config.agents));
  const agentRefItems = checkAgentReferences(config.links, configuredAgents);
  warnings.push(...agentRefItems);

  const sourceItems = await checkSourcePaths(config.sources);
  warnings.push(...sourceItems);

  // Add registry checks if homeDir is provided
  if (homeDir) {
    const registryItems = await checkRegistryHealth(homeDir, config, skillsDir);
    warnings.push(...registryItems);
  }

  return {
    errors,
    warnings,
    isHealthy: errors.length === 0 && warnings.length === 0,
    canProceed: errors.length === 0
  };
}

export function repairConfig(
  config: SyncSkillConfig,
  report: DiagnosticReport,
  options: RepairOptions
): SyncSkillConfig {
  const result = structuredClone(config);

  const allItems = [...report.errors, ...report.warnings];

  for (const item of allItems) {
    if (item.code === DiagnosticCode.SKILL_NOT_FOUND && options.removeInvalidSkillLinks) {
      const skillName = item.path.replace('links.', '');
      delete result.links[skillName];
    }

    if (item.code === DiagnosticCode.AGENT_NOT_CONFIGURED && options.removeInvalidAgentLinks) {
      const skillName = item.path.replace('links.', '');
      const agentMatch = item.message.match(/Agent "([^"]+)"/);
      if (agentMatch && result.links[skillName]) {
        result.links[skillName] = result.links[skillName].filter(
          (a) => a !== agentMatch[1]
        );
      }
    }

    if (item.code === DiagnosticCode.AGENT_PATH_INVALID && options.removeInvalidAgents) {
      const agentName = item.path.replace('agents.', '');
      delete result.agents[agentName];
    }

    if (item.code === DiagnosticCode.SOURCE_PATH_INVALID && options.removeInvalidSources) {
      const sourceName = item.path.replace('sources.', '');
      delete result.sources[sourceName];
    }
  }

  return result;
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  if (report.isHealthy) {
    return '✓ No issues found. Config is healthy.';
  }

  const lines: string[] = [];
  lines.push('Config Diagnosis');
  lines.push('─'.repeat(40));
  lines.push('');

  for (const error of report.errors) {
    lines.push(`✗ Error: ${error.path}`);
    lines.push(`  ${error.message}`);
    lines.push('');
  }

  for (const warning of report.warnings) {
    lines.push(`⚠ Warning: ${warning.path}`);
    lines.push(`  ${warning.message}`);
    lines.push('');
  }

  lines.push('─'.repeat(40));

  const parts: string[] = [];
  if (report.errors.length > 0) {
    parts.push(`${report.errors.length} error${report.errors.length > 1 ? 's' : ''}`);
  }
  if (report.warnings.length > 0) {
    parts.push(`${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''}`);
  }
  lines.push(parts.join(', '));

  if (!report.canProceed) {
    lines.push('');
    lines.push('Run `syncskill doctor --fix` to repair.');
  }

  return lines.join('\n');
}

export function formatDiagnosticSummary(report: DiagnosticReport): string {
  const total = report.errors.length + report.warnings.length;
  return `⚠ Config has ${total} issue${total > 1 ? 's' : ''} (run \`syncskill doctor\` to fix)`;
}

export interface RepairRegistryOptions {
  removeStaleEntries: boolean;
  addOrphanEntries: boolean;
}

export async function repairRegistry(
  homeDir: string,
  skillsDir: string,
  report: DiagnosticReport,
  options: RepairRegistryOptions
): Promise<{ repaired: string[] }> {
  const registry = await loadSkillsRegistry(homeDir);
  const repaired: string[] = [];

  const allItems = [...report.errors, ...report.warnings];

  for (const item of allItems) {
    if (item.code === DiagnosticCode.REGISTRY_STALE && options.removeStaleEntries) {
      const skillName = item.path.replace('registry.', '');
      delete registry.skills[skillName];
      repaired.push(item.path);
    }

    if (item.code === DiagnosticCode.REGISTRY_ORPHAN && options.addOrphanEntries) {
      const skillName = item.path.replace('registry.', '');
      const skillPath = join(skillsDir, skillName);
      registry.skills[skillName] = {
        path: skillPath,
        origin: 'manual',
        type: 'manual',
        status: 'active'
      };
      repaired.push(item.path);
    }
  }

  if (repaired.length > 0) {
    await saveSkillsRegistry(homeDir, registry);
  }

  return { repaired };
}

export function isRegistryDiagnostic(code: DiagnosticCodeType): boolean {
  return code === DiagnosticCode.REGISTRY_STALE ||
         code === DiagnosticCode.REGISTRY_ORPHAN ||
         code === DiagnosticCode.REGISTRY_MISSING ||
         code === DiagnosticCode.REGISTRY_CORRUPT;
}

/**
 * Auto-check config health before running commands.
 * - If healthy: silent, continue
 * - If warnings only: print one-line summary to stderr, continue
 * - If errors (canProceed=false): print summary + "Run doctor --fix", exit 1
 *
 * Returns false if config could not be loaded (caller should skip auto-check).
 */
export async function autoDiagnoseConfig(
  config: SyncSkillConfig | null,
  skillsDir: string
): Promise<void> {
  if (!config) {
    // Config not available - skip auto-check
    return;
  }

  const report = await diagnoseConfig(config, skillsDir);

  if (report.isHealthy) {
    return;
  }

  console.error(formatDiagnosticSummary(report));

  if (!report.canProceed) {
    console.error('Run `syncskill doctor --fix` to repair.');
    process.exit(1);
  }
}
