import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { checkAgentReferences } from '../../src/config/config-doctor.js';
import { computeDefaultLinkTargets, ensureSharedSkillsDirectory } from '../../src/core/private-agents.js';

describe('computeDefaultLinkTargets', () => {
  const tempDirs = useTempDirs();

  it('returns only agents when the shared directory exists and no private agents are detected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true });

    const result = await computeDefaultLinkTargets(homeDir, {
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        cursor: join(homeDir, '.cursor', 'skills')
      }
    });

    expect(result).toEqual({
      targets: ['agents']
    });
  });

  it('includes detected private agents when their directories exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const cursorDir = join(homeDir, '.cursor', 'skills');
    await mkdir(cursorDir, { recursive: true });

    const result = await computeDefaultLinkTargets(homeDir, {
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        cursor: '~/.cursor/skills',
        kiro: '~/.kiro/skills'
      },
      private_agents: ['cursor', 'kiro']
    });

    expect(result).toEqual({
      targets: ['cursor']
    });
  });

  it('previews an explicit opt-in without creating a shared directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);
    expect((await computeDefaultLinkTargets(homeDir, { agents: {} })).targets).toEqual([]);
    expect((await computeDefaultLinkTargets(homeDir, { agents: {} }, true)).targets).toEqual(['agents']);
    await expect(access(join(homeDir, '.agents', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // #462: whatever install writes as default targets, doctor must not report as AGENT_NOT_CONFIGURED.
  it('returns only targets that doctor accepts, even when agents is not registered', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });

    await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true });
    const agents = { claude: '~/.claude/skills' };
    const { targets } = await computeDefaultLinkTargets(homeDir, { agents, private_agents: ['claude'] });

    expect(targets).toEqual(['agents', 'claude']);
    expect(checkAgentReferences({ 'skill-a': targets }, new Set(Object.keys(agents)))).toEqual([]);
  });
});

describe('ensureSharedSkillsDirectory', () => {
  const tempDirs = useTempDirs();

  it('creates the shared agents directory when it does not exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const sharedDir = join(homeDir, '.agents', 'skills');

    const result = await ensureSharedSkillsDirectory(homeDir);

    expect(result).toEqual({
      created: true,
      path: sharedDir
    });
    await expect(access(sharedDir)).resolves.toBeUndefined();
  });

  it('returns created=false when directory already exists', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const sharedDir = join(homeDir, '.agents', 'skills');
    await mkdir(sharedDir, { recursive: true });

    const result = await ensureSharedSkillsDirectory(homeDir);

    expect(result).toEqual({
      created: false,
      path: sharedDir
    });
  });
});
