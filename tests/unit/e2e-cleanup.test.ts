// tests/unit/e2e-cleanup.test.ts
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Cleanup', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('TEMP_PREFIX is syncskill-e2e-', async () => {
    const { TEMP_PREFIX } = await import('../end2end/framework/cleanup.js');
    expect(TEMP_PREFIX).toBe('syncskill-e2e-');
  });

  it('cleanupStaleTempDirs removes old temp directories', async () => {
    const { TEMP_PREFIX, cleanupStaleTempDirs } = await import(
      '../end2end/framework/cleanup.js'
    );

    // Create a stale temp dir
    const staleDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    createdDirs.push(staleDir);
    await mkdir(join(staleDir, '.syncskill'), { recursive: true });

    // Make it appear old (2 hours ago) by setting mtime
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staleDir, twoHoursAgo, twoHoursAgo);

    // Run cleanup
    await cleanupStaleTempDirs();

    // Verify it's gone
    await expect(stat(staleDir)).rejects.toThrow();
  });

  it('createManagedTempDir creates temp directory with prefix', async () => {
    const { TEMP_PREFIX, createManagedTempDir } = await import(
      '../end2end/framework/cleanup.js'
    );

    const tempDir = await createManagedTempDir();
    createdDirs.push(tempDir);

    expect(tempDir).toContain(TEMP_PREFIX);
    const stats = await stat(tempDir);
    expect(stats.isDirectory()).toBe(true);
  });
});
