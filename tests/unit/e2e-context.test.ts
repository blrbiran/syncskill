// tests/unit/e2e-context.test.ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

describe('E2EContext', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates context with correct paths', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    expect(ctx.homeDir).toBe(tempDir);
    expect(ctx.syncskillDir).toBe(join(tempDir, '.syncskill'));
  });

  it('getPath returns absolute path', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    expect(ctx.getPath('.syncskill', 'skills')).toBe(
      join(tempDir, '.syncskill', 'skills')
    );
  });

  it('readFile and writeFile work correctly', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await mkdir(join(tempDir, 'test'), { recursive: true });
    await ctx.writeFile('test/file.txt', 'hello');

    const content = await ctx.readFile('test/file.txt');
    expect(content).toBe('hello');
  });

  it('assertFileExists passes for existing file', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
    await writeFile(join(tempDir, '.syncskill', 'config.yaml'), 'version: 1');

    await expect(ctx.assertFileExists('.syncskill/config.yaml')).resolves.not.toThrow();
  });

  it('assertFileExists fails for missing file', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await expect(ctx.assertFileExists('missing.txt')).rejects.toThrow();
  });

  it('assertLinked checks symlink correctly', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    // Setup: create skill and agent dir with symlink
    const skillDir = join(tempDir, '.syncskill', 'skills', 'my-skill');
    const agentDir = join(tempDir, '.claude', 'skills');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill');
    await mkdir(agentDir, { recursive: true });
    await symlink(skillDir, join(agentDir, 'my-skill'));

    await expect(ctx.assertLinked('my-skill', ['claude'])).resolves.not.toThrow();
  });

  describe('E2EContext new methods', () => {
    it('writeRegistry writes skills-registry.json', async () => {
      const { E2EContext } = await import('../end2end/framework/context.js');
      const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
      tempDirs.push(homeDir);
      await mkdir(join(homeDir, '.syncskill'), { recursive: true });

      const ctx = new E2EContext(homeDir, '/fake/project');

      const registry = {
        version: 1,
        skills: {
          'test-skill': {
            path: `${homeDir}/.syncskill/skills/test-skill`,
            origin: 'manual',
            type: 'manual',
            status: 'active',
          },
        },
      };

      await ctx.writeRegistry(registry);

      const content = await ctx.readFile('.syncskill/skills-registry.json');
      expect(JSON.parse(content)).toEqual(registry);
    });

    it('assertBackupExists checks backup directory', async () => {
      const { E2EContext } = await import('../end2end/framework/context.js');
      const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
      tempDirs.push(homeDir);
      const backupDir = join(homeDir, '.syncskill', 'backups', 'my-source', 'my-skill');
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, 'SKILL.md'), '# Backup\n', 'utf8');

      const ctx = new E2EContext(homeDir, '/fake/project');

      await expect(ctx.assertBackupExists('my-source', 'my-skill')).resolves.toBeUndefined();
      await expect(ctx.assertBackupExists('my-source', 'no-skill')).rejects.toThrow();
    });

    it('assertSymlinkTarget verifies symlink points to expected target', async () => {
      const { E2EContext } = await import('../end2end/framework/context.js');
      const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
      tempDirs.push(homeDir);
      const agentDir = join(homeDir, '.claude', 'skills');
      const skillSource = join(homeDir, '.syncskill', 'skills', 'my-skill');
      await mkdir(agentDir, { recursive: true });
      await mkdir(skillSource, { recursive: true });
      await writeFile(join(skillSource, 'SKILL.md'), '# Test\n', 'utf8');
      await symlink(skillSource, join(agentDir, 'my-skill'));

      const ctx = new E2EContext(homeDir, '/fake/project');

      await expect(
        ctx.assertSymlinkTarget('my-skill', 'claude', skillSource)
      ).resolves.toBeUndefined();

      await expect(
        ctx.assertSymlinkTarget('my-skill', 'claude', '/wrong/path')
      ).rejects.toThrow('Expected symlink');
    });
  });
});
