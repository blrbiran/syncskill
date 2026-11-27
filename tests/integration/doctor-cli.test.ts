// tests/integration/doctor-cli.test.ts
import { execFile } from 'node:child_process';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('emits one documented result line under --json (#491)', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    await writeFile(configFile, JSON.stringify({
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    }));

    const { stdout, code } = await runDoctor(['--json']);

    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as { type: string; command: string; ok: boolean; summary: Record<string, unknown> };
    expect(event.type).toBe('result');
    expect(event.command).toBe('doctor');
    expect(event.ok).toBe(true);
    expect(event.summary).toEqual({ errors: [], warnings: [], fixed: [], skipped: [] });
    expect(event.summary).not.toHaveProperty('agents');
    expect(event.summary).not.toHaveProperty('sources');
  });

  it('keeps the exit status when --json finds an error (#491)', async () => {
    await writeFile(configFile, JSON.stringify({
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: join(homeDir, 'nonexistent') },
      links: {},
      servers: {},
      sources: {}
    }));

    const { stdout, code } = await runDoctor(['--json']);

    expect(code).toBe(1);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as { ok: boolean; summary: { errors: Array<{ code: string }> } };
    expect(event.ok).toBe(false);
    expect(event.summary.errors[0].code).toBe('NO_VALID_AGENTS');
  });

  it('keeps a dangling managed link while a source is unreadable (#486)', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });
    const source = join(testDir, 'offline');
    const target = join(source, 'demo');
    const link = join(agentDir, 'demo');
    await symlink(target, link, 'dir');
    await writeFile(configFile, JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: { claude: agentDir },
      links: { demo: ['claude'] }, servers: {}, sources: { offline: { type: 'local', path: source } }
    }));
    const report = await runDoctor(['--fix', '--yes']);
    expect(report.stdout).toContain('offline');
    expect(await readlink(link)).toBe(target);
    expect(JSON.parse(await readFile(configFile, 'utf8')).links).toEqual({ demo: ['claude'] });
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

  it('keeps an unverified skill link under doctor --fix -y (#486)', async () => {
    const { createProgram } = await import('../../src/index.js');
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });
    await writeFile(configFile, JSON.stringify({
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'src-skill': ['claude'] },
      servers: {},
      sources: { bad: { type: 'local', path: 'nope' } }
    }));

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'doctor', '--fix', '-y']);

    const repaired = JSON.parse(await readFile(configFile, 'utf8'));
    expect(repaired.links['src-skill']).toEqual(['claude']);
  });

  it('keeps an existing unmanaged agent link under doctor --fix -y (#486)', async () => {
    const { createProgram } = await import('../../src/index.js');
    const agentDir = join(homeDir, '.claude', 'skills');
    const externalSkill = join(testDir, 'external-skill');
    await mkdir(agentDir, { recursive: true });
    await mkdir(externalSkill, { recursive: true });
    await writeFile(join(externalSkill, 'SKILL.md'), '# external skill');
    await symlink(externalSkill, join(agentDir, 'src-skill'));
    await writeFile(configFile, JSON.stringify({
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'src-skill': ['claude'] },
      servers: {},
      sources: {}
    }));

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'doctor', '--fix', '-y']);

    const repaired = JSON.parse(await readFile(configFile, 'utf8'));
    expect(repaired.links['src-skill']).toEqual(['claude']);
    await expect(readFile(join(agentDir, 'src-skill', 'SKILL.md'), 'utf8')).resolves.toBe('# external skill');
  });

  it('rejects removed rebuild-registry flag', async () => {
    const { stderr, code } = await runDoctor(['--rebuild-registry']);

    expect(code).not.toBe(0);
    expect(stderr).toContain("unknown option '--rebuild-registry'");
  });

  it('does not treat duplicate agent directories as auto-fixable under --fix -y', async () => {
    const claudeDir = join(homeDir, '.claude', 'skills');
    const codexRoot = join(homeDir, '.codex');
    const codexDir = join(codexRoot, 'skills');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    await symlink(claudeDir, codexDir);

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: claudeDir, codex: codexDir },
      links: {},
      servers: {},
      sources: {}
    };
    await writeFile(configFile, JSON.stringify(config, null, 2));

    const before = await readFile(configFile, 'utf8');
    const { stdout, code } = await runDoctor(['--fix', '-y']);
    const after = await readFile(configFile, 'utf8');

    expect(code).toBe(0);
    expect(stdout).toContain('Found 0 auto-fixable issues');
    expect(stdout).toContain('Remaining manual issues:');
    expect(stdout).toContain('agents.codex');
    expect(stdout).toContain('same underlying directory');
    expect(stdout).toContain('No auto-fixable issues were applied.');
    expect(stdout).not.toContain('✓ Fixed agents.codex');
    expect(after).toBe(before);
  });

  it('removes hidden non-skill link entries under --fix -y', async () => {
    const claudeDir = join(homeDir, '.claude', 'skills');
    await mkdir(join(claudeDir, '.curator_backups'), { recursive: true });
    await mkdir(join(skillsDir, '.curator_backups'), { recursive: true });
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'real-skill', 'SKILL.md'), '# real');

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: claudeDir },
      links: { '.curator_backups': ['claude'], 'real-skill': ['claude'] },
      servers: {},
      sources: {}
    };
    await writeFile(configFile, JSON.stringify(config, null, 2));

    const { stdout, code } = await runDoctor(['--fix', '-y']);
    const after = JSON.parse(await readFile(configFile, 'utf8')) as { links: Record<string, string[]> };

    expect(code).toBe(0);
    expect(stdout).toContain('✓ Fixed links..curator_backups');
    expect(after.links).toEqual({ 'real-skill': ['claude'] });
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
