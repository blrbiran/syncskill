#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';

import { applyResolution, reconcileManifest } from './conflict.js';
import { loadConfig, parseConfigValue, saveConfig, setConfigValue } from './config.js';
import { runConfigUi } from './config-ui.js';
import { collectLinkStatus, linkConfiguredSkills, scanSkills, unlinkSkill } from './linker.js';
import { loadServerManifest, saveServerManifest } from './manifest.js';
import { formatProbeLines, formatServerListLines, formatServerShowLines, listServers, probeServer, showServer } from './server.js';
import { initializeRepo } from './repo.js';
import {
  autoRefreshManifests,
  formatDiffLines,
  formatStatusLines,
  listTrackedServers,
  loadTrackedManifests,
  refreshStoredManifests
} from './refresh.js';
import { addSource, formatSourceListLines, listSources, SourceType, updateAllSources, updateSource } from './source.js';
import { pullFromServer, pushToServers, syncServers, type PullResult, type PushResult } from './sync_engine.js';

function shouldSkipAutoRefresh(command: Command): boolean {
  const commandPath: string[] = [];
  let current: Command | null = command;

  while (current && current.parent) {
    commandPath.unshift(current.name());
    current = current.parent;

    if (!current.parent) {
      break;
    }
  }

  return ['init', 'config', 'config show', 'config set', 'refresh'].includes(commandPath.join(' '));
}

function formatPullRows(result: PullResult): string[] {
  return [
    ...result.pulled_skills.map((skill: string) => `${skill}\t${result.server}\tpull\tin-sync`),
    ...result.conflicted_skills.map((skill: string) => `${skill}\t${result.server}\tconflict\tconflict`)
  ];
}

function formatPushRows(result: PushResult): string[] {
  return [
    ...result.pushed_skills.map((skill: string) => `${skill}\t${result.server}\tpush\tin-sync`),
    ...result.conflicted_skills.map((skill: string) => `${skill}\t${result.server}\tconflict\tconflict`)
  ];
}

function formatSkillRows(action: 'pull', result: PullResult): string[];
function formatSkillRows(action: 'push', result: PushResult): string[];
function formatSkillRows(action: 'pull' | 'push', result: PullResult | PushResult): string[] {
  return action === 'pull' ? formatPullRows(result as PullResult) : formatPushRows(result as PushResult);
}

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool')
    .option('--no-refresh', 'Skip automatic manifest refresh before commands')
    .hook('preAction', async (_thisCommand, actionCommand) => {
      if (shouldSkipAutoRefresh(actionCommand)) {
        return;
      }

      await autoRefreshManifests(resolvedHomeDir, program.opts<{ refresh: boolean }>().refresh);
    });

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

  const sourceCommand = program.command('source').description('Manage configured sources');

  sourceCommand
    .command('add <name>')
    .description('Add a source and materialize it immediately')
    .requiredOption(
      '--type <type>',
      'Source type',
      (value: string) => {
        if (value === 'local' || value === 'git' || value === 'http') {
          return value as SourceType;
        }

        throw new InvalidArgumentError('Expected local, git, or http');
      }
    )
    .requiredOption('--url <url>', 'Source URL')
    .requiredOption('--store <store>', 'Materialized store path')
    .option('--ref <ref>', 'Source revision')
    .action(async (name: string, options: { type: SourceType; url: string; store: string; ref?: string }) => {
      const source = {
        type: options.type,
        url: options.url,
        store: options.store,
        ...(typeof options.ref === 'string' ? { ref: options.ref } : {})
      };

      await addSource(resolvedHomeDir, name, source);
    });

  sourceCommand
    .command('list')
    .description('List configured sources')
    .action(async () => {
      for (const line of formatSourceListLines(await listSources(resolvedHomeDir))) {
        console.log(line);
      }
    });

  sourceCommand
    .command('update [name]')
    .description('Update one source or all configured sources')
    .option('--all', 'Update all configured sources')
    .action(async (name: string | undefined, options: { all?: boolean }) => {
      if (options.all || name === undefined) {
        await updateAllSources(resolvedHomeDir);
        return;
      }

      await updateSource(resolvedHomeDir, name);
    });

  const serverCommand = program.command('server').description('Inspect configured remote servers');

  serverCommand
    .command('list')
    .description('List configured remote servers')
    .action(async () => {
      for (const line of formatServerListLines(await listServers(resolvedHomeDir))) {
        console.log(line);
      }
    });

  serverCommand
    .command('show <name>')
    .description('Show configured details for one remote server')
    .action(async (name: string) => {
      for (const line of formatServerShowLines(await showServer(resolvedHomeDir, name))) {
        console.log(line);
      }
    });

  serverCommand
    .command('probe <name>')
    .description('Probe remote access for one configured server')
    .action(async (name: string) => {
      const results = await probeServer(resolvedHomeDir, name);

      for (const line of formatProbeLines(results)) {
        console.log(line);
      }

      if (results.some((result) => !result.ok)) {
        throw new Error(`Server probe failed: ${name}`);
      }
    });

  program
    .command('refresh [server]')
    .description('Refresh tracked manifests from local and remote sources')
    .option('--local', 'Refresh local manifest state')
    .option('--remote', 'Refresh remote manifest state')
    .option('--status', 'Show refreshed status rows')
    .action(async (server: string | undefined, options: { local?: boolean; remote?: boolean; status?: boolean }) => {
      const manifests = await refreshStoredManifests(resolvedHomeDir, {
        local: Boolean(options.local),
        remote: Boolean(options.remote),
        server
      });

      if (options.status) {
        for (const line of formatStatusLines(manifests)) {
          console.log(line);
        }
      }
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

  program
    .command('push [server]')
    .description('Push local skill changes to one server or all configured servers')
    .option('--all', 'Push to all configured servers')
    .action(async (server: string | undefined, options: { all?: boolean }) => {
      const servers = options.all || server === undefined ? undefined : [server];
      const results = await pushToServers(resolvedHomeDir, servers);

      for (const result of results) {
        for (const line of formatSkillRows('push', result)) {
          console.log(line);
        }
      }
    });

  program
    .command('pull <server>')
    .description('Pull remote skill changes from one server')
    .action(async (server: string) => {
      const result = await pullFromServer(resolvedHomeDir, server);

      for (const line of formatSkillRows('pull', result)) {
        console.log(line);
      }
    });

  program
    .command('sync [server]')
    .description('Pull then push changes for one server or all configured servers')
    .option('--all', 'Sync all configured servers')
    .action(async (server: string | undefined, options: { all?: boolean }) => {
      const servers = options.all || server === undefined ? undefined : [server];
      const results = await syncServers(resolvedHomeDir, servers);

      for (const result of results) {
        for (const line of formatSkillRows('pull', result.pull)) {
          console.log(line);
        }
      }

      for (const result of results) {
        for (const line of formatSkillRows('push', result.push)) {
          console.log(line);
        }
      }
    });

  return program;
}

const entryArg = process.argv[1];

if (typeof entryArg === 'string' && import.meta.url.endsWith(entryArg)) {
  createProgram().parse(process.argv);
}
