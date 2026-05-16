import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerManifest } from '../../src/core/manifest.js';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, getSyncPaths, loadConfig, saveConfig } from '../../src/config/config.js';
import { saveServerManifest } from '../../src/core/manifest.js';
import { addActiveSkill, addIgnoredSkill, saveSkillsRegistry } from '../../src/core/skills-registry.js';
import { createProgram } from '../../src/index.js';

describe('config CLI', () => {
  it('init, scan, and link list work together for one local skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'hello', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'list'], { from: 'node' });

    // Check that the matrix format output was logged (contains skill name and linked symbol)
    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('welcome');
    expect(loggedOutput).toContain('✓'); // linked symbol
  });

  it('link list -v shows verbose text output', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'my-skill'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'my-skill', 'SKILL.md'), '# test', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', 'list', '-v'], { from: 'node' });

    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('linked'); // verbose text instead of ✓
    expect(loggedOutput).not.toContain('Legend:'); // no legend in verbose mode
  });

  it('link --dry-run previews without linking', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'dry-skill'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'dry-skill', 'SKILL.md'), '# test', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all', '--dry-run'], { from: 'node' });

    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('[dry-run]');

    // Verify no actual link was created
    await expect(readlink(join(homeDir, '.claude', 'skills', 'dry-skill'))).rejects.toThrow();
  });

  it('unlink --dry-run previews without unlinking', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'unlink-test'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'unlink-test', 'SKILL.md'), '# test', 'utf8');

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });

    // Verify link exists
    await expect(readlink(join(homeDir, '.claude', 'skills', 'unlink-test'))).resolves.toBeDefined();

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'unlink', 'unlink-test', '--dry-run'], { from: 'node' });

    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('[dry-run]');

    // Verify link still exists
    await expect(readlink(join(homeDir, '.claude', 'skills', 'unlink-test'))).resolves.toBeDefined();
  });

  it('unlink --yes skips confirmation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-scan'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'to-unlink'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'to-unlink', 'SKILL.md'), '# test', 'utf8');

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });

    // Verify link exists
    await expect(readlink(join(homeDir, '.claude', 'skills', 'to-unlink'))).resolves.toBeDefined();

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'unlink', 'to-unlink', '--yes'], { from: 'node' });

    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('Unlinked');

    // Verify link is removed
    await expect(readlink(join(homeDir, '.claude', 'skills', 'to-unlink'))).rejects.toThrow();
  });

  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('shows dashboard summary when run with no args', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'linked-skill'), { recursive: true });
    await mkdir(join(homeDir, '.syncskill', 'skills', 'ignored-skill'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, { claude: join(homeDir, '.claude', 'skills') }), homeDir);
    await writeFile(join(homeDir, '.syncskill', 'skills', 'linked-skill', 'SKILL.md'), '# linked', 'utf8');
    await writeFile(join(homeDir, '.syncskill', 'skills', 'ignored-skill', 'SKILL.md'), '# ignored', 'utf8');

    const now = '2026-05-17T10:00:00.000Z';
    const manifest: ServerManifest = {
      version: 1,
      server: 'alpha',
      updated_at: now,
      skills: {}
    };
    await saveServerManifest(homeDir, manifest);

    let registry = addActiveSkill({ version: 1, skills: {} }, 'linked-skill', {
      path: join(getSyncPaths(homeDir).skillsDir, 'linked-skill'),
      origin: 'manual',
      type: 'manual'
    });
    registry = addIgnoredSkill(registry, 'ignored-skill', {
      path: join(getSyncPaths(homeDir).skillsDir, 'ignored-skill'),
      origin: 'team',
      type: 'git',
      ignored_reason: 'duplicate'
    });
    await saveSkillsRegistry(homeDir, registry);

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill'], { from: 'node' });

    const loggedOutput = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(loggedOutput).toContain('Health');
    expect(loggedOutput).toContain('0 issues');
    expect(loggedOutput).toContain('Servers');
    expect(loggedOutput).toContain('1 local');
    expect(loggedOutput).toContain('Skills');
    expect(loggedOutput).toContain('1 active');
    expect(loggedOutput).toContain('1 ignored');
  });

  it('config show prints pretty JSON for the current config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {
      claude: join(homeDir, '.claude', 'skills')
    });
    await saveConfig(config, homeDir);

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'config', 'show'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(config, null, 2));
  });
  it('config set updates a dotted path and parses JSON arrays', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'config', 'set', 'links.welcome', '["claude","qoder"]'],
      { from: 'node' }
    );

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {
        welcome: ['claude', 'qoder']
      },
      servers: {},
      sources: {},
      private_agents: ['cursor', 'kiro', 'augment', 'cline', 'hermes']
    });
  });

  it('lists all valid config paths with --show-paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-'));
    tempDirs.push(homeDir);

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      agents: { claude: '~/.claude/skills' },
      servers: { prod: { host: 'prod.example.com', user: 'deploy' } }
    }, homeDir);

    const output: string[] = [];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      output.push(msg);
    });

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'config', 'set', '--show-paths']);

    consoleLog.mockRestore();

    expect(output.some(line => line.includes('agents.claude'))).toBe(true);
    expect(output.some(line => line.includes('servers.prod.host'))).toBe(true);
    expect(output.some(line => line.includes('conflict_resolution'))).toBe(true);
  });
});
