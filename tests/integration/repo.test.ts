import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { initializeRepo } from '../../src/repo.js';
import { useTempDirs } from '../helpers/temp-dir.js';

describe('initializeRepo', () => {
  const tempDirs = useTempDirs();

  it('creates the syncskill directory structure and config file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-repo-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });

    await initializeRepo(homeDir, { skipSources: true });

    await expect(readFile(join(homeDir, '.syncskill', 'config.yaml'), 'utf8')).resolves.toContain('version: 1');
    await expect(readFile(join(homeDir, '.syncskill', 'config.example.yaml'), 'utf8')).resolves.toContain(
      'conflict_resolution:'
    );
    await expect(readFile(join(homeDir, '.syncskill', 'skills'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(homeDir, '.syncskill', 'manifests'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(homeDir, '.syncskill', '.tmp'), 'utf8')).rejects.toThrow();

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        claude: join(homeDir, '.claude', 'skills')
      },
      links: {},
      servers: {},
      sources: {}
    });
  });

  it('migrates skills with claude taking precedence on name collisions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-repo-'));
    tempDirs.push(homeDir);

    const claudeSkillDir = join(homeDir, '.claude', 'skills', 'shared-skill');
    const agentsSkillDir = join(homeDir, '.agents', 'skills', 'shared-skill');
    const agentsOnlySkillDir = join(homeDir, '.agents', 'skills', 'agents-only');

    await mkdir(claudeSkillDir, { recursive: true });
    await mkdir(agentsSkillDir, { recursive: true });
    await mkdir(agentsOnlySkillDir, { recursive: true });
    await writeFile(join(claudeSkillDir, 'skill.txt'), 'from claude', 'utf8');
    await writeFile(join(agentsSkillDir, 'skill.txt'), 'from agents', 'utf8');
    await writeFile(join(agentsOnlySkillDir, 'skill.txt'), 'agents only', 'utf8');

    await initializeRepo(homeDir, { skipSources: false });

    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'shared-skill', 'skill.txt'), 'utf8')).resolves.toBe(
      'from claude'
    );
    await expect(readFile(join(homeDir, '.syncskill', 'skills', 'agents-only', 'skill.txt'), 'utf8')).resolves.toBe(
      'agents only'
    );

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        agents: join(homeDir, '.agents', 'skills')
      },
      links: {
        'shared-skill': ['*'],
        'agents-only': ['*']
      },
      servers: {},
      sources: {}
    });
  });

  it('refreshes stale configured agent paths with detected local agent directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-repo-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await writeFile(
      join(homeDir, '.syncskill', 'config.yaml'),
      [
        'version: 1',
        'conflict_resolution: manual',
        'agents:',
        '  claude: /stale/claude/skills',
        '  agents: /stale/agents/skills',
        'links: {}',
        'servers: {}',
        'sources: {}',
        ''
      ].join('\n'),
      'utf8'
    );

    await initializeRepo(homeDir, { skipSources: true });

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        agents: join(homeDir, '.agents', 'skills')
      },
      links: {},
      servers: {},
      sources: {}
    });
  });
});
