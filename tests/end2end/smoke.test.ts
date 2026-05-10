import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const tempDirs = useTempDirs();
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('shipped cli smoke test', () => {
  it('prints top-level help from the built entrypoint', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(homeDir);

    const { stdout } = await execFileAsync('node', ['dist/index.js', '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    expect(stdout).toContain('Usage: syncskill');
    expect(stdout).toContain('init');
    expect(stdout).toContain('sync');
  });
});
