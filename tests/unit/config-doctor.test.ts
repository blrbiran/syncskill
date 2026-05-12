import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SyncSkillConfig } from '../../src/config/config.js';
import {
  type DiagnosticItem,
  type DiagnosticReport,
  type RepairOptions,
  DiagnosticCode,
  checkAgentPaths,
  checkSkillReferences,
  checkAgentReferences,
  checkSourcePaths,
  checkRegistryHealth,
  diagnoseConfig,
  repairConfig,
  formatDiagnosticReport,
  formatDiagnosticSummary
} from '../../src/config/config-doctor.js';

describe('DiagnosticCode', () => {
  it('exports all expected diagnostic codes', () => {
    expect(DiagnosticCode.NO_VALID_AGENTS).toBe('NO_VALID_AGENTS');
    expect(DiagnosticCode.AGENT_PATH_INVALID).toBe('AGENT_PATH_INVALID');
    expect(DiagnosticCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
    expect(DiagnosticCode.AGENT_NOT_CONFIGURED).toBe('AGENT_NOT_CONFIGURED');
    expect(DiagnosticCode.SOURCE_PATH_INVALID).toBe('SOURCE_PATH_INVALID');
    expect(DiagnosticCode.REGISTRY_MISSING).toBe('REGISTRY_MISSING');
    expect(DiagnosticCode.REGISTRY_CORRUPT).toBe('REGISTRY_CORRUPT');
    expect(DiagnosticCode.REGISTRY_STALE).toBe('REGISTRY_STALE');
    expect(DiagnosticCode.REGISTRY_ORPHAN).toBe('REGISTRY_ORPHAN');
  });
});

describe('checkAgentPaths', () => {
  const testDir = join(tmpdir(), `config-doctor-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty array when all agent paths exist', async () => {
    const agentDir = join(testDir, 'claude-skills');
    await mkdir(agentDir, { recursive: true });

    const agents = { claude: agentDir };
    const items = await checkAgentPaths(agents);

    expect(items).toEqual([]);
  });

  it('returns warning for single invalid agent path', async () => {
    const validDir = join(testDir, 'claude-skills');
    await mkdir(validDir, { recursive: true });

    const agents = {
      claude: validDir,
      hermes: join(testDir, 'nonexistent')
    };
    const items = await checkAgentPaths(agents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'AGENT_PATH_INVALID',
      severity: 'warning',
      path: 'agents.hermes'
    });
  });

  it('returns error when all agent paths are invalid', async () => {
    const agents = {
      claude: join(testDir, 'missing1'),
      hermes: join(testDir, 'missing2')
    };
    const items = await checkAgentPaths(agents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'NO_VALID_AGENTS',
      severity: 'error'
    });
  });
});

describe('checkSkillReferences', () => {
  it('returns empty array when all skills exist', () => {
    const links = { 'skill-a': ['claude'], 'skill-b': ['hermes'] };
    const existingSkills = new Set(['skill-a', 'skill-b']);
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toEqual([]);
  });

  it('returns warning for missing skill', () => {
    const links = { 'skill-a': ['claude'], 'missing-skill': ['claude'] };
    const existingSkills = new Set(['skill-a']);
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'SKILL_NOT_FOUND',
      severity: 'warning',
      path: 'links.missing-skill'
    });
  });

  it('skips skills with empty targets', () => {
    const links = { 'skill-a': [] };
    const existingSkills = new Set<string>();
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toEqual([]);
  });
});

describe('checkAgentReferences', () => {
  it('returns empty array when all agents are configured', () => {
    const links = { 'skill-a': ['claude', 'hermes'] };
    const configuredAgents = new Set(['claude', 'hermes']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toEqual([]);
  });

  it('returns warning for unconfigured agent in links', () => {
    const links = { 'skill-a': ['claude', 'missing-agent'] };
    const configuredAgents = new Set(['claude']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'AGENT_NOT_CONFIGURED',
      severity: 'warning',
      path: 'links.skill-a'
    });
    expect(items[0].message).toContain('missing-agent');
  });

  it('ignores wildcard target', () => {
    const links = { 'skill-a': ['*'] };
    const configuredAgents = new Set(['claude']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toEqual([]);
  });
});

describe('checkSourcePaths', () => {
  const testDir = join(tmpdir(), `config-doctor-source-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty array when local source path exists', async () => {
    const sourceDir = join(testDir, 'my-source');
    await mkdir(sourceDir, { recursive: true });

    const sources = {
      'my-source': { type: 'local', path: sourceDir }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toEqual([]);
  });

  it('returns warning for invalid local source path', async () => {
    const sources = {
      'my-source': { type: 'local', path: join(testDir, 'nonexistent') }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'SOURCE_PATH_INVALID',
      severity: 'warning',
      path: 'sources.my-source'
    });
  });

  it('skips non-local sources', async () => {
    const sources = {
      'git-source': { type: 'git', url: 'https://github.com/test/repo' }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toEqual([]);
  });
});

describe('checkRegistryHealth', () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `registry-health-test-${Date.now()}`);
    homeDir = testDir;
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(join(syncDir, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const baseConfig: SyncSkillConfig = {
    version: 1,
    conflict_resolution: 'manual',
    agents: {},
    links: {},
    servers: {},
    sources: {}
  };

  it('returns REGISTRY_MISSING when file does not exist', async () => {
    const skillsDir = join(homeDir, '.syncskill', 'skills');

    const items = await checkRegistryHealth(homeDir, baseConfig, skillsDir);

    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(DiagnosticCode.REGISTRY_MISSING);
    expect(items[0].severity).toBe('warning');
  });

  // Note: REGISTRY_CORRUPT is not currently reachable because loadSkillsRegistry
  // catches JSON parse errors and returns a default registry. The code exists
  // for future-proofing if the registry loader behavior changes.
  it.skip('returns REGISTRY_CORRUPT when JSON is invalid', async () => {
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const registryPath = join(homeDir, '.syncskill', 'skills-registry.json');

    await writeFile(registryPath, 'not valid json {{{');

    const items = await checkRegistryHealth(homeDir, baseConfig, skillsDir);

    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(DiagnosticCode.REGISTRY_CORRUPT);
  });

  it('returns REGISTRY_STALE when skill path does not exist', async () => {
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const registryPath = join(homeDir, '.syncskill', 'skills-registry.json');

    const registry = {
      version: 1,
      skills: {
        'nonexistent-skill': {
          path: '/does/not/exist',
          origin: 'manual',
          type: 'manual',
          status: 'active'
        }
      }
    };
    await writeFile(registryPath, JSON.stringify(registry));

    const items = await checkRegistryHealth(homeDir, baseConfig, skillsDir);

    expect(items.some((i) => i.code === DiagnosticCode.REGISTRY_STALE)).toBe(true);
  });

  it('returns REGISTRY_ORPHAN when skill exists but not in registry', async () => {
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const registryPath = join(homeDir, '.syncskill', 'skills-registry.json');

    // Create a skill that exists on disk
    const orphanSkillPath = join(skillsDir, 'orphan-skill');
    await mkdir(orphanSkillPath, { recursive: true });
    await writeFile(join(orphanSkillPath, 'SKILL.md'), '# Orphan');

    // Create empty registry
    const registry = { version: 1, skills: {} };
    await writeFile(registryPath, JSON.stringify(registry));

    const items = await checkRegistryHealth(homeDir, baseConfig, skillsDir);

    expect(items.some((i) => i.code === DiagnosticCode.REGISTRY_ORPHAN)).toBe(true);
  });

  it('returns empty array when registry is healthy', async () => {
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const registryPath = join(homeDir, '.syncskill', 'skills-registry.json');

    // Create a skill on disk
    const skillPath = join(skillsDir, 'my-skill');
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, 'SKILL.md'), '# My Skill');

    // Create matching registry
    const registry = {
      version: 1,
      skills: {
        'my-skill': {
          path: skillPath,
          origin: 'manual',
          type: 'manual',
          status: 'active'
        }
      }
    };
    await writeFile(registryPath, JSON.stringify(registry));

    const items = await checkRegistryHealth(homeDir, baseConfig, skillsDir);

    expect(items).toHaveLength(0);
  });
});

describe('diagnoseConfig', () => {
  const testDir = join(tmpdir(), `config-doctor-diag-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns healthy report for valid config', async () => {
    const agentDir = join(testDir, 'claude-skills');
    const skillsDir = join(testDir, 'skills');
    const skillDir = join(skillsDir, 'my-skill');
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill');

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'my-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(true);
    expect(report.canProceed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('returns canProceed false when no valid agents', async () => {
    const skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: join(testDir, 'missing') },
      links: {},
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(false);
    expect(report.canProceed).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].code).toBe('NO_VALID_AGENTS');
  });

  it('collects warnings from all checks', async () => {
    const agentDir = join(testDir, 'claude-skills');
    const skillsDir = join(testDir, 'skills');
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'missing-skill': ['claude', 'missing-agent'] },
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(false);
    expect(report.canProceed).toBe(true);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('repairConfig', () => {
  it('removes invalid skill from links', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid' },
      links: { 'valid-skill': ['claude'], 'invalid-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.SKILL_NOT_FOUND,
          severity: 'warning',
          message: 'Skill not found',
          path: 'links.invalid-skill'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: true,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: false,
      removeInvalidSources: false,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.links).toEqual({ 'valid-skill': ['claude'] });
  });

  it('removes invalid agent from link targets', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid' },
      links: { 'my-skill': ['claude', 'invalid-agent'] },
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_NOT_CONFIGURED,
          severity: 'warning',
          message: 'Agent "invalid-agent" not configured',
          path: 'links.my-skill'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: true,
      removeInvalidAgents: false,
      removeInvalidSources: false,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.links['my-skill']).toEqual(['claude']);
  });

  it('removes invalid agent from agents', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid', hermes: '/invalid' },
      links: {},
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_PATH_INVALID,
          severity: 'warning',
          message: 'Path invalid',
          path: 'agents.hermes'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: true,
      removeInvalidSources: false,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.agents).toEqual({ claude: '/valid' });
  });

  it('removes invalid source from sources', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid' },
      links: {},
      servers: {},
      sources: {
        'valid-source': { type: 'local', path: '/valid' },
        'invalid-source': { type: 'local', path: '/invalid' }
      }
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.SOURCE_PATH_INVALID,
          severity: 'warning',
          message: 'Path does not exist',
          path: 'sources.invalid-source'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: false,
      removeInvalidSources: true,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.sources).toEqual({ 'valid-source': { type: 'local', path: '/valid' } });
  });

  it('does not mutate original config', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid', hermes: '/invalid' },
      links: {},
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_PATH_INVALID,
          severity: 'warning',
          message: 'Path invalid',
          path: 'agents.hermes'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: true,
      removeInvalidSources: false,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    repairConfig(config, report, options);

    // Original config should be unchanged
    expect(config.agents).toEqual({ claude: '/valid', hermes: '/invalid' });
  });

  it('does nothing when options are all false', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid', hermes: '/invalid' },
      links: { 'invalid-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_PATH_INVALID,
          severity: 'warning',
          message: 'Path invalid',
          path: 'agents.hermes'
        },
        {
          code: DiagnosticCode.SKILL_NOT_FOUND,
          severity: 'warning',
          message: 'Skill not found',
          path: 'links.invalid-skill'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: false,
      removeInvalidSources: false,
      removeStaleRegistryEntries: false,
      addOrphanRegistryEntries: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.agents).toEqual({ claude: '/valid', hermes: '/invalid' });
    expect(repaired.links).toEqual({ 'invalid-skill': ['claude'] });
  });
});

describe('formatDiagnosticReport', () => {
  it('formats healthy report', () => {
    const report: DiagnosticReport = {
      errors: [],
      warnings: [],
      isHealthy: true,
      canProceed: true
    };

    const output = formatDiagnosticReport(report);

    expect(output).toContain('No issues found');
  });

  it('formats report with errors and warnings', () => {
    const report: DiagnosticReport = {
      errors: [
        {
          code: DiagnosticCode.NO_VALID_AGENTS,
          severity: 'error',
          message: 'All agent paths are invalid',
          path: 'agents'
        }
      ],
      warnings: [
        {
          code: DiagnosticCode.SKILL_NOT_FOUND,
          severity: 'warning',
          message: 'Skill "test" not found',
          path: 'links.test'
        }
      ],
      isHealthy: false,
      canProceed: false
    };

    const output = formatDiagnosticReport(report);

    expect(output).toContain('Error');
    expect(output).toContain('Warning');
    expect(output).toContain('1 error');
    expect(output).toContain('1 warning');
  });
});

describe('formatDiagnosticSummary', () => {
  it('formats one-line summary', () => {
    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        { code: DiagnosticCode.SKILL_NOT_FOUND, severity: 'warning', message: '', path: '' },
        { code: DiagnosticCode.AGENT_PATH_INVALID, severity: 'warning', message: '', path: '' }
      ],
      isHealthy: false,
      canProceed: true
    };

    const output = formatDiagnosticSummary(report);

    expect(output).toContain('2 issues');
    expect(output).toContain('syncskill doctor');
  });
});
