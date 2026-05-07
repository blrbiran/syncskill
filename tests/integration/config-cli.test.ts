import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { createProgram } from '../../src/index.js';

describe('config CLI', () => {
  it('init, discover, and link --status work together for one local skill', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-cli-'));
    tempDirs.push(homeDir);

    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'node' });

    await mkdir(join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'hello', 'utf8');

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'discover', '--all-agents'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'node' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--status'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledWith('welcome\tclaude\tlinked');
  });

  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
