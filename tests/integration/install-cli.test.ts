import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('install CLI command', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = join(import.meta.dirname, `../../.test-tmp-install-cli-${Date.now()}`);
    homeDir = join(tempDir, 'home');
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });

    const configPath = join(homeDir, '.syncskill', 'config.yaml');
    await writeFile(
      configPath,
      'version: 1\nagents:\n  claude: ~/.claude/skills\nlinks: {}\nservers: {}\nsources: {}\n'
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should show install command in help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('install');
  });

  it('should accept i as alias for install', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'i', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('Install');
  });

  it('should show install options in help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('--name');
    expect(stdout).toContain('--path');
    expect(stdout).toContain('--ref');
    expect(stdout).toContain('--yes');
  });
});
