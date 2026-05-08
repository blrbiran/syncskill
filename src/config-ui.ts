import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { ExitPromptError } from '@inquirer/core';

import type { ConflictResolution, SyncSkillConfig } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import { listLocalSkills } from './linker.js';
import { createMatrixEditor, type MatrixEditorResult } from './matrix-editor.js';

export interface PromptApi {
  select<T>(options: { message: string; choices: Array<{ name: string; value: T }> }): Promise<T>;
  input(options: { message: string; default?: string }): Promise<string>;
  checkbox<T>(options: { message: string; choices: Array<{ name: string; value: T; checked?: boolean }> }): Promise<T[]>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

export function createPromptApi(): PromptApi {
  return {
    select,
    input,
    checkbox,
    confirm
  };
}

export interface SafeSelectResult<T> {
  escaped: boolean;
  value?: T;
}

export async function safeSelect<T>(
  prompts: PromptApi,
  options: { message: string; choices: Array<{ name: string; value: T }> }
): Promise<SafeSelectResult<T>> {
  try {
    const value = await prompts.select(options);
    return { escaped: false, value };
  } catch (error) {
    if (error instanceof ExitPromptError) {
      return { escaped: true };
    }
    throw error;
  }
}

export async function editAgents(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: 'Edit agents',
      choices: [
        { name: 'Add', value: 'add' as const },
        { name: 'Remove', value: 'remove' as const },
        { name: 'Back', value: 'back' as const }
      ]
    });

    if (action === 'back') {
      return;
    }

    if (action === 'add') {
      const name = await prompts.input({ message: 'Agent name' });
      const dir = await prompts.input({ message: 'Agent directory' });
      config.agents[name] = dir;
      continue;
    }

    const agentNames = Object.keys(config.agents).sort();
    if (agentNames.length === 0) {
      continue;
    }

    const agentToRemove = await prompts.select({
      message: 'Remove agent',
      choices: agentNames.map((agentName) => ({ name: agentName, value: agentName }))
    });
    const confirmed = await prompts.confirm({ message: `Remove agent "${agentToRemove}"?`, default: false });
    if (confirmed) {
      delete config.agents[agentToRemove];
    }
  }
}

export async function editLinks(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: 'Edit links',
      choices: [
        { name: 'Add or edit', value: 'edit' as const },
        { name: 'Remove', value: 'remove' as const },
        { name: 'Back', value: 'back' as const }
      ]
    });

    if (action === 'back') {
      return;
    }

    if (action === 'edit') {
      const skill = await prompts.input({ message: 'Skill name' });
      const currentTargets = config.links[skill] ?? [];
      const targets = await prompts.checkbox({
        message: 'Target agents',
        choices: [
          { name: '*', value: '*', checked: currentTargets.includes('*') },
          ...Object.keys(config.agents)
            .sort()
            .map((agentName) => ({
              name: agentName,
              value: agentName,
              checked: currentTargets.includes(agentName)
            }))
        ]
      });
      config.links[skill] = targets;
      continue;
    }

    const skills = Object.keys(config.links).sort();
    if (skills.length === 0) {
      continue;
    }

    const skillToRemove = await prompts.select({
      message: 'Remove link mapping',
      choices: skills.map((skill) => ({ name: skill, value: skill }))
    });
    const confirmed = await prompts.confirm({ message: `Remove link mapping for "${skillToRemove}"?`, default: false });
    if (confirmed) {
      delete config.links[skillToRemove];
    }
  }
}

export function applyMatrixToLinks(config: SyncSkillConfig, result: MatrixEditorResult): void {
  if (result.cancelled) {
    return;
  }

  const allAgents = Object.keys(config.agents).sort();

  for (const [skill, agents] of Object.entries(result.selected)) {
    if (agents.length === 0) {
      delete config.links[skill];
    } else if (agents.length === allAgents.length && allAgents.every((a) => agents.includes(a))) {
      config.links[skill] = ['*'];
    } else {
      config.links[skill] = agents.sort();
    }
  }
}

export async function editLinksMatrix(config: SyncSkillConfig, homeDir: string): Promise<MatrixEditorResult> {
  const skills = await listLocalSkills(homeDir);
  const agents = Object.keys(config.agents).sort();

  const selected: Record<string, string[]> = {};
  for (const skill of skills) {
    const targets = config.links[skill] ?? [];
    selected[skill] = targets.includes('*') ? [...agents] : targets.filter((t) => agents.includes(t));
  }

  const matrixEditor = createMatrixEditor();
  return matrixEditor({
    title: 'Skills → Agent Assignment',
    rows: skills,
    columns: agents,
    selected
  });
}

export async function editConflictResolution(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  config.conflict_resolution = await prompts.select<ConflictResolution>({
    message: 'Conflict resolution',
    choices: [
      { name: 'manual', value: 'manual' },
      { name: 'keep-local', value: 'keep-local' },
      { name: 'keep-remote', value: 'keep-remote' }
    ]
  });
}

async function editRemoteAgents(server: Record<string, unknown>, prompts: PromptApi): Promise<void> {
  const remoteAgents = (server.remote_agents as Record<string, string>) ?? {};
  server.remote_agents = remoteAgents;

  while (true) {
    const agentNames = Object.keys(remoteAgents).sort();
    const choices = [
      { name: '+ Add agent', value: 'add' as const },
      ...agentNames.map((name) => ({ name: `${name}: ${remoteAgents[name]}`, value: name })),
      { name: '← Back', value: 'back' as const }
    ];

    const result = await safeSelect(prompts, { message: 'Remote agents', choices });

    if (result.escaped || result.value === 'back') {
      return;
    }

    if (result.value === 'add') {
      const name = await prompts.input({ message: 'Agent name' });
      const path = await prompts.input({ message: 'Agent directory' });
      remoteAgents[name] = path;
      continue;
    }

    const agentToEdit = result.value as string;
    const editResult = await safeSelect(prompts, {
      message: `Edit agent: ${agentToEdit}`,
      choices: [
        { name: 'Edit path', value: 'edit' as const },
        { name: 'Remove', value: 'remove' as const },
        { name: '← Back', value: 'back' as const }
      ]
    });

    if (editResult.escaped || editResult.value === 'back') {
      continue;
    }

    if (editResult.value === 'remove') {
      delete remoteAgents[agentToEdit];
    } else if (editResult.value === 'edit') {
      remoteAgents[agentToEdit] = await prompts.input({
        message: 'Agent directory',
        default: remoteAgents[agentToEdit]
      });
    }
  }
}

async function editSingleServer(
  config: SyncSkillConfig,
  serverName: string,
  prompts: PromptApi
): Promise<void> {
  while (true) {
    const result = await safeSelect(prompts, {
      message: `Edit server: ${serverName}`,
      choices: [
        { name: 'Edit connection', value: 'edit' as const },
        { name: 'Configure remote agents', value: 'agents' as const },
        { name: 'Remove server', value: 'remove' as const },
        { name: '← Back', value: 'back' as const }
      ]
    });

    if (result.escaped || result.value === 'back') {
      return;
    }

    const server = config.servers[serverName] as Record<string, unknown>;

    if (result.value === 'remove') {
      const confirmed = await prompts.confirm({ message: `Remove ${serverName}?`, default: false });
      if (confirmed) {
        delete config.servers[serverName];
        return;
      }
      continue;
    }

    if (result.value === 'edit') {
      server.host = await prompts.input({ message: 'Host', default: server.host as string });
      server.user = await prompts.input({ message: 'User', default: (server.user as string) ?? 'root' });
      const portStr = await prompts.input({ message: 'Port', default: String(server.port ?? 22) });
      server.port = parseInt(portStr, 10);
      const identityFile = await prompts.input({
        message: 'Identity file (optional)',
        default: (server.identity_file as string) ?? ''
      });
      if (identityFile) {
        server.identity_file = identityFile;
      } else {
        delete server.identity_file;
      }
      continue;
    }

    if (result.value === 'agents') {
      await editRemoteAgents(server, prompts);
    }
  }
}

export async function editServers(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const serverNames = Object.keys(config.servers).sort();
    const choices = [
      { name: '+ Add server', value: 'add' as const },
      ...serverNames.map((name) => ({ name, value: name })),
      { name: '← Back', value: 'back' as const }
    ];

    const result = await safeSelect(prompts, { message: 'Manage servers', choices });

    if (result.escaped || result.value === 'back') {
      return;
    }

    if (result.value === 'add') {
      const name = await prompts.input({ message: 'Server name' });
      const host = await prompts.input({ message: 'Host' });
      const user = await prompts.input({ message: 'User', default: 'root' });
      const portStr = await prompts.input({ message: 'Port', default: '22' });
      const identityFile = await prompts.input({ message: 'Identity file (optional)' });

      const server: Record<string, unknown> = {
        host,
        user,
        port: parseInt(portStr, 10),
        remote_agents: {}
      };

      if (identityFile) {
        server.identity_file = identityFile;
      }

      config.servers[name] = server;
      continue;
    }

    await editSingleServer(config, result.value as string, prompts);
  }
}

export function applyMatrixToRemote(config: SyncSkillConfig, result: MatrixEditorResult): void {
  if (result.cancelled) {
    return;
  }

  const serverSkills: Record<string, string[]> = {};

  for (const [skill, servers] of Object.entries(result.selected)) {
    for (const server of servers) {
      if (!serverSkills[server]) {
        serverSkills[server] = [];
      }
      serverSkills[server].push(skill);
    }
  }

  for (const serverName of Object.keys(config.servers)) {
    const server = config.servers[serverName] as Record<string, unknown>;
    const skills = serverSkills[serverName]?.sort() ?? [];

    if (skills.length > 0) {
      server.skills = { include: skills };
    } else {
      delete server.skills;
    }
  }
}

export async function editRemoteMatrix(config: SyncSkillConfig, homeDir: string): Promise<MatrixEditorResult> {
  const skills = await listLocalSkills(homeDir);
  const servers = Object.keys(config.servers).sort();

  const selected: Record<string, string[]> = {};

  for (const skill of skills) {
    selected[skill] = [];
    for (const serverName of servers) {
      const server = config.servers[serverName] as Record<string, unknown>;
      const serverSkills = server.skills as { include?: string[] } | undefined;
      if (serverSkills?.include?.includes(skill)) {
        selected[skill].push(serverName);
      }
    }
  }

  const matrixEditor = createMatrixEditor();
  return matrixEditor({
    title: 'Skills → Server Sync Mapping',
    rows: skills,
    columns: servers,
    selected
  });
}

export async function editRemote(config: SyncSkillConfig, homeDir: string): Promise<void> {
  const servers = Object.keys(config.servers);

  if (servers.length === 0) {
    console.log('No servers configured. Add servers first with "config server".');
    return;
  }

  const result = await editRemoteMatrix(config, homeDir);
  applyMatrixToRemote(config, result);
}

export interface RunConfigUiOptions {
  directEntry?: 'link' | 'server' | 'remote';
}

export async function runConfigUi(
  homeDir: string,
  prompts: PromptApi = createPromptApi(),
  options: RunConfigUiOptions = {}
): Promise<void> {
  const config = await loadConfig(homeDir);

  if (options.directEntry === 'link') {
    const result = await editLinksMatrix(config, homeDir);
    applyMatrixToLinks(config, result);
    await saveConfig(config, homeDir);
    return;
  }

  if (options.directEntry === 'server') {
    await editServers(config, prompts);
    await saveConfig(config, homeDir);
    return;
  }

  if (options.directEntry === 'remote') {
    await editRemote(config, homeDir);
    await saveConfig(config, homeDir);
    return;
  }

  while (true) {
    const result = await safeSelect(prompts, {
      message: 'Choose a config section',
      choices: [
        { name: 'agents', value: 'agents' as const },
        { name: 'links', value: 'links' as const },
        { name: 'servers', value: 'servers' as const },
        { name: 'remote', value: 'remote' as const },
        { name: 'conflict_resolution', value: 'conflict_resolution' as const },
        { name: 'done', value: 'done' as const }
      ]
    });

    if (result.escaped || result.value === 'done') {
      await saveConfig(config, homeDir);
      break;
    }

    if (result.value === 'agents') {
      await editAgents(config, prompts);
      await saveConfig(config, homeDir);
      continue;
    }

    if (result.value === 'links') {
      await editLinks(config, prompts);
      await saveConfig(config, homeDir);
      continue;
    }

    if (result.value === 'servers') {
      await editServers(config, prompts);
      await saveConfig(config, homeDir);
      continue;
    }

    if (result.value === 'remote') {
      await editRemote(config, homeDir);
      await saveConfig(config, homeDir);
      continue;
    }

    if (result.value === 'conflict_resolution') {
      await editConflictResolution(config, prompts);
      await saveConfig(config, homeDir);
    }
  }
}
