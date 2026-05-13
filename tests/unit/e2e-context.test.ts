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
});
