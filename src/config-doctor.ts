import { access } from 'node:fs/promises';

export const DiagnosticCode = {
  NO_VALID_AGENTS: 'NO_VALID_AGENTS',
  AGENT_PATH_INVALID: 'AGENT_PATH_INVALID',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  SOURCE_PATH_INVALID: 'SOURCE_PATH_INVALID'
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
