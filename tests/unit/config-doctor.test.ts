import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type DiagnosticItem,
  type DiagnosticReport,
  DiagnosticCode,
  checkAgentPaths,
  checkSkillReferences,
  checkAgentReferences
} from '../../src/config-doctor.js';

describe('DiagnosticCode', () => {
  it('exports all expected diagnostic codes', () => {
    expect(DiagnosticCode.NO_VALID_AGENTS).toBe('NO_VALID_AGENTS');
    expect(DiagnosticCode.AGENT_PATH_INVALID).toBe('AGENT_PATH_INVALID');
    expect(DiagnosticCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
    expect(DiagnosticCode.AGENT_NOT_CONFIGURED).toBe('AGENT_NOT_CONFIGURED');
    expect(DiagnosticCode.SOURCE_PATH_INVALID).toBe('SOURCE_PATH_INVALID');
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
