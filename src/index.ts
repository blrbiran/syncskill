#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { select, confirm } from '@inquirer/prompts';

import { applyResolution, formatConflictMarker, reconcileManifest } from './conflict.js';
import { getConfigPaths, getSyncPaths, loadConfig, parseConfigValue, saveConfig, setConfigValue } from './config.js';
import { createPromptApi, runConfigUi } from './config-ui.js';
import { collectLinkStatus, discoverSkills, linkConfiguredSkills, unlinkSkill } from './linker.js';
import { listLocalSkillNames, loadServerManifest, saveServerManifest } from './manifest.js';
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
import {
  addSourceFromUrl,
  buildSkillsIndex,
  findOrphanSkills,
  formatSourceListLines,
  listSources,
  loadSkillOwnershipState,
  RemovalAction,
  removeSource,
  saveSkillsIndex,
  SourceType,
  updateAllSources,
  updateSource,
} from './source.js';
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

  const skipCommands = [
    'init',
    'config',
    'config show',
    'config set',
    'config link',
    'config server',
    'config remote',
    'refresh'
  ];
  return skipCommands.includes(commandPath.join(' '));
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
    .command('set [key] [value]')
    .description('Set a config value')
    .option('--show-paths', 'Show all valid config paths')
    .action(async (key: string | undefined, value: string | undefined, options: { showPaths?: boolean }) => {
      const current = await loadConfig(homeDir);

      if (options.showPaths) {
        for (const { path, value: configValue } of getConfigPaths(current)) {
          console.log(`${path}\t${JSON.stringify(configValue)}`);
        }
        return;
      }

      if (key === undefined || value === undefined) {
        throw new Error('config set requires <key> and <value>, or use --show-paths');
      }

      const parsed = parseConfigValue(value);
      const next = setConfigValue(current, key, parsed);
      await saveConfig(next, homeDir);
    });

  configCommand
    .command('link')
    .description('Edit skill → agent links (matrix editor)')
    .action(async () => {
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
    });

  configCommand
    .command('server')
    .description('Manage remote servers')
    .action(async () => {
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'server' });
    });

  configCommand
    .command('remote')
    .description('Edit skill → server sync mapping (matrix editor)')
    .action(async () => {
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'remote' });
    });

  program
    .command('discover')
    .description('Discover skills in ~/.syncskill/skills/ and configured sources, register to config links')
    .option('--all-agents', 'Link new skills to all configured agents')
    .action(async (options: { allAgents?: boolean }) => {
      const addedSkills = await discoverSkills(resolvedHomeDir, {
        allAgents: Boolean(options.allAgents)
      });

      for (const skillName of addedSkills) {
        console.log(skillName);
      }

      // Generate skills-index.json
      const index = await buildSkillsIndex(resolvedHomeDir);
      await saveSkillsIndex(resolvedHomeDir, index);
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
    .command('add <nameOrUrl>')
    .description('Add a source (supports GitHub URL direct parsing)')
    .option('--type <type>', 'Source type (git, http, local)', (value: string) => {
      if (value === 'local' || value === 'git' || value === 'http') {
        return value as SourceType;
      }
      throw new InvalidArgumentError('Expected local, git, or http');
    })
    .option('--url <url>', 'Source URL (if different from first argument)')
    .option('--store <store>', 'Materialized store path')
    .option('--skill-subdir <dir>', 'Subdirectory within source containing skills')
    .option('--ref <ref>', 'Git ref (branch/tag)')
    .action(async (nameOrUrl: string, options: {
      type?: SourceType;
      url?: string;
      store?: string;
      skillSubdir?: string;
      ref?: string;
    }) => {
      const { name } = await addSourceFromUrl(resolvedHomeDir, options.url ?? nameOrUrl, {
        name: options.url ? nameOrUrl : undefined,
        type: options.type,
        store: options.store,
        skillSubdir: options.skillSubdir,
        ref: options.ref
      });

      console.log(`Added source: ${name}`);
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

  sourceCommand
    .command('remove <name>')
    .description('Remove a configured source')
    .option('--force', 'Skip confirmation prompts')
    .action(async (name: string, options: { force?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      const sourceRaw = config.sources[name];

      if (!sourceRaw) {
        console.error(`Source not found: ${name}`);
        process.exit(1);
      }

      // Extract source type from the raw config object
      const sourceType = (sourceRaw as Record<string, unknown>).type;
      const isGitSource = sourceType === 'git';

      const ownershipState = await loadSkillOwnershipState(resolvedHomeDir);
      const localSkills = new Set(await listLocalSkillNames(resolvedHomeDir));
      const orphans = findOrphanSkills(name, config, ownershipState, localSkills);

      // Show affected skills
      const ownedSkills = Object.entries(ownershipState.owners)
        .filter(([, owner]) => owner === name)
        .map(([skill]) => skill);

      if (ownedSkills.length > 0) {
        console.log(`\nSkills provided by source "${name}":`);
        for (const skill of ownedSkills) {
          const isOrphan = orphans.includes(skill);
          console.log(`  - ${skill}${isOrphan ? ' (orphan - only from this source)' : ''}`);
        }
        console.log('');
      } else {
        console.log(`\nSource "${name}" provides no skills.\n`);
      }

      let action: RemovalAction;

      if (options.force) {
        action = RemovalAction.RemoveAll;
      } else if (isGitSource) {
        // Git source: 3 options
        const choice = await select({
          message: `How do you want to remove source "${name}"?`,
          choices: [
            {
              name: 'Convert to local source (keep files, no more git updates)',
              value: RemovalAction.ConvertToLocal,
            },
            {
              name: 'Remove config + links only (keep skill files on disk)',
              value: RemovalAction.RemoveConfigKeepFiles,
            },
            {
              name: 'Remove everything (config, links, and skill files)',
              value: RemovalAction.RemoveAll,
            },
          ],
        });
        action = choice;
      } else {
        // HTTP/Local source: 2 options
        const choice = await select({
          message: `How do you want to remove source "${name}"?`,
          choices: [
            {
              name: 'Remove config + links only (keep skill files on disk)',
              value: RemovalAction.RemoveConfigKeepFiles,
            },
            {
              name: 'Remove everything (config, links, and skill files)',
              value: RemovalAction.RemoveAll,
            },
          ],
        });
        action = choice;
      }

      // Double confirmation for destructive actions
      if (action === RemovalAction.RemoveAll && orphans.length > 0) {
        const confirmed = await confirm({
          message: `This will permanently delete ${orphans.length} orphan skill(s). Continue?`,
          default: false,
        });
        if (!confirmed) {
          console.log('Cancelled.');
          return;
        }
      }

      await removeSource(resolvedHomeDir, name, { action });

      switch (action) {
        case RemovalAction.ConvertToLocal:
          console.log(`Converted source "${name}" to local type.`);
          break;
        case RemovalAction.RemoveConfigKeepFiles:
          console.log(`Removed source "${name}" (skill files kept on disk).`);
          break;
        case RemovalAction.RemoveAll:
          console.log(`Removed source "${name}" and all associated files.`);
          break;
      }
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
    .option('--all', 'Refresh both local and remote (default when no flags)')
    .option('--local', 'Refresh local manifest state')
    .option('--remote', 'Refresh remote manifest state')
    .option('--status', 'Show refreshed status rows')
    .action(async (server: string | undefined, options: { all?: boolean; local?: boolean; remote?: boolean; status?: boolean }) => {
      const manifests = await refreshStoredManifests(resolvedHomeDir, {
        all: Boolean(options.all),
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
    .option(
      '--take <side>',
      'Choose which side to keep',
      (value: string) => {
        if (value === 'local' || value === 'remote') {
          return value;
        }

        throw new InvalidArgumentError('Expected local or remote');
      }
    )
    .option('--manual', 'Create .sync-conflict marker file for manual resolution')
    .action(async (skill: string, options: { take?: 'local' | 'remote'; manual?: boolean }) => {
      if (!options.take && !options.manual) {
        throw new Error('resolve requires --take <local|remote> or --manual');
      }

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

        if (options.manual) {
          const { skillsDir } = getSyncPaths(resolvedHomeDir);
          const skillDir = join(skillsDir, skill);
          await mkdir(skillDir, { recursive: true });
          const markerPath = join(skillDir, '.sync-conflict');
          const markerContent = formatConflictMarker({
            skill,
            server,
            local_hash: current.local_hash ?? '',
            remote_hash: current.remote_hash ?? '',
            created_at: updatedAt
          });
          await writeFile(markerPath, markerContent, 'utf8');
          console.log(`Created conflict marker: ${markerPath}`);
          resolved = true;
          continue;
        }

        const updatedManifest = applyResolution(reconciled, skill, options.take!, updatedAt);
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

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const entryArg = process.argv[1];

if (typeof entryArg === 'string') {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entryFile = realpathSync(entryArg);

    if (thisFile === entryFile) {
      createProgram().parse(process.argv);
    }
  } catch {
    // Ignore errors from realpath (e.g., file not found)
  }
}
