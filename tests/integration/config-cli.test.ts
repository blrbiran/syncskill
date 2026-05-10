import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { createProgram } from '../../src/index.js';

describe('config CLI', () => {
  it('init, scan, and link list work together for one local skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

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
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

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
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

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
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

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
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

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
      sources: {}
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
