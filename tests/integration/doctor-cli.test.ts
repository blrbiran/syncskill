// tests/integration/doctor-cli.test.ts
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

describe('syncskill doctor', () => {
  const testDir = join(tmpdir(), `doctor-cli-test-${Date.now()}`);
  const homeDir = join(testDir, 'home');
  const syncDir = join(homeDir, '.syncskill');
  const skillsDir = join(syncDir, 'skills');
  const configFile = join(syncDir, 'config.yaml');
  const cliPath = join(process.cwd(), 'dist', 'index.js');

  beforeEach(async () => {
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function runDoctor(args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const result = await execFileAsync('node', [cliPath, 'doctor', ...args], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error: unknown) {
      const execError = error as { stdout: string; stderr: string; code: number };
      return { stdout: execError.stdout || '', stderr: execError.stderr || '', code: execError.code || 1 };
    }
  }

  it('reports healthy config', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { stdout, code } = await runDoctor();

    expect(code).toBe(0);
    expect(stdout).toContain('No issues found');
  });

  it('reports missing skill warning', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'missing-skill': ['claude'] },
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { stdout, code } = await runDoctor();

    expect(code).toBe(0);
    expect(stdout).toContain('Warning');
    expect(stdout).toContain('missing-skill');
  });
});
