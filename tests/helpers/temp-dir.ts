import { rm } from 'node:fs/promises';
import { afterEach } from 'vitest';

/**
 * Create a managed temp directory tracker that auto-cleans after each test.
 * Usage:
 *   const tempDirs = useTempDirs();
 *   // in test: tempDirs.push(myTempDir);
 */
export function useTempDirs(): string[] {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  return dirs;
}
