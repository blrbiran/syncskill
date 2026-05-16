import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
    expect(stdout).toContain('--branch');
    expect(stdout).toContain('--yes');
  });

  it('shows help when install is called without args', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('Usage: syncskill install|i [options] [urlOrPath]');
    expect(stdout).toContain('--self');
  });

  it('includes --self in install help output', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'install', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('--self');
    expect(stdout).toContain('Install built-in syncskill skill');
  });

  it('treats self argument as built-in install target when no local ./self directory exists', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'dist/index.js', 'install', 'self'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir }
    });

    expect(stdout).toContain('Installed syncskill skill to');
    const installedSkills = await readdir(join(homeDir, '.syncskill', 'skills'));
    expect(installedSkills).toContain('syncskill');
  });

  it('prefers a real ./self directory over built-in self shorthand', async () => {
    await mkdir(join(import.meta.dirname, '../../self'), { recursive: true });

    try {
      await expect(
        execFileAsync('npx', ['tsx', 'src/index.ts', 'install', 'self'], {
          cwd: join(import.meta.dirname, '../..'),
          env: { ...process.env, HOME: homeDir }
        })
      ).rejects.toThrow('Could not parse URL');
    } finally {
      await rm(join(import.meta.dirname, '../../self'), { recursive: true, force: true });
    }
  });
});
