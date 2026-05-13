// tests/unit/e2e-fixtures-server.test.ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Mock Server Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createMockServer creates a server directory structure', async () => {
    const { createMockServer } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'dev-server',
      skills: ['skill-a'],
    });

    expect(server.name).toBe('dev-server');
    expect(server.path).toContain('dev-server');

    const syncskillDir = await stat(server.syncskillDir);
    expect(syncskillDir.isDirectory()).toBe(true);

    const skillsDir = await stat(server.skillsDir);
    expect(skillsDir.isDirectory()).toBe(true);
  });

  it('modifyServerSkill updates skill content', async () => {
    const { createMockServer, modifyServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'dev',
      skills: ['my-skill'],
    });

    await modifyServerSkill(server, 'my-skill', '# Modified\n');

    const content = await readFile(
      join(server.skillsDir, 'my-skill', 'SKILL.md'),
      'utf8'
    );
    expect(content).toBe('# Modified\n');
  });

  it('addServerSkill adds a new skill', async () => {
    const { createMockServer, addServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, { name: 'prod' });

    await addServerSkill(server, 'new-skill', '# New\n');

    const stats = await stat(join(server.skillsDir, 'new-skill', 'SKILL.md'));
    expect(stats.isFile()).toBe(true);
  });

  it('removeServerSkill removes a skill', async () => {
    const { createMockServer, removeServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'staging',
      skills: ['to-remove'],
    });

    await removeServerSkill(server, 'to-remove');

    await expect(stat(join(server.skillsDir, 'to-remove'))).rejects.toThrow();
  });
});
