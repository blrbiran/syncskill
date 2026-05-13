// tests/unit/e2e-guard.test.ts
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E Guard', () => {
  it('throws E2EGuardError when path is real HOME', async () => {
    const { E2EGuardError, assertPathSafe } = await import(
      '../end2end/framework/guard.js'
    );
    const realHome = homedir();

    expect(() => assertPathSafe(realHome)).toThrow(E2EGuardError);
    expect(() => assertPathSafe(join(realHome, '.syncskill'))).toThrow(E2EGuardError);
    expect(() => assertPathSafe(join(realHome, '.claude', 'skills'))).toThrow(E2EGuardError);
  });

  it('allows paths in temp directory', async () => {
    const { assertPathSafe } = await import('../end2end/framework/guard.js');
    const tempPath = join(tmpdir(), 'syncskill-e2e-test123', '.syncskill');

    expect(() => assertPathSafe(tempPath)).not.toThrow();
  });

  it('isInAllowedTempDir returns true for temp paths', async () => {
    const { isInAllowedTempDir } = await import('../end2end/framework/guard.js');
    const allowedTemp = join(tmpdir(), 'syncskill-e2e-abc');

    expect(isInAllowedTempDir(join(allowedTemp, '.syncskill'), allowedTemp)).toBe(true);
    expect(isInAllowedTempDir('/home/user/.syncskill', allowedTemp)).toBe(false);
  });
});
