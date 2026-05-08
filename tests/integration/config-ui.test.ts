import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import type { PromptApi, SSHHostConfig } from '../../src/config-ui.js';
import { runConfigUi, safeSelect, applyMatrixToLinks, editServers, applyMatrixToRemote, parseSSHConfig } from '../../src/config-ui.js';
import { ExitPromptError } from '@inquirer/core';
import type { SyncSkillConfig } from '../../src/config.js';

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
      new PromptStub(['agents', 'add', 'local', '/tmp/local-skills', 'back', 'done'])
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

    await runConfigUi(homeDir, new PromptStub(['links', 'edit', 'welcome', ['*', 'qoder'], 'back', 'done']));

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

    await runConfigUi(homeDir, new PromptStub(['conflict_resolution', 'keep-local', 'done']));

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

describe('applyMatrixToLinks', () => {
  it('updates config.links from matrix selection', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills', hermes: '~/.hermes/skills' },
      links: { 'skill-a': ['claude'] },
      servers: {},
      sources: {}
    };

    applyMatrixToLinks(config, {
      cancelled: false,
      selected: { 'skill-a': ['claude', 'hermes'], 'skill-b': ['claude'] }
    });

    expect(config.links['skill-a']).toEqual(['*']);
    expect(config.links['skill-b']).toEqual(['claude']);
  });

  it('saves wildcard when all agents selected', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills', hermes: '~/.hermes/skills' },
      links: {},
      servers: {},
      sources: {}
    };

    applyMatrixToLinks(config, {
      cancelled: false,
      selected: { 'skill-a': ['claude', 'hermes'] }
    });

    expect(config.links['skill-a']).toEqual(['*']);
  });

  it('removes link when no agents selected', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['claude'] },
      servers: {},
      sources: {}
    };

    applyMatrixToLinks(config, {
      cancelled: false,
      selected: { 'skill-a': [] }
    });

    expect(config.links['skill-a']).toBeUndefined();
  });

  it('does not modify config when cancelled', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['claude'] },
      servers: {},
      sources: {}
    };

    applyMatrixToLinks(config, {
      cancelled: true,
      selected: { 'skill-a': [] }
    });

    expect(config.links['skill-a']).toEqual(['claude']);
  });
});

describe('editServers', () => {
  it('adds a new server to config', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {},
      sources: {}
    };

    const prompts = new PromptStub([
      'add',
      'myserver',
      'example.com',
      'root',
      '22',
      '',
      'back'
    ]) as unknown as PromptApi;

    await editServers(config, prompts);

    expect(config.servers['myserver']).toEqual({
      host: 'example.com',
      user: 'root',
      port: 22,
      remote_agents: {}
    });
  });

  it('adds a server with identity file', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {},
      sources: {}
    };

    const prompts = new PromptStub([
      'add',
      'secure-server',
      'secure.example.com',
      'admin',
      '2222',
      '~/.ssh/id_rsa',
      'back'
    ]) as unknown as PromptApi;

    await editServers(config, prompts);

    expect(config.servers['secure-server']).toEqual({
      host: 'secure.example.com',
      user: 'admin',
      port: 2222,
      identity_file: '~/.ssh/id_rsa',
      remote_agents: {}
    });
  });

  it('removes a server from config', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {
        'old-server': { host: 'old.example.com', user: 'root', port: 22, remote_agents: {} }
      },
      sources: {}
    };

    const prompts = new PromptStub([
      'old-server',
      'remove',
      true,
      'back'
    ]) as unknown as PromptApi;

    await editServers(config, prompts);

    expect(config.servers['old-server']).toBeUndefined();
  });
});

describe('applyMatrixToRemote', () => {
  it('updates server skills.include from matrix selection', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['*'], 'skill-b': ['*'] },
      servers: {
        server1: { host: 'a.com', remote_agents: {} },
        server2: { host: 'b.com', remote_agents: {} }
      },
      sources: {}
    };

    applyMatrixToRemote(config, {
      cancelled: false,
      selected: { 'skill-a': ['server1', 'server2'], 'skill-b': ['server1'] }
    });

    expect((config.servers.server1 as Record<string, unknown>).skills).toEqual({ include: ['skill-a', 'skill-b'] });
    expect((config.servers.server2 as Record<string, unknown>).skills).toEqual({ include: ['skill-a'] });
  });

  it('removes skills from server when no skills selected', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {
        server1: { host: 'a.com', remote_agents: {}, skills: { include: ['old-skill'] } }
      },
      sources: {}
    };

    applyMatrixToRemote(config, {
      cancelled: false,
      selected: {}
    });

    expect((config.servers.server1 as Record<string, unknown>).skills).toBeUndefined();
  });

  it('does not modify config when cancelled', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {
        server1: { host: 'a.com', remote_agents: {}, skills: { include: ['existing'] } }
      },
      sources: {}
    };

    applyMatrixToRemote(config, {
      cancelled: true,
      selected: {}
    });

    expect((config.servers.server1 as Record<string, unknown>).skills).toEqual({ include: ['existing'] });
  });
});

describe('parseSSHConfig', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function createTestHome(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-ssh-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.ssh'), { recursive: true });
    return homeDir;
  }

  it('parses exact host match with HostName, User, Port, IdentityFile', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host myserver
  HostName 192.168.1.100
  User admin
  Port 2222
  IdentityFile ~/.ssh/id_myserver
`);

    const result = await parseSSHConfig('myserver', homeDir);
    expect(result).toEqual({
      hostname: '192.168.1.100',
      user: 'admin',
      port: 2222,
      identityFile: join(homeDir, '.ssh/id_myserver')
    });
  });

  it('parses wildcard pattern *.example.com', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host *.example.com
  User deploy
  Port 22
`);

    const result = await parseSSHConfig('server.example.com', homeDir);
    expect(result).toEqual({
      user: 'deploy',
      port: 22
    });
  });

  it('handles regex special chars in pattern (e.g., host.name)', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host server.prod
  HostName 10.0.0.1
  User root
`);

    // Exact match should work
    const result = await parseSSHConfig('server.prod', homeDir);
    expect(result).toEqual({
      hostname: '10.0.0.1',
      user: 'root'
    });

    // Similar name without dot should NOT match
    const noMatch = await parseSSHConfig('serverprod', homeDir);
    expect(noMatch).toBeNull();
  });

  it('returns null when host not found', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host other-server
  HostName 10.0.0.2
`);

    const result = await parseSSHConfig('myserver', homeDir);
    expect(result).toBeNull();
  });

  it('returns null when ~/.ssh/config missing', async () => {
    const homeDir = await createTestHome();
    // Don't create config file

    const result = await parseSSHConfig('myserver', homeDir);
    expect(result).toBeNull();
  });

  it('ignores global wildcard Host *', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host *
  User globaluser

Host myserver
  HostName specific.host
`);

    const result = await parseSSHConfig('myserver', homeDir);
    // Should only get HostName from myserver block, not User from * block
    expect(result).toEqual({
      hostname: 'specific.host'
    });
  });

  it('handles multiple Host patterns on same line', async () => {
    const homeDir = await createTestHome();
    await writeFile(join(homeDir, '.ssh', 'config'), `
Host server1 server2 server3
  User shareduser
  Port 3333
`);

    const result1 = await parseSSHConfig('server1', homeDir);
    const result2 = await parseSSHConfig('server2', homeDir);
    const result3 = await parseSSHConfig('server3', homeDir);

    expect(result1).toEqual({ user: 'shareduser', port: 3333 });
    expect(result2).toEqual({ user: 'shareduser', port: 3333 });
    expect(result3).toEqual({ user: 'shareduser', port: 3333 });
  });
});
