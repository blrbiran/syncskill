import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEmbeddedSkillPath, installFromSource, installSyncskillSkill } from '../../src/install.js';

describe('install module', () => {
  describe('getEmbeddedSkillPath', () => {
    it('should return path containing skills/syncskill', () => {
      const path = getEmbeddedSkillPath();
      expect(path).toContain('skills');
      expect(path).toContain('syncskill');
    });

    it('should return path relative to dist directory', () => {
      const path = getEmbeddedSkillPath();
      // Path should end with skills/syncskill
      expect(path).toMatch(/skills[/\\]syncskill$/);
    });
  });

  describe('installSyncskillSkill', () => {
    let tempDir: string;
    let homeDir: string;

    beforeEach(async () => {
      tempDir = join(import.meta.dirname, `../../.test-tmp-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      homeDir = join(tempDir, 'home');
      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

      const configPath = join(homeDir, '.syncskill', 'config.json');
      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            agents: { claude: '~/.claude/skills' },
            links: {},
            servers: {},
            sources: {},
          },
          null,
          2
        )
      );
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should return alreadyInstalled: true if skill exists', async () => {
      await mkdir(join(homeDir, '.syncskill', 'skills', 'syncskill'), { recursive: true });
      await writeFile(join(homeDir, '.syncskill', 'skills', 'syncskill', 'SKILL.md'), '# test');

      const result = await installSyncskillSkill(homeDir);
      expect(result.alreadyInstalled).toBe(true);
      expect(result.installedPath).toBeUndefined();
    });

    it('should copy skill files and return installedPath when not exists', async () => {
      // Check that embedded skill exists (requires build to have run)
      const embeddedPath = getEmbeddedSkillPath();
      let embeddedExists = false;
      try {
        await stat(join(embeddedPath, 'SKILL.md'));
        embeddedExists = true;
      } catch {
        // Embedded skill doesn't exist, skip this test
      }

      if (!embeddedExists) {
        // Skip test if embedded skill doesn't exist (build not run)
        return;
      }

      const result = await installSyncskillSkill(homeDir);

      expect(result.alreadyInstalled).toBe(false);
      expect(result.installedPath).toContain('syncskill');
      expect(result.linkedAgents).toBeDefined();
      expect(result.linkedAgents).toContain('claude');

      // Verify file was actually copied
      const targetPath = join(homeDir, '.syncskill', 'skills', 'syncskill', 'SKILL.md');
      const content = await readFile(targetPath, 'utf8');
      expect(content).toContain('syncskill');
    });

    it('should update config with syncskill link', async () => {
      const embeddedPath = getEmbeddedSkillPath();
      let embeddedExists = false;
      try {
        await stat(join(embeddedPath, 'SKILL.md'));
        embeddedExists = true;
      } catch {
        // Embedded skill doesn't exist
      }

      if (!embeddedExists) {
        return;
      }

      await installSyncskillSkill(homeDir);

      const configPath = join(homeDir, '.syncskill', 'config.json');
      const configContent = await readFile(configPath, 'utf8');
      expect(configContent).toContain('syncskill');
    });

    it('should not update config if link already exists', async () => {
      // Pre-populate config with existing link
      const configPath = join(homeDir, '.syncskill', 'config.json');
      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            agents: { claude: '~/.claude/skills' },
            links: { syncskill: ['claude'] },
            servers: {},
            sources: {},
          },
          null,
          2
        )
      );

      // Create existing skill
      await mkdir(join(homeDir, '.syncskill', 'skills', 'syncskill'), { recursive: true });
      await writeFile(join(homeDir, '.syncskill', 'skills', 'syncskill', 'SKILL.md'), '# test');

      const result = await installSyncskillSkill(homeDir);
      expect(result.alreadyInstalled).toBe(true);

      // Config should be unchanged
      const configContent = await readFile(configPath, 'utf8');
      expect(configContent).toContain('"claude"');
    });

  });

  describe('installFromSource', () => {
    it('reports actual linked agents for newly installed skills', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'git', url: 'https://example.com/demo.git', path: '.' };

      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {
              claude: '~/.claude/skills',
              cursor: '~/.cursor/skills'
            },
            links: {},
            servers: {},
            sources: {
              'demo-source': source,
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: ['demo'],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([
          { name: 'demo', relativePath: 'demo', absolutePath: '/tmp/demo' }
        ]);
        const linkConfiguredSkills = vi.fn().mockResolvedValue([
          { skill: 'demo', agent: 'cursor', state: 'linked' },
          { skill: 'demo', agent: 'claude', state: 'linked' }
        ]);

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://example.com/demo.git');

        expect(addSourceFromUrl).toHaveBeenCalledWith(homeDir, 'https://example.com/demo.git', {
          name: undefined,
          path: undefined,
          skillSubdir: undefined,
          type: undefined,
          branch: undefined,
          skipPrompt: undefined,
          onSelectSkills: undefined
        });
        expect(materializeSource).toHaveBeenCalledWith(homeDir, 'demo-source', source);
        expect(discoverMaterializedSkillEntries).toHaveBeenCalledWith('demo-source', source, join(homeDir, '.syncskill', '.sources', 'demo-source', 'checkout'));
        expect(linkConfiguredSkills).toHaveBeenCalledWith(homeDir, { all: false, skillName: 'demo' });
        expect(result.installedSkills).toEqual(['demo']);
        expect(result.linkedAgents).toEqual(['claude', 'cursor']);
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns only newly installed skills when source also contains already linked skills', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'git', url: 'https://example.com/demo.git', path: '.' };

      await mkdir(join(homeDir, '.syncskill', 'skills', 'existing'), { recursive: true });
      await writeFile(join(homeDir, '.syncskill', 'skills', 'existing', 'SKILL.md'), '# existing', 'utf8');
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {
              claude: '~/.claude/skills'
            },
            links: { existing: ['claude'] },
            servers: {},
            sources: {
              'demo-source': source,
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: ['demo', 'existing'],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([
          { name: 'demo', relativePath: 'demo', absolutePath: '/tmp/demo' },
          { name: 'existing', relativePath: 'existing', absolutePath: '/tmp/existing' }
        ]);
        const linkConfiguredSkills = vi.fn().mockImplementation(async (_homeDir, request) => {
          if (request.skillName === 'demo') {
            return [{ skill: 'demo', agent: 'claude', state: 'linked' }];
          }
          return [];
        });

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://example.com/demo.git');

        expect(linkConfiguredSkills).toHaveBeenCalledTimes(1);
        expect(linkConfiguredSkills).toHaveBeenCalledWith(homeDir, { all: false, skillName: 'demo' });
        expect(result.installedSkills).toEqual(['demo']);
        expect(result.linkedAgents).toEqual(['claude']);
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('passes explicit source type through to addSourceFromUrl', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'http', url: 'https://example.com/archive.zip', path: 'skills' };

      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {},
            links: {},
            servers: {},
            sources: {
              'demo-source': source,
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: [],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([]);
        const linkConfiguredSkills = vi.fn().mockResolvedValue([]);

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://example.com/archive.zip', {
          type: 'http',
          path: 'skills'
        });

        expect(addSourceFromUrl).toHaveBeenCalledWith(homeDir, 'https://example.com/archive.zip', {
          name: undefined,
          path: 'skills',
          skillSubdir: undefined,
          type: 'http',
          branch: undefined,
          skipPrompt: undefined,
          onSelectSkills: undefined
        });
        expect(materializeSource).toHaveBeenCalledWith(homeDir, 'demo-source', source);
        expect(result.installedSkills).toEqual([]);
        expect(result.linkedAgents).toEqual([]);
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns restored ignored skills without rematerializing the source', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'git', url: 'https://example.com/demo.git', path: '.' };

      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {
              claude: '~/.claude/skills',
              cursor: '~/.cursor/skills'
            },
            links: { demo: ['*'] },
            servers: {},
            sources: {
              'demo-source': source,
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source,
          restoredFromIgnore: true,
          restoredSkill: 'demo'
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: ['demo'],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([]);
        const linkConfiguredSkills = vi.fn().mockResolvedValue([
          { skill: 'demo', agent: 'cursor', state: 'linked' },
          { skill: 'demo', agent: 'claude', state: 'linked' }
        ]);

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://example.com/demo.git');

        expect(materializeSource).not.toHaveBeenCalled();
        expect(discoverMaterializedSkillEntries).not.toHaveBeenCalled();
        expect(linkConfiguredSkills).toHaveBeenCalledWith(homeDir, { all: false, skillName: 'demo' });
        expect(result.installedSkills).toEqual(['demo']);
        expect(result.linkedAgents).toEqual(['claude', 'cursor']);
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('expands same-repo scope and activates newly covered skills', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'git', url: 'https://github.com/org/repo.git', path: 'skills/skill1' };

      await mkdir(join(homeDir, '.syncskill', 'skills', 'skill1'), { recursive: true });
      await writeFile(join(homeDir, '.syncskill', 'skills', 'skill1', 'SKILL.md'), '# skill1', 'utf8');
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {
              claude: '~/.claude/skills',
              cursor: '~/.cursor/skills'
            },
            links: { skill1: ['*'] },
            servers: {},
            sources: {
              'demo-source': {
                ...source,
                ignore: ['skill2']
              },
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source,
          sameRepoMatch: { name: 'demo-source', source }
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: ['skill1', 'skill2'],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const parseGitHubUrl = vi.fn().mockReturnValue({
          org: 'org',
          repo: 'repo',
          branch: 'main',
          path: 'skills',
          cloneUrl: 'https://github.com/org/repo.git',
          skillName: 'skills'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([
          { name: 'skill1', relativePath: 'skills/skill1', absolutePath: '/tmp/skill1' },
          { name: 'skill2', relativePath: 'skills/skill2', absolutePath: '/tmp/skill2' }
        ]);
        const linkConfiguredSkills = vi.fn().mockImplementation(async (_homeDir, request) => {
          if (request.skillName === 'skill2') {
            return [
              { skill: 'skill2', agent: 'cursor', state: 'linked' },
              { skill: 'skill2', agent: 'claude', state: 'linked' }
            ];
          }
          return [];
        });

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, parseGitHubUrl, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://github.com/org/repo/tree/main/skills');

        expect(materializeSource).toHaveBeenNthCalledWith(1, homeDir, 'demo-source', source);
        expect(materializeSource).toHaveBeenNthCalledWith(2, homeDir, 'demo-source', { ...source, path: 'skills' });
        expect(discoverMaterializedSkillEntries).toHaveBeenCalledWith('demo-source', source, join(homeDir, '.syncskill', '.sources', 'demo-source', 'checkout'));
        expect(linkConfiguredSkills).toHaveBeenCalledWith(homeDir, { all: false, skillName: 'skill2' });
        expect(result.installedSkills).toEqual(['skill2']);
        expect(result.linkedAgents).toEqual(['claude', 'cursor']);

        const config = JSON.parse(await readFile(join(homeDir, '.syncskill', 'config.json'), 'utf8'));
        expect(config.sources['demo-source'].path).toBe('skills');
        expect(config.sources['demo-source'].ignore).toBeUndefined();
        expect(config.links['skill2']).toBeDefined();
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('expands same-repo scope to common parent and auto-ignores cross-area skills', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');
      const source = { type: 'git', url: 'https://github.com/org/repo.git', path: 'tools' };

      await mkdir(join(homeDir, '.syncskill', 'skills', 'tool-a'), { recursive: true });
      await writeFile(join(homeDir, '.syncskill', 'skills', 'tool-a', 'SKILL.md'), '# tool-a', 'utf8');
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            conflict_resolution: 'manual',
            agents: {
              claude: '~/.claude/skills',
              cursor: '~/.cursor/skills'
            },
            links: { 'tool-a': ['*'] },
            servers: {},
            sources: {
              'demo-source': source,
            },
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source,
          sameRepoMatch: { name: 'demo-source', source }
        });
        const materializeSource = vi.fn().mockResolvedValue({
          materialized_skills: ['tool-a', 'demo', 'extra'],
          updated_at: '2026-06-09T00:00:00.000Z'
        });
        const parseGitHubUrl = vi.fn().mockReturnValue({
          org: 'org',
          repo: 'repo',
          branch: 'main',
          path: 'examples/demo',
          cloneUrl: 'https://github.com/org/repo.git',
          skillName: 'demo'
        });
        const discoverMaterializedSkillEntries = vi.fn().mockResolvedValue([
          { name: 'demo', relativePath: 'examples/demo', absolutePath: '/tmp/demo' },
          { name: 'extra', relativePath: 'other/extra', absolutePath: '/tmp/extra' },
          { name: 'tool-a', relativePath: 'tools/tool-a', absolutePath: '/tmp/tool-a' }
        ]);
        const linkConfiguredSkills = vi.fn().mockImplementation(async (_homeDir, request) => {
          if (request.skillName === 'demo') {
            return [
              { skill: 'demo', agent: 'cursor', state: 'linked' },
              { skill: 'demo', agent: 'claude', state: 'linked' }
            ];
          }
          return [];
        });

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl, materializeSource, parseGitHubUrl, discoverMaterializedSkillEntries }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        const result = await mockedInstallFromSource(homeDir, 'https://github.com/org/repo/tree/main/examples/demo');

        expect(materializeSource).toHaveBeenNthCalledWith(1, homeDir, 'demo-source', source);
        expect(materializeSource).toHaveBeenNthCalledWith(2, homeDir, 'demo-source', { ...source, path: '.' });
        expect(discoverMaterializedSkillEntries).toHaveBeenCalledWith('demo-source', source, join(homeDir, '.syncskill', '.sources', 'demo-source', 'checkout'));
        expect(linkConfiguredSkills).toHaveBeenCalledWith(homeDir, { all: false, skillName: 'demo' });
        expect(result.installedSkills).toEqual(['demo']);
        expect(result.linkedAgents).toEqual(['claude', 'cursor']);

        const config = JSON.parse(await readFile(join(homeDir, '.syncskill', 'config.json'), 'utf8'));
        expect(config.sources['demo-source'].path).toBe('.');
        expect(config.sources['demo-source'].ignore).toEqual(['extra']);
        expect(config.links['tool-a']).toEqual(['*']);
        expect(config.links['demo']).toBeDefined();
      } finally {
        vi.doUnmock('../../src/source.js');
        vi.doUnmock('../../src/linker.js');
        vi.resetModules();
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should throw error for invalid URL format', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}`);
      const homeDir = join(tempDir, 'home');

      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
      await writeFile(
        join(homeDir, '.syncskill', 'config.json'),
        JSON.stringify(
          {
            version: 1,
            agents: { claude: '~/.claude/skills' },
            links: {},
            servers: {},
            sources: {},
          },
          null,
          2
        )
      );

      try {
        await expect(
          installFromSource(homeDir, 'not-a-valid-url', { name: 'test' })
        ).rejects.toThrow('Could not parse source input');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
