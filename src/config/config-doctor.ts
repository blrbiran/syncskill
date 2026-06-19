import { access, copyFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SyncSkillConfig } from './config.js';
import { rebuildRegistryV2 } from '../core/registry-builder.js';
import {
  getSkillsRegistryPath,
  loadSkillsRegistryV2,
  saveSkillsRegistryV2,
} from '../core/skills-registry.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collectManagedLocalSkillNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function collectSourceSkillNames(root: string): Promise<string[]> {
  const skills: string[] = [];

  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        await access(join(root, entry.name, 'SKILL.md'));
        skills.push(entry.name);
      } catch {
        // Ignore non-skill directories.
      }
    }
  } catch {
    // Ignore missing or unreadable directories.
  }

  return skills;
}

async function discoverExpectedHttpSkills(sources: Record<string, unknown>): Promise<Set<string>> {
  const skills = new Set<string>();

  for (const sourceRaw of Object.values(sources)) {
    if (!isRecord(sourceRaw) || sourceRaw.type !== 'http' || typeof sourceRaw.path !== 'string') {
      continue;
    }

    for (const skillName of await collectSourceSkillNames(sourceRaw.path)) {
      skills.add(skillName);
    }
  }

  return skills;
}

async function discoverExistingSkills(
  skillsDir: string,
  sources: Record<string, unknown>
): Promise<Set<string>> {
  const skills = new Set<string>(await collectManagedLocalSkillNames(skillsDir));

  for (const sourceRaw of Object.values(sources)) {
    if (!isRecord(sourceRaw) || typeof sourceRaw.path !== 'string') {
      continue;
    }

    for (const skillName of await collectSourceSkillNames(sourceRaw.path)) {
      skills.add(skillName);
    }
  }

  return skills;
}

async function registryExists(homeDir: string): Promise<boolean> {
  try {
    await access(getSkillsRegistryPath(homeDir));
    return true;
  } catch {
    return false;
  }
}

function getRegistryBackupPath(homeDir: string): string {
  return `${getSkillsRegistryPath(homeDir)}.bak`;
}

async function loadValidatedRegistryV2(homeDir: string): Promise<void> {
  const content = await readFile(getSkillsRegistryPath(homeDir), 'utf8');
  const parsed = JSON.parse(content) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Registry must be an object');
  }

  if (parsed.version === 1) {
    return;
  }

  if (parsed.version !== 2) {
    throw new Error('Registry version is invalid');
  }

  if ('ignored' in parsed) {
    throw new Error('Registry must not contain ignored entries');
  }

  if (!isRecord(parsed.http_baselines)) {
    throw new Error('Registry http_baselines is invalid');
  }
}

async function checkRegistryBaselineCoverage(
  homeDir: string,
  config: SyncSkillConfig
): Promise<DiagnosticItem[]> {
  const expectedSkills = await discoverExpectedHttpSkills(config.sources);
  const registry = await loadSkillsRegistryV2(homeDir);
  const actualSkills = new Set(Object.keys(registry.http_baselines));

  const missing = [...expectedSkills].filter((skill) => !actualSkills.has(skill));
  const stale = [...actualSkills].filter((skill) => !expectedSkills.has(skill));

  if (missing.length === 0 && stale.length === 0) {
    return [];
  }

  return [{
    code: DiagnosticCode.REGISTRY_CORRUPT,
    severity: 'warning',
    message: 'skills-registry.json http baselines are out of sync with configured HTTP sources',
    path: 'skills-registry.json',
    suggestion: 'Run `syncskill link build` to regenerate skills-registry.json'
  }];
}

async function checkRegistryIntegrity(
  homeDir: string,
  config: SyncSkillConfig
): Promise<DiagnosticItem[]> {
  if (!(await registryExists(homeDir))) {
    return [];
  }

  try {
    await loadValidatedRegistryV2(homeDir);
  } catch {
    return [{
      code: DiagnosticCode.REGISTRY_CORRUPT,
      severity: 'warning',
      message: 'skills-registry.json is corrupt or invalid',
      path: 'skills-registry.json',
      suggestion: 'Run `syncskill link build` to regenerate skills-registry.json'
    }];
  }

  return checkRegistryBaselineCoverage(homeDir, config);
}

export const DiagnosticCode = {
  NO_VALID_AGENTS: 'NO_VALID_AGENTS',
  AGENT_PATH_INVALID: 'AGENT_PATH_INVALID',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  SOURCE_PATH_INVALID: 'SOURCE_PATH_INVALID',
  REGISTRY_CORRUPT: 'REGISTRY_CORRUPT'
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
}

export interface RepairRegistryOptions {
  rebuildRegistry: boolean;
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

  const validCount = results.filter((result) => result.valid).length;
  const invalidResults = results.filter((result) => !result.valid);

  if (validCount === 0) {
    return [{
      code: DiagnosticCode.NO_VALID_AGENTS,
      severity: 'error',
      message: 'All agent paths are invalid. At least one is required.',
      path: 'agents'
    }];
  }

  return invalidResults.map((result) => ({
    code: DiagnosticCode.AGENT_PATH_INVALID,
    severity: 'warning' as const,
    message: `Path does not exist: ${result.path}`,
    path: `agents.${result.name}`,
    suggestion: `Remove "${result.name}" from agents`
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

export async function checkRegistryHealth(
  homeDir: string,
  config: SyncSkillConfig,
  _skillsDir: string
): Promise<DiagnosticItem[]> {
  return checkRegistryIntegrity(homeDir, config);
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
  warnings.push(...checkSkillReferences(config.links, existingSkills));
  warnings.push(...checkAgentReferences(config.links, new Set(Object.keys(config.agents))));
  warnings.push(...await checkSourcePaths(config.sources));

  if (homeDir) {
    warnings.push(...await checkRegistryHealth(homeDir, config, skillsDir));
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
        result.links[skillName] = result.links[skillName].filter((agent) => agent !== agentMatch[1]);
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

export async function repairRegistry(
  homeDir: string,
  config: SyncSkillConfig,
  report: DiagnosticReport,
  options: RepairRegistryOptions
): Promise<{ repaired: string[] }> {
  if (!options.rebuildRegistry) {
    return { repaired: [] };
  }

  const hasCorruptRegistry = [...report.errors, ...report.warnings].some(
    (item) => item.code === DiagnosticCode.REGISTRY_CORRUPT
  );

  if (!hasCorruptRegistry) {
    return { repaired: [] };
  }

  const registryPath = getSkillsRegistryPath(homeDir);
  if (await registryExists(homeDir)) {
    await copyFile(registryPath, getRegistryBackupPath(homeDir));
  }

  const registry = await rebuildRegistryV2(homeDir, config);
  await saveSkillsRegistryV2(homeDir, registry);
  return { repaired: ['skills-registry.json'] };
}

export function isRegistryDiagnostic(code: DiagnosticCodeType): boolean {
  return code === DiagnosticCode.REGISTRY_CORRUPT;
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

export async function autoDiagnoseConfig(
  config: SyncSkillConfig | null,
  skillsDir: string
): Promise<void> {
  if (!config) {
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
