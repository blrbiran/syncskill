import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { discoverSkills, findUnmanagedSkills } from '../../src/linker.js';

describe('discoverSkills', () => {
  const tempDirs = useTempDirs();

  it('adds missing discovered skills with empty targets by default', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        links: {
          existing: ['claude']
        }
      },
      homeDir
    );

    await mkdir(join(homeDir, '.syncskill', 'skills', 'zeta'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'existing'), { recursive: true });

    await expect(discoverSkills(homeDir, { allAgents: false })).resolves.toEqual(['alpha', 'zeta']);
    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {
        existing: ['claude'],
        alpha: [],
        zeta: []
      },
      servers: {},
      sources: {},
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
    });
  });

  it('adds wildcard targets when all-agents is used', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'beta'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'alpha'), { recursive: true });

    await expect(discoverSkills(homeDir, { allAgents: true })).resolves.toEqual(['alpha', 'beta']);
    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {
        alpha: ['*'],
        beta: ['*']
      },
      servers: {},
      sources: {},
      private_agents: ['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']
    });
  });

  it('migrates skills from agent directories when skills/ is empty', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    // Create agent directory with skills
    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(claudeSkillsDir, 'claude-skill'), { recursive: true });
    await writeFile(join(claudeSkillsDir, 'claude-skill', 'SKILL.md'), '# Claude Skill');

    const hermesSkillsDir = join(homeDir, '.hermes', 'skills');
    await mkdir(join(hermesSkillsDir, 'hermes-skill'), { recursive: true });
    await writeFile(join(hermesSkillsDir, 'hermes-skill', 'SKILL.md'), '# Hermes Skill');

    // Create empty syncskill directory (no skills)
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // Discover should trigger migration
    const discovered = await discoverSkills(homeDir, { allAgents: true });

    expect(discovered.sort()).toEqual(['claude-skill', 'hermes-skill']);

    // Skills should be copied to ~/.syncskill/skills/
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const entries = await readdir(skillsDir);
    expect(entries.sort()).toEqual(['claude-skill', 'hermes-skill']);
  });

  it('skips symlinks during migration', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    // Create agent directory with a real skill and a symlink
    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(claudeSkillsDir, 'real-skill'), { recursive: true });
    await writeFile(join(claudeSkillsDir, 'real-skill', 'SKILL.md'), '# Real Skill');

    // Create a symlink skill
    const targetDir = join(homeDir, 'external-skill');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# External Skill');
    await symlink(targetDir, join(claudeSkillsDir, 'linked-skill'));

    // Create empty syncskill directory
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const discovered = await discoverSkills(homeDir, { allAgents: true });

    // Only the real skill should be migrated (symlinks skipped)
    expect(discovered).toEqual(['real-skill']);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const entries = await readdir(skillsDir);
    expect(entries).toEqual(['real-skill']);
  });

  it('does not re-migrate when skills/ already has content', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    // Create agent directory with skill
    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(claudeSkillsDir, 'agent-skill'), { recursive: true });
    await writeFile(join(claudeSkillsDir, 'agent-skill', 'SKILL.md'), '# Agent Skill');

    // Create syncskill with existing skill
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(skillsDir, 'existing-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'existing-skill', 'SKILL.md'), '# Existing');

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const discovered = await discoverSkills(homeDir, { allAgents: true });

    // Should only discover existing skill, not migrate from agent dirs
    expect(discovered).toEqual(['existing-skill']);

    const entries = await readdir(skillsDir);
    expect(entries).toEqual(['existing-skill']);
  });

  it('dryRun option does not modify config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    const originalConfig = {
      ...createDefaultConfig(homeDir, {}),
      links: {
        existing: ['claude']
      }
    };
    await saveConfig(originalConfig, homeDir);

    await mkdir(join(homeDir, '.syncskill', 'skills', 'new-skill'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'existing'), { recursive: true });

    // Run with dryRun: true
    const discovered = await discoverSkills(homeDir, { allAgents: true, dryRun: true });

    // Should still return discovered skills
    expect(discovered).toEqual(['new-skill']);

    // Config should NOT be modified
    const configAfter = await loadConfig(homeDir);
    expect(configAfter.links).toEqual({ existing: ['claude'] });
    expect(configAfter.links['new-skill']).toBeUndefined();
  });

  it('dryRun option skips migration from agent directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-'));
    tempDirs.push(homeDir);

    // Create agent directory with skill
    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(claudeSkillsDir, 'agent-skill'), { recursive: true });
    await writeFile(join(claudeSkillsDir, 'agent-skill', 'SKILL.md'), '# Agent Skill');

    // Create empty syncskill directory
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    // Run with dryRun: true
    const discovered = await discoverSkills(homeDir, { allAgents: true, dryRun: true });

    // Should return empty since migration was skipped
    expect(discovered).toEqual([]);

    // Skills directory should still be empty
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const entries = await readdir(skillsDir);
    expect(entries).toEqual([]);
  });
});

describe('findUnmanagedSkills', () => {
  const tempDirs = useTempDirs();

  it('detects unmanaged skills in agent directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-unmanaged-'));
    tempDirs.push(homeDir);

    // Create agent directory with an unmanaged skill
    const agentSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(agentSkillsDir, 'unmanaged-skill'), { recursive: true });
    await writeFile(join(agentSkillsDir, 'unmanaged-skill', 'SKILL.md'), '# Unmanaged Skill');

    // Create syncskill directory with a managed skill
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(skillsDir, 'managed-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'managed-skill', 'SKILL.md'), '# Managed');

    // Configure the agent in config
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        agents: { claude: agentSkillsDir },
        links: { 'managed-skill': ['claude'] }
      },
      homeDir
    );

    const unmanaged = await findUnmanagedSkills(homeDir);

    expect(unmanaged.length).toBe(1);
    expect(unmanaged[0].name).toBe('unmanaged-skill');
    expect(unmanaged[0].path).toBe(join(agentSkillsDir, 'unmanaged-skill'));
    expect(unmanaged[0].agent).toBe('claude');
  });

  it('skips symlinks pointing to managed skills', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-unmanaged-'));
    tempDirs.push(homeDir);

    // Create syncskill directory with a managed skill
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(skillsDir, 'managed-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'managed-skill', 'SKILL.md'), '# Managed');

    // Create agent directory with a symlink to managed skill
    const agentSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentSkillsDir, { recursive: true });
    await symlink(join(skillsDir, 'managed-skill'), join(agentSkillsDir, 'managed-skill'));

    // Configure the agent in config
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        agents: { claude: agentSkillsDir },
        links: { 'managed-skill': ['claude'] }
      },
      homeDir
    );

    const unmanaged = await findUnmanagedSkills(homeDir);

    expect(unmanaged.length).toBe(0);
  });

  it('skips directories without SKILL.md', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-unmanaged-'));
    tempDirs.push(homeDir);

    // Create agent directory with a directory that is NOT a skill
    const agentSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(agentSkillsDir, 'not-a-skill'), { recursive: true });
    await writeFile(join(agentSkillsDir, 'not-a-skill', 'README.md'), '# Not a skill');

    // Create syncskill directory
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

    // Configure the agent in config
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        agents: { claude: agentSkillsDir },
        links: {}
      },
      homeDir
    );

    const unmanaged = await findUnmanagedSkills(homeDir);

    expect(unmanaged.length).toBe(0);
  });

  it('handles non-existent agent directories gracefully', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-unmanaged-'));
    tempDirs.push(homeDir);

    // Create syncskill directory
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

    // Configure an agent with a non-existent path
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        agents: { nonexistent: join(homeDir, 'does-not-exist') },
        links: {}
      },
      homeDir
    );

    const unmanaged = await findUnmanagedSkills(homeDir);

    expect(unmanaged.length).toBe(0);
  });
});

describe('scan CLI command', () => {
  const tempDirs = useTempDirs();

  it('scan without --migrate shows hint but does not migrate', async () => {
    const { vi } = await import('vitest');
    const { createProgram } = await import('../../src/index.js');

    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-cli-'));
    tempDirs.push(homeDir);

    // Create agent directory with an unmanaged skill
    const agentSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(agentSkillsDir, 'unmanaged-skill'), { recursive: true });
    await writeFile(join(agentSkillsDir, 'unmanaged-skill', 'SKILL.md'), '# Unmanaged Skill');

    // Create syncskill directory with an existing skill (non-empty to prevent auto-migration)
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(join(skillsDir, 'existing-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'existing-skill', 'SKILL.md'), '# Existing Skill');

    // Configure the agent in config with existing skill already linked
    await saveConfig(
      {
        ...createDefaultConfig(homeDir, {}),
        agents: { claude: agentSkillsDir },
        links: { 'existing-skill': ['claude'] }
      },
      homeDir
    );

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });

    // Should show hint to use --migrate
    const allOutput = consoleLog.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Use `syncskill scan --migrate` to migrate unmanaged skills.');

    // Unmanaged skill should NOT be migrated
    const entries = await readdir(skillsDir);
    expect(entries).toEqual(['existing-skill']);

    vi.restoreAllMocks();
  });
});
