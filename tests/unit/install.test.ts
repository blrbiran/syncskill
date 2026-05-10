import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEmbeddedSkillPath, installSyncskillSkill } from '../../src/install.js';

describe('install module', () => {
  describe('getEmbeddedSkillPath', () => {
    it('should return path containing skills/syncskill', () => {
      const path = getEmbeddedSkillPath();
      expect(path).toContain('skills');
      expect(path).toContain('syncskill');
    });
  });

  describe('installSyncskillSkill', () => {
    let tempDir: string;
    let homeDir: string;

    beforeEach(async () => {
      tempDir = join(import.meta.dirname, `../../.test-tmp-install-${Date.now()}`);
      homeDir = join(tempDir, 'home');
      await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

      const configPath = join(homeDir, '.syncskill', 'config.yaml');
      await writeFile(
        configPath,
        'version: 1\nagents:\n  claude: ~/.claude/skills\nlinks: {}\nservers: {}\nsources: {}\n'
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
  });
});
