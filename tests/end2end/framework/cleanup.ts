// tests/end2end/framework/cleanup.ts
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix for all E2E temp directories.
 */
export const TEMP_PREFIX = 'syncskill-e2e-';

/**
 * Clean up stale temp directories from previous crashed runs.
 * Called in globalSetup before tests start.
 */
export async function cleanupStaleTempDirs(): Promise<void> {
  const tmp = tmpdir();
  let entries: string[];

  try {
    entries = await readdir(tmp);
  } catch {
    return;
  }

  const staleThreshold = Date.now() - 60 * 60 * 1000; // 1 hour old

  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;

    const fullPath = join(tmp, entry);
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory() && stats.mtimeMs < staleThreshold) {
        await rm(fullPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore errors for individual directories
    }
  }
}

/**
 * Create a new managed temp directory for E2E tests.
 */
export async function createManagedTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), TEMP_PREFIX));
}

/**
 * Remove a temp directory.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
