#!/usr/bin/env node

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { checkbox, select, confirm } from '@inquirer/prompts';

interface SelectServersOptions {
  all?: boolean;
  yes?: boolean;
}

async function selectTargetServers(
  allServers: string[],
  server: string | undefined,
  options: SelectServersOptions,
  action: 'push' | 'pull'
): Promise<string[] | null> {
  if (options.all) {
    return allServers;
  }

  if (server) {
    return [server];
  }

  if (allServers.length === 0) {
    console.error('No servers configured.');
    process.exit(1);
    return null; // unreachable, but satisfies TypeScript
  }

  if (allServers.length === 1 || options.yes) {
    return allServers;
  }

  const message = action === 'push' ? 'Select servers to push:' : 'Select servers to pull from:';
  const selected = await checkbox({
    message,
    choices: [
      { name: 'All servers', value: '__all__', checked: true },
      ...allServers.map(s => ({ name: s, value: s }))
    ]
  });

  if (selected.includes('__all__')) {
    return allServers;
  }

  if (selected.length === 0) {
    console.log('No servers selected. Cancelled.');
    return null;
  }

  return selected;
}

import { applyResolution, reconcileManifest } from './core/conflict.js';
import {
  autoDiagnoseConfig,
  diagnoseConfig,
  formatDiagnosticReport,
  repairConfig,
  repairRegistry,
  isRegistryDiagnostic,
  type RepairOptions
} from './config/config-doctor.js';
import { installSyncskillSkill, installFromSource } from './install.js';
import { getConfigPaths, getSyncPaths, loadConfig, parseConfigValue, saveConfig, setConfigValue, type SyncSkillConfig } from './config/config.js';
import { createPromptApi, runConfigUi } from './config/config-ui.js';
import { collectLinkStatus, discoverSkills, findStaleLinks, findUnmanagedSkills, formatLinkStatusMatrix, linkConfiguredSkills, listLocalSkills, reconcileStaleLinks, unlinkSkill, type StaleLinksBySkill } from './linker.js';
import { listLocalSkillNames, loadServerManifest, saveServerManifest } from './core/manifest.js';
import { formatProbeLines, formatServerListLines, formatServerShowLines, listServers, probeServer, showServer } from './core/server.js';
import { initializeRepo } from './repo.js';
import { pathExists } from './utils/utils.js';
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
  DiscoveredSkill,
  findOrphanSkills,
  formatSourceListLines,
  listSources,
  loadSkillOwnershipState,
  RemovalAction,
  removeSource,
  saveSkillsIndex,
  scanSkillsInSource,
  SourceType,
  updateAllSources,
  updateSource,
} from './source.js';
import { pullFromServer, pullFromServers, pushToServers, syncServers, type PullResult, type PushResult } from './core/sync_engine.js';
import { formatDashboardSummary, loadDashboardSummary } from './dashboard.js';

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

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Expected an integer value');
  }
  return parsed;
}

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool. No args: show local dashboard summary')
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
    .option('--skip-scan', 'Skip migrating skills from detected agent directories')
    .option('--skip-skill', 'Skip installing syncskill skill')
    .option('-y, --yes', 'Accept all defaults')
    .action(async (options: { skipScan?: boolean; skipSkill?: boolean; yes?: boolean }) => {
      await initializeRepo(resolvedHomeDir, {
        skipScan: Boolean(options.skipScan),
        skipSkill: Boolean(options.skipSkill),
        yes: Boolean(options.yes)
      });
    });

  program
    .command('install [urlOrPath]')
    .alias('i')
    .description('Install skill(s). Use --self or "self" for built-in skill; URL/path for external source')
    .option('--self', 'Install built-in syncskill skill')
    .option('--name <name>', 'Source name (for URL/path)')
    .option('--path <path>', 'Storage path for source files')
    .option('--skill-subdir <dir>', 'Subdirectory within source containing skills')
    .option('--branch <branch>', 'Git branch')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (urlOrPath: string | undefined, options: {
      self?: boolean;
      name?: string;
      path?: string;
      skillSubdir?: string;
      branch?: string;
      yes?: boolean;
    }) => {
      if (!urlOrPath && !options.self) {
        program.commands.find(c => c.name() === 'install')?.help();
        return;
      }

      const selfPathExists = urlOrPath === 'self' ? await pathExists(resolve('./self')) : false;
      const isSelfInstall = options.self || (urlOrPath === 'self' && !selfPathExists);

      if (isSelfInstall) {
        const result = await installSyncskillSkill(resolvedHomeDir);

        if (result.alreadyInstalled) {
          console.log('syncskill skill already installed');
          return;
        }

        console.log(`✓ Installed syncskill skill to ${result.installedPath}`);
        if (result.linkedAgents && result.linkedAgents.length > 0) {
          console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
        }
        return;
      }

      if (!urlOrPath) {
        throw new Error('install requires a URL/path or use --self');
      }

      const result = await installFromSource(resolvedHomeDir, urlOrPath, {
        name: options.name,
        path: options.path,
        skillSubdir: options.skillSubdir,
        branch: options.branch,
        skipPrompt: options.yes,
        onSelectSkills: async (skills: DiscoveredSkill[], existingSkills: Set<string>) => {
          const available = skills.filter(s => !existingSkills.has(s.name));

          if (available.length === 0) {
            console.log('All skills from this source already exist.');
            return [];
          }

          if (options.yes) {
            return available.map(s => s.name);
          }

          console.log(`\nFound ${skills.length} skill(s):\n`);

          const selected = await checkbox({
            message: 'Select skills to install:',
            choices: available.map(s => ({
              name: `${s.name} (${s.relativePath})`,
              value: s.name,
              checked: true
            }))
          });

          return selected;
        }
      });

      if (result.installedSkills.length === 0) {
        console.log('No skills installed.');
        return;
      }

      console.log(`✓ Installed ${result.installedSkills.length} skill(s)`);
      if (result.linkedAgents.length > 0) {
        console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
      }
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
    .description('Edit skill → agent links (matrix editor) [deprecated: use "link" instead]')
    .action(async () => {
      console.log('Note: "config link" is deprecated. Use "syncskill link" instead.');
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
    .command('scan')
    .description('Scan for new skills in sources and ~/.syncskill/skills/, check for unmanaged agent skills')
    .option('--migrate', 'Migrate unmanaged skills from agent directories to ~/.syncskill/skills/')
    .option('--dry-run', 'Preview scan results without making changes')
    .action(async (options: { migrate?: boolean; dryRun?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      const isDryRun = Boolean(options.dryRun);

      if (isDryRun) {
        console.log('[dry-run] Scanning for skills...\n');
      }

      // Discover skills from sources and manual directory
      const addedSkills = await discoverSkills(resolvedHomeDir, {
        allAgents: true,
        dryRun: isDryRun
      });

      if (addedSkills.length > 0) {
        console.log(isDryRun ? 'Would add new skills from sources:' : 'Found new skills in sources:');
        for (const skillName of addedSkills) {
          console.log(`  + ${isDryRun ? 'Would add' : 'Added'} "${skillName}"`);
        }
      }

      // Check for unmanaged skills in agent directories
      const unmanagedRaw = await findUnmanagedSkills(resolvedHomeDir);

      // Deduplicate by skill name (same skill may exist in multiple agent directories)
      const seenNames = new Set<string>();
      const unmanaged = unmanagedRaw.filter((skill) => {
        if (seenNames.has(skill.name)) {
          return false;
        }
        seenNames.add(skill.name);
        return true;
      });

      if (unmanaged.length > 0) {
        console.log('\nFound unmanaged skills in agent directories:');
        for (const skill of unmanaged) {
          console.log(`  ${skill.path}`);
        }

        if (isDryRun) {
          if (options.migrate) {
            console.log(`\n[dry-run] Would migrate ${unmanaged.length} skill(s) to ~/.syncskill/skills/`);
          }
        } else if (options.migrate) {
          const confirmed = await confirm({
            message: `Migrate ${unmanaged.length} skill(s) to ~/.syncskill/skills/?`,
            default: true
          });

          if (confirmed) {
            const { skillsDir } = getSyncPaths(resolvedHomeDir);

            for (const skill of unmanaged) {
              const targetPath = join(skillsDir, skill.name);

              // Check if skill already exists in managed directory
              try {
                await stat(targetPath);
                console.log(`  ⚠ Skipping "${skill.name}" - already exists in managed skills`);
                continue;
              } catch {
                // Target doesn't exist, safe to copy
              }

              await cp(skill.path, targetPath, { recursive: true });
              console.log(`  ✓ Migrated "${skill.name}"`);
            }

            // Re-run scan to register migrated skills
            await discoverSkills(resolvedHomeDir, {
              allAgents: true
            });
          }
        } else {
          console.log('\nUse `syncskill scan --migrate` to migrate unmanaged skills.');
        }
      }

      // Generate skills-index.json (skip in dry-run mode)
      if (!isDryRun) {
        const index = await buildSkillsIndex(resolvedHomeDir);
        await saveSkillsIndex(resolvedHomeDir, index);
      }
    });

  program
    .command('link [skillOrSubcommand]')
    .description('Manage skill-to-agent links (auto-cleans stale links). No args: matrix editor; list/ls: show status')
    .option('--all', 'Link all configured skills')
    .option('--list', 'Show link status (use when skill named "list" exists)')
    .option('-v, --verbose', 'Show text status instead of symbols')
    .option('--dry-run', 'Preview changes without applying')
    .option('-y, --yes', 'Auto-confirm stale link removal')
    .action(async (skillOrSubcommand: string | undefined, options: { all?: boolean; list?: boolean; verbose?: boolean; dryRun?: boolean; yes?: boolean }) => {
      // Auto-check config health
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      // Check if argument is 'list' or 'ls' subcommand
      const isListSubcommand = skillOrSubcommand === 'list' || skillOrSubcommand === 'ls';

      // If --list flag is used OR argument is list/ls (and not a skill name)
      if (options.list || isListSubcommand) {
        // If it looks like a subcommand, check if a skill with that name exists
        if (isListSubcommand) {
          const skills = await listLocalSkills(resolvedHomeDir);
          if (skills.includes(skillOrSubcommand!)) {
            // Skill exists with this name - link it instead of showing status
            if (options.dryRun) {
              console.log(`[dry-run] Would link skill "${skillOrSubcommand}"`);
              return;
            }
            const results = await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skillOrSubcommand });
            const agents = results.map(r => r.agent);
            if (agents.length > 0) {
              console.log(`✓ Linked ${skillOrSubcommand} to: ${agents.join(', ')}`);
            }
            // Reconcile stale links for this skill
            await handleStaleLinksReconciliation(resolvedHomeDir, [skillOrSubcommand!], options);
            return;
          }
        }

        // Show link status
        const statuses = await collectLinkStatus(resolvedHomeDir);
        console.log(formatLinkStatusMatrix(statuses, options.verbose ?? false));
        return;
      }

      if (options.all) {
        if (options.dryRun) {
          console.log('[dry-run] Would link all configured skills');
          // Still show what stale links would be removed
          const staleBySkill = await findStaleLinks(resolvedHomeDir);
          await displayStaleLinksPreview(staleBySkill);
          return;
        }
        const results = await linkConfiguredSkills(resolvedHomeDir, { all: true });
        const skillCount = new Set(results.map(r => r.skill)).size;
        console.log(`✓ Linked ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
        // Reconcile stale links for all skills
        await handleStaleLinksReconciliation(resolvedHomeDir, undefined, options);
        return;
      }

      if (typeof skillOrSubcommand === 'string') {
        if (options.dryRun) {
          console.log(`[dry-run] Would link skill "${skillOrSubcommand}"`);
          // Still show what stale links would be removed
          const staleBySkill = await findStaleLinks(resolvedHomeDir, [skillOrSubcommand]);
          await displayStaleLinksPreview(staleBySkill);
          return;
        }
        const results = await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skillOrSubcommand });
        const agents = results.map(r => r.agent);
        if (agents.length > 0) {
          console.log(`✓ Linked ${skillOrSubcommand} to: ${agents.join(', ')}`);
        }
        // Reconcile stale links for this skill
        await handleStaleLinksReconciliation(resolvedHomeDir, [skillOrSubcommand], options);
        return;
      }

      // No args: open matrix editor
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
    });

  /**
   * Display preview of stale links that would be removed (for --dry-run)
   */
  async function displayStaleLinksPreview(staleBySkill: StaleLinksBySkill): Promise<void> {
    const allStale = Object.values(staleBySkill).flat();
    if (allStale.length === 0) return;

    console.log('\nLinks to remove (no longer in config):');
    for (const [skillName, links] of Object.entries(staleBySkill)) {
      const agents = links.map(l => l.agent).join(', ');
      console.log(`  ${skillName}: ${agents}`);
    }
    console.log(`\n[dry-run] Would remove ${allStale.length} link${allStale.length !== 1 ? 's' : ''}`);
  }

  /**
   * Handle stale links reconciliation after linking
   */
  async function handleStaleLinksReconciliation(
    homeDir: string,
    skillNames: string[] | undefined,
    options: { dryRun?: boolean; yes?: boolean }
  ): Promise<void> {
    const staleBySkill = await findStaleLinks(homeDir, skillNames);
    const allStale = Object.values(staleBySkill).flat();

    if (allStale.length === 0) return;

    const config = await loadConfig(homeDir);

    // Single skill: simpler output
    if (skillNames && skillNames.length === 1) {
      const skillName = skillNames[0];
      const staleLinks = staleBySkill[skillName] ?? [];
      if (staleLinks.length === 0) return;

      const agents = staleLinks.map(l => l.agent).join(', ');

      if (options.dryRun) {
        console.log(`\n[dry-run] Would remove ${skillName} from: ${agents}`);
        return;
      }

      let shouldRemove = options.yes;
      if (!shouldRemove) {
        shouldRemove = await confirm({
          message: `Remove ${skillName} from ${agents}? (no longer in config)`,
          default: true
        });
      }

      if (shouldRemove) {
        const result = await reconcileStaleLinks(skillNames, config);
        if (result.removed.length > 0) {
          console.log('✓ Removed');
        }
        if (result.errors.length > 0) {
          console.log(`✗ Failed to remove ${result.errors.length} link(s)`);
        }
      }
      return;
    }

    // Batch: grouped output
    console.log('\nLinks to remove (no longer in config):');
    for (const [skillName, links] of Object.entries(staleBySkill)) {
      const agents = links.map(l => l.agent).join(', ');
      console.log(`  ${skillName}: ${agents}`);
    }

    if (options.dryRun) {
      console.log(`\n[dry-run] Would remove ${allStale.length} link${allStale.length !== 1 ? 's' : ''}`);
      return;
    }

    let shouldRemove = options.yes;
    if (!shouldRemove) {
      shouldRemove = await confirm({
        message: `Remove ${allStale.length} link${allStale.length !== 1 ? 's' : ''}?`,
        default: true
      });
    }

    if (shouldRemove) {
      // For batch, pass empty array to check all skills
      const result = await reconcileStaleLinks([], config);
      if (result.removed.length > 0) {
        console.log(`✓ Removed ${result.removed.length} link${result.removed.length !== 1 ? 's' : ''}`);
      }
      if (result.errors.length > 0) {
        console.log(`✗ Failed to remove ${result.errors.length} link(s)`);
      }
    }
  }

  program
    .command('unlink <skill>')
    .description('Explicitly remove all links for a skill (vs reconcile which syncs to config)')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, options: { yes?: boolean; dryRun?: boolean }) => {
      // Auto-check config health
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      if (options.dryRun) {
        console.log(`[dry-run] Would unlink skill "${skill}" from all agents`);
        return;
      }

      if (!options.yes) {
        const confirmed = await confirm({
          message: `Unlink skill "${skill}" from all agents?`,
          default: false,
        });
        if (!confirmed) {
          console.log('Cancelled.');
          return;
        }
      }

      await unlinkSkill(resolvedHomeDir, skill);
      console.log(`Unlinked "${skill}" from all agents.`);
    });

  const sourceCommand = program.command('source').description('Manage external skill sources and source recovery');

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
    .option('--path <path>', 'Storage path for source files')
    .option('--skill-subdir <dir>', 'Subdirectory within source containing skills')
    .option('--branch <branch>', 'Git branch')
    .option('-y, --yes', 'Skip confirmation prompts, select all skills')
    .action(async (nameOrUrl: string, options: {
      type?: SourceType;
      url?: string;
      path?: string;
      skillSubdir?: string;
      branch?: string;
      yes?: boolean;
    }) => {
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      // Auto-detect local type when --path is provided without --type
      // If not a GitHub URL pattern and --path is provided, default to local type
      let effectiveType = options.type;
      if (!effectiveType && options.path) {
        const parsed = /^https:\/\/github\.com\//.test(nameOrUrl);
        if (!parsed) {
          effectiveType = 'local';
        }
      }

      // --path sets the storage path for source files
      let effectiveUrl = options.url ?? nameOrUrl;
      let effectiveStore = options.path;

      if (effectiveType === 'local' && options.path && !options.url) {
        // For local type without explicit --url, --path provides the local directory path
        effectiveUrl = options.path;
        // Default path to '.' (root of the path) for local type
        effectiveStore = '.';
      }
      // If --url was provided, --path is used as the skills subdirectory (same as other types)

      const result = await addSourceFromUrl(resolvedHomeDir, effectiveUrl, {
        name: options.url ? nameOrUrl : (options.path ? nameOrUrl : undefined),
        type: effectiveType,
        path: effectiveStore,
        skillSubdir: options.skillSubdir,
        branch: options.branch,
        skipPrompt: options.yes,
        onSelectSkills: async (skills: DiscoveredSkill[], existingSkills: Set<string>) => {
          // Filter out duplicates
          const available = skills.filter(s => !existingSkills.has(s.name));
          const duplicates = skills.filter(s => existingSkills.has(s.name));

          if (available.length === 0) {
            console.log('All skills from this source already exist.');
            return [];
          }

          console.log(`\nFound ${skills.length} skill(s) in source:\n`);

          if (duplicates.length > 0) {
            console.log('Duplicates (will be skipped):');
            for (const skill of duplicates) {
              console.log(`  - ${skill.name} (${skill.relativePath})`);
            }
            console.log('');
          }

          const selected = await checkbox({
            message: 'Select skills to add:',
            choices: available.map(s => ({
              name: `${s.name} (${s.relativePath})`,
              value: s.name,
              checked: true
            }))
          });

          return selected;
        }
      });

      if (result.restoredFromIgnore) {
        console.log(`Restored skill "${result.restoredSkill}" from ignore list`);
        return;
      }

      if (result.sameRepoMatch) {
        console.log(`\nA source already exists for this repository: ${result.sameRepoMatch.name}`);
        console.log(`Existing path: ${result.sameRepoMatch.source.path}`);
        console.log(`\nTo add a skill from a different path in this repo, use:`);
        console.log(`  syncskill source add <skill-name> --url ${result.sameRepoMatch.source.url} --skill-subdir <path>`);
        return;
      }

      console.log(`Added source: ${result.name}`);
    });

  sourceCommand
    .command('list')
    .alias('ls')
    .description('List configured sources')
    .action(async () => {
      for (const line of formatSourceListLines(await listSources(resolvedHomeDir))) {
        console.log(line);
      }
    });

  sourceCommand
    .command('update [name]')
    .description('Update one source or all configured sources, with preview support for dirty-source handling')
    .option('--all', 'Update all configured sources')
    .option('-y, --yes', 'Skip confirmation prompts, auto-skip dirty sources')
    .option('--force', 'Force update dirty sources (backs up first)')
    .option('--dry-run', 'Preview update actions, including dirty-source decisions, without making changes')
    .action(async (name: string | undefined, options: { all?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean }) => {
      if (options.all || name === undefined) {
        await updateAllSources(resolvedHomeDir, undefined, { yes: options.yes, force: options.force, dryRun: options.dryRun });
        return;
      }

      await updateSource(resolvedHomeDir, name, { yes: options.yes, force: options.force, dryRun: options.dryRun });
    });

  sourceCommand
    .command('restore <name>')
    .description('Restore a source from the most recent force-update backup')
    .action(async (name: string) => {
      const { restoreSource } = await import('./source-restore.js');
      const result = await restoreSource(resolvedHomeDir, name);
      console.log(result.message);
      if (!result.success) {
        process.exit(1);
      }
    });

  // Top-level alias for 'source update'
  program
    .command('update [name]')
    .description('Update source(s) — alias for "source update"')
    .option('--all', 'Update all configured sources')
    .option('-y, --yes', 'Skip confirmation prompts, auto-skip dirty sources')
    .option('--force', 'Force update dirty sources (backs up first)')
    .option('--dry-run', 'Preview update without making changes')
    .action(async (name: string | undefined, options: { all?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean }) => {
      if (options.all || name === undefined) {
        await updateAllSources(resolvedHomeDir, undefined, { yes: options.yes, force: options.force, dryRun: options.dryRun });
        return;
      }

      await updateSource(resolvedHomeDir, name, { yes: options.yes, force: options.force, dryRun: options.dryRun });
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
      } else {
        // Unified options for all source types
        // Non-git sources filter out the convert option since @inquirer/prompts doesn't support disabled
        const choices = [
          ...(isGitSource
            ? [
                {
                  name: 'Convert to local source (keep files, no more git updates)',
                  value: RemovalAction.ConvertToLocal,
                },
              ]
            : []),
          {
            name: 'Remove config + links only (keep skill files on disk)',
            value: RemovalAction.RemoveConfigKeepFiles,
          },
          {
            name: 'Remove everything (config, links, and skill files)',
            value: RemovalAction.RemoveAll,
          },
        ];

        const choice = await select({
          message: `How do you want to remove source "${name}" (type: ${sourceType})?`,
          choices,
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

  const serverCommand = program.command('server').description('Manage and inspect remote sync servers');

  serverCommand.action(async () => {
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'server' });
  });

  serverCommand
    .command('list')
    .alias('ls')
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
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

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
    .command('remote')
    .description('Edit skill → server sync mapping (matrix editor)')
    .action(async () => {
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'remote' });
    });

  program
    .command('refresh [server]')
    .description('Refresh manifest state. Default: --all + --status')
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
      // Auto-check config health (if config exists)
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      let config: SyncSkillConfig | null = null;
      try {
        config = await loadConfig(resolvedHomeDir);
      } catch {
        // Config may not exist yet
      }
      await autoDiagnoseConfig(config, skillsDir);

      const manifests = await loadTrackedManifests(resolvedHomeDir);

      for (const line of formatStatusLines(manifests)) {
        console.log(line);
      }
    });

  program
    .command('diff <server>')
    .description('Show pending reconciliation rows for one server')
    .action(async (server: string) => {
      // Auto-check config health (if config exists)
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      let config: SyncSkillConfig | null = null;
      try {
        config = await loadConfig(resolvedHomeDir);
      } catch {
        // Config may not exist yet
      }
      await autoDiagnoseConfig(config, skillsDir);

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
    .description('Resolve a conflict by choosing local or remote state')
    .option('--local', 'Keep local version, overwrite remote')
    .option('--remote', 'Keep remote version, overwrite local')
    .option('--diff', 'Show hash differences (can be combined with --local/--remote)')
    .action(
      async (
        skill: string,
        options: { local?: boolean; remote?: boolean; diff?: boolean }
      ) => {
        let side: 'local' | 'remote' | undefined;

        if (options.local && options.remote) {
          throw new Error('Cannot specify both --local and --remote');
        } else if (options.local) {
          side = 'local';
        } else if (options.remote) {
          side = 'remote';
        }

        // If only --diff, just show diff and exit
        const diffOnly = options.diff && !side;

        // Track if user chose to see diff first in interactive mode
        let showDiffThenAsk = false;

        // If no options at all, enter interactive mode
        if (!side && !options.diff) {
          const answer = await select({
            message: `How to resolve "${skill}"?`,
            choices: [
              { name: 'Keep local version', value: 'local' },
              { name: 'Keep remote version', value: 'remote' },
              { name: 'Show diff first', value: 'diff' }
            ]
          });

          if (answer === 'diff') {
            // Show diff then ask again
            options.diff = true;
            showDiffThenAsk = true;
          } else {
            side = answer as 'local' | 'remote';
          }
        }

        const servers = await listTrackedServers(resolvedHomeDir);

        if (servers.length === 0) {
          console.error('No tracked servers found. Run "syncskill refresh" first to track server manifests.');
          process.exit(1);
        }

        const updatedAt = new Date().toISOString();
        let resolved = false;

        for (const server of servers) {
          const manifest = await loadServerManifest(resolvedHomeDir, server);
          const reconciled = reconcileManifest(manifest);
          const current = reconciled.skills[skill];

          if (!current || current.direction !== 'conflict') {
            continue;
          }

          // Handle --diff option (show diff)
          if (options.diff) {
            const localHash = current.local_hash ?? '-';
            const remoteHash = current.remote_hash ?? '-';
            const recordedHash = current.recorded_hash ?? '-';
            console.log(`${skill}\t${server}\tlocal:${localHash}\tremote:${remoteHash}\tbase:${recordedHash}`);
            resolved = true;

            // If diff only (no side specified and not interactive flow), continue to next server
            if (diffOnly && !showDiffThenAsk) {
              continue;
            }
          }

          // If we have a side, apply resolution
          if (side) {
            const updatedManifest = applyResolution(reconciled, skill, side, updatedAt);
            await saveServerManifest(resolvedHomeDir, updatedManifest);

            const updatedSkill = updatedManifest.skills[skill];
            console.log(`${skill}\t${server}\t${updatedSkill.direction}\t${updatedSkill.status}`);
            resolved = true;
          }
        }

        // If user chose "Show diff first" in interactive mode, ask again after showing diff
        if (showDiffThenAsk && resolved && !side) {
          const answer = await select({
            message: `Now choose how to resolve "${skill}":`,
            choices: [
              { name: 'Keep local version', value: 'local' },
              { name: 'Keep remote version', value: 'remote' }
            ]
          });
          side = answer as 'local' | 'remote';

          // Apply resolution to all conflicting servers
          for (const server of servers) {
            const manifest = await loadServerManifest(resolvedHomeDir, server);
            const reconciled = reconcileManifest(manifest);
            const current = reconciled.skills[skill];

            if (!current || current.direction !== 'conflict') {
              continue;
            }

            const updatedManifest = applyResolution(reconciled, skill, side, updatedAt);
            await saveServerManifest(resolvedHomeDir, updatedManifest);

            const updatedSkill = updatedManifest.skills[skill];
            console.log(`${skill}\t${server}\t${updatedSkill.direction}\t${updatedSkill.status}`);
          }
        }

        if (!resolved) {
          throw new Error(`No tracked conflict found for skill: ${skill}`);
        }
      }
    );

  program
    .command('push [server]')
    .description('Push local skill changes to one server or all configured servers')
    .option('--all', 'Push to all configured servers')
    .option('--dry-run', 'Preview changes without pushing')
    .option('--timeout <seconds>', 'Per-server SSH timeout in seconds', parseInteger)
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; timeout?: number; yes?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      // Auto-check config health
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      const allServers = Object.keys(config.servers).sort();

      const targetServers = await selectTargetServers(allServers, server, options, 'push');
      if (!targetServers) return;

      const results = await pushToServers(resolvedHomeDir, targetServers, {
        dryRun: options.dryRun,
        noRefresh: !program.opts<{ refresh: boolean }>().refresh,
        timeout: options.timeout,
        yes: options.yes
      });

      for (const result of results) {
        for (const line of formatSkillRows('push', result)) {
          console.log(line);
        }
      }
    });

  program
    .command('pull [server]')
    .description('Pull remote skill changes from one server or all configured servers')
    .option('--all', 'Pull from all configured servers')
    .option('--dry-run', 'Preview changes without pulling')
    .option('--timeout <seconds>', 'Per-server SSH timeout in seconds', parseInteger)
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; timeout?: number; yes?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      // Auto-check config health
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      const allServers = Object.keys(config.servers).sort();

      const targetServers = await selectTargetServers(allServers, server, options, 'pull');
      if (!targetServers) return;

      const results = await pullFromServers(resolvedHomeDir, targetServers, { dryRun: options.dryRun, timeout: options.timeout });

      for (const result of results) {
        for (const line of formatSkillRows('pull', result)) {
          console.log(line);
        }
      }
    });

  program
    .command('sync [server]')
    .description('Pull then push changes for one server or all configured servers')
    .option('--all', 'Sync all configured servers')
    .option('--dry-run', 'Preview changes without syncing')
    .option('--timeout <seconds>', 'Per-server SSH timeout in seconds', parseInteger)
    .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; timeout?: number }) => {
      // Auto-check config health
      const config = await loadConfig(resolvedHomeDir);
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      const servers = options.all || server === undefined ? undefined : [server];
      const results = await syncServers(resolvedHomeDir, servers, { dryRun: options.dryRun, timeout: options.timeout });

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

      // Aggregate and display conflicts
      const allConflicts: Array<{ server: string; skill: string }> = [];
      for (const result of results) {
        for (const skill of result.pull.conflicted_skills) {
          allConflicts.push({ server: result.server, skill });
        }
        for (const skill of result.push.conflicted_skills) {
          // Avoid duplicates (same skill might conflict in both pull and push)
          if (!allConflicts.some(c => c.server === result.server && c.skill === skill)) {
            allConflicts.push({ server: result.server, skill });
          }
        }
      }

      if (allConflicts.length > 0) {
        console.log('\nConflicts skipped:');
        for (const c of allConflicts) {
          console.log(`  ${c.skill} (${c.server})`);
        }
        console.log('\nRun `syncskill resolve <skill>` to resolve conflicts.');
      }
    });

  program
    .command('doctor')
    .description('Diagnose and repair config.yaml issues')
    .option('--fix', 'Interactively fix issues')
    .option('--dry-run', 'Preview fixes without applying')
    .option('-y, --yes', 'Auto-fix all issues without prompting')
    .option('--rebuild-registry', 'Rebuild skills-registry.json from config and filesystem')
    .action(async (options: { fix?: boolean; dryRun?: boolean; yes?: boolean; rebuildRegistry?: boolean }) => {
      const { skillsDir } = getSyncPaths(resolvedHomeDir);

      let config: SyncSkillConfig;
      try {
        config = await loadConfig(resolvedHomeDir);
      } catch (error) {
        console.error('Failed to load config:', error instanceof Error ? error.message : error);
        process.exit(1);
      }

      // Handle --rebuild-registry
      if (options.rebuildRegistry) {
        const { rebuildSkillsRegistry, saveSkillsRegistry, getSkillsRegistryPath } = await import('./core/skills-registry.js');
        const { readFile, writeFile } = await import('node:fs/promises');

        if (options.dryRun) {
          console.log('[dry-run] Would rebuild skills-registry.json');
          const registry = await rebuildSkillsRegistry(resolvedHomeDir, config);
          console.log(`Would create registry with ${Object.keys(registry.skills).length} skills`);
          return;
        }

        const registryPath = getSkillsRegistryPath(resolvedHomeDir);

        // Backup existing if exists
        try {
          const existing = await readFile(registryPath, 'utf8');
          await writeFile(registryPath + '.bak', existing);
          console.log('✓ Backed up existing registry to skills-registry.json.bak');
        } catch {
          // No existing registry
        }

        const registry = await rebuildSkillsRegistry(resolvedHomeDir, config);
        await saveSkillsRegistry(resolvedHomeDir, registry);

        const manualCount = Object.values(registry.skills).filter(s => s.type === 'manual').length;
        const sourceCount = Object.values(registry.skills).filter(s => s.type !== 'manual').length;
        const ignoredCount = Object.values(registry.skills).filter(s => s.status === 'ignored').length;

        console.log('✓ Rebuilt skills-registry.json');
        console.log(`  Manual skills: ${manualCount}`);
        console.log(`  Source skills: ${sourceCount}`);
        console.log(`  Ignored: ${ignoredCount}`);
        return;
      }

      const report = await diagnoseConfig(config, skillsDir, resolvedHomeDir);

      if (!options.fix) {
        console.log(formatDiagnosticReport(report));
        process.exit(report.canProceed ? 0 : 1);
      }

      if (report.isHealthy) {
        console.log('✓ No issues found. Config is healthy.');
        return;
      }

      console.log(`Found ${report.errors.length + report.warnings.length} issues to fix:\n`);

      const allItems = [...report.errors, ...report.warnings];

      let configChanged = false;
      let registryChanged = false;

      for (const item of allItems) {
        const shouldFix = options.yes || (await confirm({
          message: `${item.suggestion ?? `Fix ${item.path}`}?`,
          default: true
        }));

        if (shouldFix) {
          if (isRegistryDiagnostic(item.code)) {
            // Handle registry repairs
            if (!options.dryRun) {
              await repairRegistry(
                resolvedHomeDir,
                skillsDir,
                { errors: [], warnings: [item], isHealthy: false, canProceed: true },
                {
                  removeStaleEntries: item.code === 'REGISTRY_STALE',
                  addOrphanEntries: item.code === 'REGISTRY_ORPHAN'
                }
              );
              registryChanged = true;
            }
          } else {
            // Handle config repairs
            const repairOpts: RepairOptions = {
              removeInvalidSkillLinks: item.code === 'SKILL_NOT_FOUND',
              removeInvalidAgentLinks: item.code === 'AGENT_NOT_CONFIGURED',
              removeInvalidAgents: item.code === 'AGENT_PATH_INVALID',
              removeInvalidSources: item.code === 'SOURCE_PATH_INVALID',
              removeStaleRegistryEntries: false,
              addOrphanRegistryEntries: false
            };

            if (!options.dryRun) {
              config = repairConfig(config, { errors: [], warnings: [item], isHealthy: false, canProceed: true }, repairOpts);
              configChanged = true;
            }
          }
          console.log(`✓ Fixed ${item.path}`);
        } else {
          console.log(`⊘ Skipped ${item.path}`);
        }
      }

      if (!options.dryRun) {
        if (configChanged) {
          await saveConfig(config, resolvedHomeDir);
        }
        if (configChanged || registryChanged) {
          console.log('\nChanges saved.');
        }
      } else {
        console.log('\n[dry-run] No changes written.');
      }
    });

  program.action(async () => {
    const summary = await loadDashboardSummary(resolvedHomeDir);
    console.log(formatDashboardSummary(summary));
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
