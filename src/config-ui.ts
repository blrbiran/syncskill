import { checkbox, confirm, input, select } from '@inquirer/prompts';

import type { ConflictResolution, SyncSkillConfig } from './config.js';
import { loadConfig, saveConfig } from './config.js';

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
    delete config.agents[agentToRemove];
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
    delete config.links[skillToRemove];
  }
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

export async function runConfigUi(homeDir: string, prompts: PromptApi = createPromptApi()): Promise<void> {
  const config = await loadConfig(homeDir);

  while (true) {
    const section = await prompts.select({
      message: 'Choose a config section',
      choices: [
        { name: 'agents', value: 'agents' as const },
        { name: 'links', value: 'links' as const },
        { name: 'conflict_resolution', value: 'conflict_resolution' as const },
        { name: 'done', value: 'done' as const }
      ]
    });

    if (section === 'done') {
      break;
    }

    if (section === 'agents') {
      await editAgents(config, prompts);
      continue;
    }

    if (section === 'links') {
      await editLinks(config, prompts);
      continue;
    }

    await editConflictResolution(config, prompts);
  }

  const shouldSave = await prompts.confirm({ message: 'Save changes?', default: true });
  if (shouldSave) {
    await saveConfig(config, homeDir);
  }
}
