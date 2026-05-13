// tests/unit/e2e-fixtures-archive.test.ts
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as compressing from 'compressing';

describe('E2E Archive Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createArchive creates a zip with skills', async () => {
    const { createArchive } = await import(
      '../end2end/framework/fixtures/archive.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-archive-'));
    tempDirs.push(tempDir);

    const archivePath = await createArchive(tempDir, 'skills.zip', {
      skills: ['skill-a', 'skill-b'],
      format: 'zip',
    });

    expect(archivePath).toContain('skills.zip');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Extract and verify
    const extractDir = join(tempDir, 'extracted');
    await compressing.zip.uncompress(archivePath, extractDir);

    const skillA = await stat(join(extractDir, 'skill-a', 'SKILL.md'));
    expect(skillA.isFile()).toBe(true);
  });

  it('createArchive creates a tar.gz with skills', async () => {
    const { createArchive } = await import(
      '../end2end/framework/fixtures/archive.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-archive-'));
    tempDirs.push(tempDir);

    const archivePath = await createArchive(tempDir, 'skills.tar.gz', {
      skills: ['my-skill'],
      format: 'tar.gz',
    });

    expect(archivePath).toContain('skills.tar.gz');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Extract and verify
    const extractDir = join(tempDir, 'extracted');
    await compressing.tgz.uncompress(archivePath, extractDir);

    const skill = await stat(join(extractDir, 'my-skill', 'SKILL.md'));
    expect(skill.isFile()).toBe(true);
  });
});
