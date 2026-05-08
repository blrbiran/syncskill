import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { discoverSkills } from '../../src/linker.js';

describe('discoverSkills', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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
      sources: {}
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
      sources: {}
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
});
