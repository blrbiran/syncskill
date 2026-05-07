import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { removeSource } from '../../src/source.js';

describe('removeSource', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('removes source from config and deletes store directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    const storeDir = join(homeDir, '.syncskill', '.sources', 'test-source', 'checkout');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'dummy.txt'), 'test');

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'test-source': {
          type: 'git',
          url: 'https://github.com/test/repo.git',
          store: '.'
        }
      }
    }, homeDir);

    await removeSource(homeDir, 'test-source');

    const config = await loadConfig(homeDir);
    expect(config.sources['test-source']).toBeUndefined();
  });

  it('keeps store directory when keepStore is true', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    const storeDir = join(homeDir, '.syncskill', '.sources', 'test-source', 'checkout');
    await mkdir(storeDir, { recursive: true });

    await saveConfig({
      ...createDefaultConfig(homeDir, {}),
      sources: {
        'test-source': {
          type: 'git',
          url: 'https://github.com/test/repo.git',
          store: '.'
        }
      }
    }, homeDir);

    await removeSource(homeDir, 'test-source', { keepStore: true });

    const config = await loadConfig(homeDir);
    expect(config.sources['test-source']).toBeUndefined();
  });

  it('throws error for non-existent source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await expect(removeSource(homeDir, 'nonexistent')).rejects.toThrow('Source not found: nonexistent');
  });
});
