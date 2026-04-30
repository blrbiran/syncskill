import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { createProgram } from '../src/index.js';

describe('config CLI', () => {
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
});
