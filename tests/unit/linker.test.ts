import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { saveConfig, type SyncSkillConfig } from '../../src/config/config.js';
import { collectLinkStatus, ensureLinkedDirectory, formatLinkStatusMatrix, linkConfiguredSkills, reconcileStaleLinks, unlinkSkill, unlinkSkillFromAgent } from '../../src/linker.js';
import type { LinkStatus } from '../../src/linker.js';
import { materializeSource } from '../../src/source.js';

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

  it('links local-source-owned skills directly from the source directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceRoot = join(homeDir, 'shared');
    const agentDir = join(homeDir, '.claude', 'skills');
    const targetDir = join(agentDir, 'alpha');

    await mkdir(join(sourceRoot, 'alpha'), { recursive: true });
    await writeFile(join(sourceRoot, 'alpha', 'SKILL.md'), '# alpha', 'utf8');
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { alpha: ['claude'] },
        servers: {},
        sources: {
          shared: { type: 'local', url: sourceRoot, path: '.' }
        }
      },
      homeDir
    );

    await materializeSource(homeDir, 'shared', { type: 'local', url: sourceRoot, path: '.' });

    const statuses = await linkConfiguredSkills(homeDir, { all: false, skillName: 'alpha' });

    await expect(readlink(targetDir)).resolves.toBe(join(sourceRoot, 'alpha'));
    expect(statuses).toEqual([{ skill: 'alpha', agent: 'claude', state: 'linked' }]);
  });

  it('refuses to replace an existing real directory when linking', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, '.syncskill', 'skills', 'demo-skill');
    const targetDir = join(homeDir, '.claude', 'skills', 'demo-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'skill.md'), '# existing', 'utf8');

    await expect(ensureLinkedDirectory(sourceDir, targetDir)).rejects.toThrow(
      /Refusing to replace existing non-symlink target/
    );
    await expect(readFile(join(targetDir, 'skill.md'), 'utf8')).resolves.toBe('# existing');
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

  it('removes only the specified agent link with unlinkSkillFromAgent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const sourceDir = join(homeDir, '.syncskill', 'skills', 'demo-skill');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const cursorDir = join(homeDir, '.cursor', 'skills');
    const claudeTarget = join(claudeDir, 'demo-skill');
    const cursorTarget = join(cursorDir, 'demo-skill');

    await mkdir(sourceDir, { recursive: true });
    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: claudeDir, cursor: cursorDir },
        links: { 'demo-skill': ['claude', 'cursor'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    await ensureLinkedDirectory(sourceDir, claudeTarget);
    await ensureLinkedDirectory(sourceDir, cursorTarget);

    await unlinkSkillFromAgent(homeDir, 'demo-skill', 'cursor');

    await expect(access(cursorTarget)).rejects.toThrow();
    await expect(readlink(claudeTarget)).resolves.toBe(sourceDir);
  });

  it('detects broken symlinks in collectLinkStatus', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const skillDir = join(skillsDir, 'broken-skill');
    const agentDir = join(homeDir, '.claude', 'skills');
    const targetDir = join(agentDir, 'broken-skill');
    const nonExistentSource = join(homeDir, '.syncskill', 'skills', 'deleted-skill');

    await mkdir(skillDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(nonExistentSource, targetDir);

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: agentDir },
        links: { 'broken-skill': ['claude'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    const statuses = await collectLinkStatus(homeDir);

    expect(statuses).toEqual([{ skill: 'broken-skill', agent: 'claude', state: 'broken' }]);
  });

  it('distinguishes unconfigured cells from configured-but-missing cells', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const managedSkillDir = join(homeDir, '.syncskill', 'skills', 'managed-skill');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const codexDir = join(homeDir, '.codex', 'skills');

    await mkdir(managedSkillDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: claudeDir, codex: codexDir },
        links: { 'managed-skill': ['claude'] },
        servers: {},
        sources: {}
      },
      homeDir
    );

    const statuses = await collectLinkStatus(homeDir);

    expect(statuses).toEqual([
      { skill: 'managed-skill', agent: 'claude', state: 'missing' },
      { skill: 'managed-skill', agent: 'codex', state: 'unconfigured' }
    ]);
  });

  it('includes unmanaged local skill rows in link status output', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-linker-'));
    tempDirs.push(homeDir);

    const orphanSkillDir = join(homeDir, '.syncskill', 'skills', 'orphan-skill');
    const claudeDir = join(homeDir, '.claude', 'skills');

    await mkdir(orphanSkillDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });

    await saveConfig(
      {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: claudeDir },
        links: {},
        servers: {},
        sources: {}
      },
      homeDir
    );

    const statuses = await collectLinkStatus(homeDir);

    expect(statuses).toEqual([
      { skill: 'orphan-skill', agent: 'claude', state: 'unconfigured' }
    ]);
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
  it('marks private agents in headers and legend', () => {
    const statuses: LinkStatus[] = [
      { skill: 'my-skill', agent: 'claude', state: 'linked' },
      { skill: 'my-skill', agent: 'cursor', state: 'linked' },
    ];

    const result = formatLinkStatusMatrix(statuses, false, ['cursor']);

    expect(result).toContain('claude');
    expect(result).toContain('cursor');
    expect(result).toContain('private agent');
  });

  it('formats empty status list', () => {
    const result = formatLinkStatusMatrix([], false, []);
    expect(result).toBe('No managed local skills or configured agents.');
  });

  it('formats single skill with symbols', () => {
    const statuses: LinkStatus[] = [
      { skill: 'my-skill', agent: 'claude', state: 'linked' },
    ];
    const result = formatLinkStatusMatrix(statuses, false, []);

    expect(result).toContain('Realized Link Status');
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
      { skill: 'skill-b', agent: 'cursor', state: 'unconfigured' },
    ];
    const result = formatLinkStatusMatrix(statuses, false, []);

    expect(result).toContain('✓'); // linked
    expect(result).toContain('·'); // missing
    expect(result).toContain('⚠'); // copied
    expect(result).toContain('✗'); // broken
    expect(result).toContain('-'); // unconfigured
  });

  it('formats verbose output with text and private agent legend', () => {
    const statuses: LinkStatus[] = [
      { skill: 'my-skill', agent: 'claude', state: 'linked' },
      { skill: 'my-skill', agent: 'hermes', state: 'copied' },
    ];
    const result = formatLinkStatusMatrix(statuses, true, ['hermes']);

    expect(result).toContain('linked');
    expect(result).toContain('copied');
    expect(result).toContain('hermes');
    expect(result).toContain('private agent');
  });

  it('sorts skills and agents alphabetically', () => {
    const statuses: LinkStatus[] = [
      { skill: 'zebra', agent: 'claude', state: 'linked' },
      { skill: 'alpha', agent: 'hermes', state: 'linked' },
      { skill: 'alpha', agent: 'claude', state: 'linked' },
    ];
    const result = formatLinkStatusMatrix(statuses, false, []);
    const lines = result.split('\n');

    // Find the data rows (after header)
    const dataRows = lines.filter(l => l.startsWith('alpha') || l.startsWith('zebra'));
    expect(dataRows[0]).toMatch(/^alpha/);
    expect(dataRows[1]).toMatch(/^zebra/);
  });
});

describe('reconcileStaleLinks', () => {
  const tempDirs = useTempDirs();

  it('returns empty result when no stale links exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir = join(skillsDir, 'my-skill');
    const targetDir = join(agentDir, 'my-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir, targetDir);

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'my-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Verify symlink still exists
    await expect(readlink(targetDir)).resolves.toBe(sourceDir);
  });

  it('identifies and removes stale symlinks', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir = join(skillsDir, 'removed-skill');
    const targetDir = join(agentDir, 'removed-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir, targetDir);

    // Config no longer has 'removed-skill'
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([targetDir]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Verify symlink was removed
    await expect(access(targetDir)).rejects.toThrow();
  });

  it('skips real directories (non-symlinks)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const agentDir = join(homeDir, '.claude', 'skills');
    const realDir = join(agentDir, 'real-dir');

    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'SKILL.md'), '# real skill', 'utf8');

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([realDir]);
    expect(result.errors).toEqual([]);
    // Verify real directory still exists
    await expect(access(realDir)).resolves.toBeUndefined();
  });

  it('skips symlinks not pointing to syncskill-managed paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const agentDir = join(homeDir, '.claude', 'skills');
    const externalSource = join(homeDir, 'external', 'my-skill');
    const targetDir = join(agentDir, 'my-skill');

    await mkdir(externalSource, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(externalSource, targetDir);

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([targetDir]);
    expect(result.errors).toEqual([]);
    // Verify symlink still exists
    await expect(readlink(targetDir)).resolves.toBe(externalSource);
  });

  it('skips symlinks that are still valid per config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir = join(skillsDir, 'valid-skill');
    const targetDir = join(agentDir, 'valid-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir, targetDir);

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'valid-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Verify symlink still exists
    await expect(readlink(targetDir)).resolves.toBe(sourceDir);
  });

  it('detects skill in config.links but agent removed from targets', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const sourceDir = join(skillsDir, 'my-skill');
    const claudeTarget = join(claudeDir, 'my-skill');
    const hermesTarget = join(hermesDir, 'my-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });
    await symlink(sourceDir, claudeTarget);
    await symlink(sourceDir, hermesTarget);

    // Config has skill but only for claude, not hermes
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: claudeDir, hermes: hermesDir },
      links: { 'my-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toEqual([hermesTarget]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Verify claude link still exists
    await expect(readlink(claudeTarget)).resolves.toBe(sourceDir);
    // Verify hermes link was removed
    await expect(access(hermesTarget)).rejects.toThrow();
  });

  it('detects skill completely removed from config.links', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const sourceDir = join(skillsDir, 'deleted-skill');
    const claudeTarget = join(claudeDir, 'deleted-skill');
    const hermesTarget = join(hermesDir, 'deleted-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });
    await symlink(sourceDir, claudeTarget);
    await symlink(sourceDir, hermesTarget);

    // Config has no links at all
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: claudeDir, hermes: hermesDir },
      links: {},
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toContain(claudeTarget);
    expect(result.removed).toContain(hermesTarget);
    expect(result.removed.length).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports errors when symlink removal fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir = join(skillsDir, 'error-skill');
    const targetDir = join(agentDir, 'error-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir, targetDir);

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        rm: vi.fn<typeof actual.rm>().mockRejectedValue(new Error('Permission denied'))
      };
    });

    const { reconcileStaleLinks: mockedReconcileStaleLinks } = await import('../../src/linker.js');

    const result = await mockedReconcileStaleLinks(homeDir, [], config);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Failed to remove');
    expect(result.errors[0]).toContain('Permission denied');

    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('continues processing other links after error', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir1 = join(skillsDir, 'skill-a');
    const sourceDir2 = join(skillsDir, 'skill-b');
    const targetDir1 = join(agentDir, 'skill-a');
    const targetDir2 = join(agentDir, 'skill-b');

    await mkdir(sourceDir1, { recursive: true });
    await mkdir(sourceDir2, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir1, targetDir1);
    await symlink(sourceDir2, targetDir2);

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let callCount = 0;
      return {
        ...actual,
        rm: vi.fn<typeof actual.rm>().mockImplementation(async (path, options) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('First removal failed');
          }
          return actual.rm(path, options);
        })
      };
    });

    const { reconcileStaleLinks: mockedReconcileStaleLinks } = await import('../../src/linker.js');

    const result = await mockedReconcileStaleLinks(homeDir, [], config);

    // One error and one success
    expect(result.errors.length).toBe(1);
    expect(result.removed.length).toBe(1);

    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('single skill mode only checks specified skillNames', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir1 = join(skillsDir, 'skill-a');
    const sourceDir2 = join(skillsDir, 'skill-b');
    const targetDir1 = join(agentDir, 'skill-a');
    const targetDir2 = join(agentDir, 'skill-b');

    await mkdir(sourceDir1, { recursive: true });
    await mkdir(sourceDir2, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir1, targetDir1);
    await symlink(sourceDir2, targetDir2);

    // Both skills are stale (not in config)
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    // Only reconcile skill-a
    const result = await reconcileStaleLinks(homeDir, ['skill-a'], config);

    expect(result.removed).toEqual([targetDir1]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // skill-b should still exist
    await expect(readlink(targetDir2)).resolves.toBe(sourceDir2);
  });

  it('all skills mode checks all skills in agent directories (empty skillNames array)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const agentDir = join(homeDir, '.claude', 'skills');
    const sourceDir1 = join(skillsDir, 'skill-a');
    const sourceDir2 = join(skillsDir, 'skill-b');
    const targetDir1 = join(agentDir, 'skill-a');
    const targetDir2 = join(agentDir, 'skill-b');

    await mkdir(sourceDir1, { recursive: true });
    await mkdir(sourceDir2, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(sourceDir1, targetDir1);
    await symlink(sourceDir2, targetDir2);

    // Both skills are stale (not in config)
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };

    // Empty array means all skills mode
    const result = await reconcileStaleLinks(homeDir, [], config);

    expect(result.removed).toContain(targetDir1);
    expect(result.removed).toContain(targetDir2);
    expect(result.removed.length).toBe(2);
  });

  it('handles wildcard target expansion correctly', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-reconcile-'));
    tempDirs.push(homeDir);

    const skillsDir = join(homeDir, '.syncskill', 'skills');
    const claudeDir = join(homeDir, '.claude', 'skills');
    const hermesDir = join(homeDir, '.hermes', 'skills');
    const sourceDir = join(skillsDir, 'wildcard-skill');
    const claudeTarget = join(claudeDir, 'wildcard-skill');
    const hermesTarget = join(hermesDir, 'wildcard-skill');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(hermesDir, { recursive: true });
    await symlink(sourceDir, claudeTarget);
    await symlink(sourceDir, hermesTarget);

    // Config uses wildcard '*' which should expand to all agents
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: claudeDir, hermes: hermesDir },
      links: { 'wildcard-skill': ['*'] },
      servers: {},
      sources: {}
    };

    const result = await reconcileStaleLinks(homeDir, [], config);

    // Both links should be valid (wildcard expands to all agents)
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Verify both symlinks still exist
    await expect(readlink(claudeTarget)).resolves.toBe(sourceDir);
    await expect(readlink(hermesTarget)).resolves.toBe(sourceDir);
  });
});
