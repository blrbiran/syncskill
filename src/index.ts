#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';

import { applyResolution, reconcileManifest } from './conflict.js';
import { loadConfig, parseConfigValue, saveConfig, setConfigValue } from './config.js';
import { runConfigUi } from './config-ui.js';
import { collectLinkStatus, linkConfiguredSkills, scanSkills, unlinkSkill } from './linker.js';
import { loadServerManifest, saveServerManifest } from './manifest.js';
import { initializeRepo } from './repo.js';
import { formatDiffLines, formatStatusLines, listTrackedServers, loadTrackedManifests } from './refresh.js';

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');

  program
    .command('init')
    .description('Initialize the local syncskill repository')
    .option('--skip-sources', 'Skip migrating skills from detected source directories')
    .action(async (options: { skipSources?: boolean }) => {
      await initializeRepo(resolvedHomeDir, {
        skipSources: Boolean(options.skipSources)
      });
    });

  const configCommand = program.command('config').description('Manage syncskill config');

  configCommand.action(async () => {
    await runConfigUi(resolvedHomeDir);
  });

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
      const addedSkills = await scanSkills(resolvedHomeDir, {
        allAgents: Boolean(options.allAgents)
      });

      for (const skillName of addedSkills) {
        console.log(skillName);
      }
    });

  program
    .command('link [skill]')
    .description('Link configured skills into target agent directories')
    .option('--all', 'Link all configured skills')
    .option('--status', 'Show link status')
    .option('--unlink <skill>', 'Remove links for one skill')
    .action(async (skill: string | undefined, options: { all?: boolean; status?: boolean; unlink?: string }) => {
      if (options.status) {
        const statuses = await collectLinkStatus(resolvedHomeDir);

        for (const status of statuses) {
          console.log(`${status.skill}\t${status.agent}\t${status.state}`);
        }

        return;
      }

      if (typeof options.unlink === 'string') {
        await unlinkSkill(resolvedHomeDir, options.unlink);
        return;
      }

      if (options.all) {
        await linkConfiguredSkills(resolvedHomeDir, { all: true });
        return;
      }

      if (typeof skill === 'string') {
        await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skill });
        return;
      }

      throw new Error('link requires <skill>, --all, --status, or --unlink <skill>');
    });

  program
    .command('status')
    .description('Show reconciliation status for all tracked manifests')
    .action(async () => {
      const manifests = await loadTrackedManifests(resolvedHomeDir);

      for (const line of formatStatusLines(manifests)) {
        console.log(line);
      }
    });

  program
    .command('diff <server>')
    .description('Show pending reconciliation rows for one server')
    .action(async (server: string) => {
      const [manifest] = await loadTrackedManifests(resolvedHomeDir, server);

      if (!manifest) {
        return;
      }

      for (const line of formatDiffLines(manifest)) {
        console.log(line);
      }
    });

  program
    .command('resolve <skill>')
    .description('Resolve one tracked conflict by choosing local or remote state')
    .requiredOption(
      '--take <side>',
      'Choose which side to keep',
      (value: string) => {
        if (value === 'local' || value === 'remote') {
          return value;
        }

        throw new InvalidArgumentError('Expected local or remote');
      }
    )
    .action(async (skill: string, options: { take: 'local' | 'remote' }) => {
      const servers = await listTrackedServers(resolvedHomeDir);
      const updatedAt = new Date().toISOString();
      let resolved = false;

      for (const server of servers) {
        const manifest = await loadServerManifest(resolvedHomeDir, server);
        const reconciled = reconcileManifest(manifest);
        const current = reconciled.skills[skill];

        if (!current || current.direction !== 'conflict') {
          continue;
        }

        const updatedManifest = applyResolution(reconciled, skill, options.take, updatedAt);
        await saveServerManifest(resolvedHomeDir, updatedManifest);

        const updatedSkill = updatedManifest.skills[skill];
        console.log(`${skill}\t${server}\t${updatedSkill.direction}\t${updatedSkill.status}`);
        resolved = true;
      }

      if (!resolved) {
        throw new Error(`No tracked conflict found for skill: ${skill}`);
      }
    });

  return program;
}

const entryArg = process.argv[1];

if (typeof entryArg === 'string' && import.meta.url.endsWith(entryArg)) {
  createProgram().parse(process.argv);
}
