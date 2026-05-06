import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import type { PromptApi } from '../../src/config-ui.js';
import { runConfigUi, safeSelect } from '../../src/config-ui.js';
import { ExitPromptError } from '@inquirer/core';

class PromptStub implements PromptApi {
  constructor(private readonly answers: unknown[]) {}

  async select<T>(_: { message: string; choices: Array<{ name: string; value: T }> }): Promise<T> {
    return this.next() as T;
  }

  async input(_: { message: string; default?: string }): Promise<string> {
    return this.next() as string;
  }

  async checkbox<T>(_: { message: string; choices: Array<{ name: string; value: T; checked?: boolean }> }): Promise<T[]> {
    return this.next() as T[];
  }

  async confirm(_: { message: string; default?: boolean }): Promise<boolean> {
    return this.next() as boolean;
  }

  private next(): unknown {
    if (this.answers.length === 0) {
      throw new Error('Prompt queue exhausted');
    }

    return this.answers.shift();
  }
}

describe('runConfigUi', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('adds a local agent entry and saves the config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-ui-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await runConfigUi(
      homeDir,
      new PromptStub(['agents', 'add', 'local', '/tmp/local-skills', 'back', 'done', true])
    );

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        local: '/tmp/local-skills'
      },
      links: {},
      servers: {},
      sources: {}
    });
  });

  it('updates link targets and saves them back to config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-ui-'));
    tempDirs.push(homeDir);

    await saveConfig(
      createDefaultConfig(homeDir, {
        claude: join(homeDir, '.claude', 'skills'),
        qoder: join(homeDir, '.qoder', 'skills')
      }),
      homeDir
    );

    await runConfigUi(homeDir, new PromptStub(['links', 'edit', 'welcome', ['*', 'qoder'], 'back', 'done', true]));

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'manual',
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        qoder: join(homeDir, '.qoder', 'skills')
      },
      links: {
        welcome: ['*', 'qoder']
      },
      servers: {},
      sources: {}
    });
  });

  it('updates conflict resolution and writes it back to config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-config-ui-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await runConfigUi(homeDir, new PromptStub(['conflict_resolution', 'keep-local', 'done', true]));

    await expect(loadConfig(homeDir)).resolves.toEqual({
      version: 1,
      conflict_resolution: 'keep-local',
      agents: {},
      links: {},
      servers: {},
      sources: {}
    });
  });
});

describe('safeSelect', () => {
  it('returns selected value on normal selection', async () => {
    const prompts = new PromptStub(['agents']) as unknown as PromptApi;
    const result = await safeSelect(prompts, {
      message: 'Choose',
      choices: [{ name: 'agents', value: 'agents' }]
    });
    expect(result).toEqual({ escaped: false, value: 'agents' });
  });

  it('returns escaped: true when ExitPromptError is thrown', async () => {
    const prompts: PromptApi = {
      select: async () => {
        throw new ExitPromptError();
      },
      input: async () => '',
      checkbox: async () => [],
      confirm: async () => false
    };

    const result = await safeSelect(prompts, {
      message: 'Choose',
      choices: [{ name: 'test', value: 'test' }]
    });
    expect(result).toEqual({ escaped: true });
  });

  it('rethrows non-ExitPromptError errors', async () => {
    const prompts: PromptApi = {
      select: async () => {
        throw new Error('Some other error');
      },
      input: async () => '',
      checkbox: async () => [],
      confirm: async () => false
    };

    await expect(
      safeSelect(prompts, {
        message: 'Choose',
        choices: [{ name: 'test', value: 'test' }]
      })
    ).rejects.toThrow('Some other error');
  });
});
