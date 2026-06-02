// tests/integration/doctor-cli.test.ts
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const execFileAsync = promisify(execFile);

describe('syncskill doctor', () => {
  const testDir = join(tmpdir(), `doctor-cli-test-${Date.now()}`);
  const homeDir = join(testDir, 'home');
  const syncDir = join(homeDir, '.syncskill');
  const skillsDir = join(syncDir, 'skills');
  const configFile = join(syncDir, 'config.json');
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
    await writeFile(configFile, JSON.stringify(config, null, 2));

    // Create empty skills registry for healthy state
    const registryFile = join(syncDir, 'skills-registry.json');
    await writeFile(registryFile, JSON.stringify({ version: 1, skills: {} }));

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
    await writeFile(configFile, JSON.stringify(config, null, 2));

    const { stdout, code } = await runDoctor();

    expect(code).toBe(0);
    expect(stdout).toContain('Warning');
    expect(stdout).toContain('missing-skill');
  });

  it('rejects removed rebuild-registry flag', async () => {
    const { stderr, code } = await runDoctor(['--rebuild-registry']);

    expect(code).not.toBe(0);
    expect(stderr).toContain("unknown option '--rebuild-registry'");
  });

  describe('auto-check integration', () => {
    it('warns when running link with config issues', async () => {
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
      await writeFile(configFile, JSON.stringify(config, null, 2));

      const { stderr } = await execFileAsync('node', [cliPath, 'link', 'list'], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
      });
      expect(stderr).toContain('Config has');
      expect(stderr).toContain('syncskill doctor');
    });

    it('blocks when no valid agents', async () => {
      const config = {
        version: 1,
        conflict_resolution: 'manual',
        agents: { claude: join(homeDir, 'nonexistent') },
        links: {},
        servers: {},
        sources: {}
      };
      await writeFile(configFile, JSON.stringify(config, null, 2));

      try {
        await execFileAsync('node', [cliPath, 'link', 'list'], {
          env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
        });
        expect.fail('Should have thrown');
      } catch (e: unknown) {
        const err = e as { code?: number; stderr?: string };
        expect(err.code).not.toBe(0);
        expect(err.stderr).toContain('doctor --fix');
      }
    });
  });
});
