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
    it('reports actual linked agents instead of raw config targets', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');

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
            sources: {},
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source: { type: 'git', url: 'https://example.com/demo.git', path: '.' }
        });
        const linkConfiguredSkills = vi.fn().mockResolvedValue([
          { skill: 'demo', agent: 'cursor', state: 'linked' },
          { skill: 'demo', agent: 'claude', state: 'linked' }
        ]);

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl }));
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

    it('passes explicit source type through to addSourceFromUrl', async () => {
      const tempDir = join(import.meta.dirname, `../../.test-tmp-install-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const homeDir = join(tempDir, 'home');

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
            sources: {},
          },
          null,
          2
        )
      );

      try {
        vi.resetModules();
        const addSourceFromUrl = vi.fn().mockResolvedValue({
          name: 'demo-source',
          source: { type: 'http', url: 'https://example.com/archive.zip', path: 'skills' }
        });
        const linkConfiguredSkills = vi.fn().mockResolvedValue([]);

        vi.doMock('../../src/source.js', () => ({ addSourceFromUrl }));
        vi.doMock('../../src/linker.js', () => ({ linkConfiguredSkills }));

        const { installFromSource: mockedInstallFromSource } = await import('../../src/install.js');
        await mockedInstallFromSource(homeDir, 'https://example.com/archive.zip', {
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
        ).rejects.toThrow('Could not parse URL');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
