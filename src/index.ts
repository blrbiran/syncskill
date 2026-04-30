#!/usr/bin/env node

import { Command } from 'commander';

import { loadConfig, parseConfigValue, saveConfig, setConfigValue } from './config.js';
import { scanSkills } from './linker.js';
import { initializeRepo } from './repo.js';

export function createProgram(homeDir?: string): Command {
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');

  program
    .command('init')
    .description('Initialize the local syncskill repository')
    .option('--skip-sources', 'Skip migrating skills from detected source directories')
    .action(async (options: { skipSources?: boolean }) => {
      await initializeRepo(homeDir ?? process.env.HOME ?? '', {
        skipSources: Boolean(options.skipSources)
      });
    });

  const configCommand = program.command('config').description('Manage syncskill config');

  configCommand
    .command('show')
    .description('Show current config')
    .action(async () => {
      const config = await loadConfig(homeDir);
      console.log(JSON.stringify(config, null, 2));
    });

  configCommand
    .command('set <key> <value>')
    .description('Set a config value')
    .action(async (key: string, value: string) => {
      const current = await loadConfig(homeDir);
      const parsed = parseConfigValue(value);
      const next = setConfigValue(current, key, parsed);
      await saveConfig(next, homeDir);
    });

  program
    .command('scan')
    .description('Scan local skills and add missing links')
    .option('--all-agents', 'Link new skills to all configured agents')
    .action(async (options: { allAgents?: boolean }) => {
      const addedSkills = await scanSkills(homeDir ?? process.env.HOME ?? '', {
        allAgents: Boolean(options.allAgents)
      });

      for (const skillName of addedSkills) {
        console.log(skillName);
      }
    });

  return program;
}

const entryArg = process.argv[1];

if (typeof entryArg === 'string' && import.meta.url.endsWith(entryArg)) {
  createProgram().parse(process.argv);
}
