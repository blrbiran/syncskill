// tests/unit/e2e-runner.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

describe('E2E Runner', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('execCommand runs a command and returns result', async () => {
    const { execCommand } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await execCommand('echo', ['hello'], { cwd: tempDir });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('execCommand returns failure for non-zero exit', async () => {
    const { execCommand } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await execCommand('node', ['-e', 'process.exit(1)'], {
      cwd: tempDir,
      expectedExitCode: null,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('runSyncskill runs syncskill CLI with HOME override', async () => {
    const { runSyncskill } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await runSyncskill(tempDir, rootDir, ['--help']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('Usage: syncskill');
  });
});
