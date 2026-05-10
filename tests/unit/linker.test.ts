import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig } from '../../src/config.js';
import { ensureLinkedDirectory, formatLinkStatusMatrix, linkConfiguredSkills, unlinkSkill } from '../../src/linker.js';
import type { LinkStatus } from '../../src/linker.js';

describe('linker', () => {
  const tempDirs = useTempDirs();

  it('creates links for configured skill in target agent directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, '.syncskill', 'skills', 'demo-skill');
    const agentDir = join(homeDir, '.claude', 'skills');
    const targetDir = join(agentDir, 'demo-skill');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'skill.md'), '# demo', 'utf8');
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { 'demo-skill': ['claude'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    const statuses = await linkConfiguredSkills(homeDir, { all: false, skillName: 'demo-skill' });

    await expect(readlink(targetDir)).resolves.toBe(sourceDir);
    expect(statuses).toEqual([{ skill: 'demo-skill', agent: 'claude', state: 'linked' }]);
  });

  it('rejects before modifying the target when the source skill directory is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const skillName = 'missing-skill';
    const agentDir = join(homeDir, '.claude', 'skills');
    const targetDir = join(agentDir, skillName);
    const existingFile = join(targetDir, 'skill.md');

    await mkdir(targetDir, { recursive: true });
    await writeFile(existingFile, '# existing target', 'utf8');
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { [skillName]: ['claude'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    await expect(linkConfiguredSkills(homeDir, { all: false, skillName })).rejects.toThrow(
      /Skill source directory not found/
    );
    await expect(readFile(existingFile, 'utf8')).resolves.toBe('# existing target');
  });

  it('removes linked directories with unlinkSkill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, '.syncskill', 'skills', 'demo-skill');
    const agentDir = join(homeDir, '.claude', 'skills');
    const targetDir = join(agentDir, 'demo-skill');

    await mkdir(sourceDir, { recursive: true });
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { 'demo-skill': ['claude'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    await ensureLinkedDirectory(sourceDir, targetDir);
    await unlinkSkill(homeDir, 'demo-skill');

    await expect(access(targetDir)).rejects.toThrow();
  });

  it('falls back to copy when symlink creation fails twice', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, '.syncskill', 'skills', 'demo-skill');
    const targetDir = join(homeDir, '.claude', 'skills', 'demo-skill');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'skill.md'), '# copied', 'utf8');

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      return {
        ...actual,
        symlink: vi
          .fn<typeof actual.symlink>()
          .mockRejectedValueOnce(new Error('symlink failed'))
          .mockRejectedValueOnce(new Error('junction failed'))
      };
    });

    const { ensureLinkedDirectory: mockedEnsureLinkedDirectory } = await import('../../src/linker.js');

    const state = await mockedEnsureLinkedDirectory(sourceDir, targetDir);

    expect(state).toBe('copied');
    await expect(readlink(targetDir)).rejects.toThrow();
    await expect(readFile(join(targetDir, 'skill.md'), 'utf8')).resolves.toBe('# copied');

    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });
});

describe('formatLinkStatusMatrix', () => {
  it('formats empty status list', () => {
    const result = formatLinkStatusMatrix([], false);
    expect(result).toBe('No skills configured.');
  });

  it('formats single skill with symbols', () => {
    const statuses: LinkStatus[] = [
      { skill: 'my-skill', agent: 'claude', state: 'linked' },
    ];
    const result = formatLinkStatusMatrix(statuses, false);

    expect(result).toContain('Link Status');
    expect(result).toContain('my-skill');
    expect(result).toContain('claude');
    expect(result).toContain('✓');
    expect(result).toContain('Legend:');
  });

  it('formats multiple skills and agents with symbols', () => {
    const statuses: LinkStatus[] = [
      { skill: 'skill-a', agent: 'claude', state: 'linked' },
      { skill: 'skill-a', agent: 'hermes', state: 'missing' },
      { skill: 'skill-b', agent: 'claude', state: 'copied' },
      { skill: 'skill-b', agent: 'hermes', state: 'broken' },
    ];
    const result = formatLinkStatusMatrix(statuses, false);

    expect(result).toContain('✓'); // linked
    expect(result).toContain('·'); // missing
    expect(result).toContain('⚠'); // copied
    expect(result).toContain('✗'); // broken
  });

  it('formats verbose output with text', () => {
    const statuses: LinkStatus[] = [
      { skill: 'my-skill', agent: 'claude', state: 'linked' },
      { skill: 'my-skill', agent: 'hermes', state: 'copied' },
    ];
    const result = formatLinkStatusMatrix(statuses, true);

    expect(result).toContain('linked');
    expect(result).toContain('copied');
    expect(result).not.toContain('Legend:'); // No legend in verbose mode
  });

  it('sorts skills and agents alphabetically', () => {
    const statuses: LinkStatus[] = [
      { skill: 'zebra', agent: 'claude', state: 'linked' },
      { skill: 'alpha', agent: 'hermes', state: 'linked' },
      { skill: 'alpha', agent: 'claude', state: 'linked' },
    ];
    const result = formatLinkStatusMatrix(statuses, false);
    const lines = result.split('\n');

    // Find the data rows (after header)
    const dataRows = lines.filter(l => l.startsWith('alpha') || l.startsWith('zebra'));
    expect(dataRows[0]).toMatch(/^alpha/);
    expect(dataRows[1]).toMatch(/^zebra/);
  });
});
