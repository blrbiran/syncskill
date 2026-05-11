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
