#!/usr/bin/env node

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { checkbox, select, confirm, input } from '@inquirer/prompts';
import { Command, InvalidArgumentError, Option } from 'commander';
import { createOutput, setGlobalOutput, getGlobalOutput } from './cli/index.js';
import { loadEnvConfig, mergeWithFlags } from './cli/env.js';
import { ExitCode, errorCodeToExitCode } from './cli/exit-codes.js';
import { createPlan, addAction, serializePlan, type Plan } from './cli/plan.js';
import { withPlanExecute, type PlanExecuteOptions } from './cli/plan-execute.js';
import type { Resolutions } from './cli/resolution.js';

interface SelectServersOptions {
  all?: boolean;
  yes?: boolean;
  noInteractive?: boolean;
}

async function selectTargetServers(
  allServers: string[],
  server: string | undefined,
  options: SelectServersOptions,
  action: 'push' | 'pull' | 'sync'
): Promise<string[] | null> {
  if (options.all) {
    return allServers;
  }

  if (server) {
    if (!allServers.includes(server)) {
      return failWithOutputError('E_SERVER_NOT_FOUND', `Server not found: ${server}`, 'Use `syncskill server list` to inspect configured servers');
    }

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

  if (options.noInteractive) {
    console.error('Error: This command requires interactive input. Use --no-interactive only with non-interactive commands.');
    process.exit(4);
    return null;
  }

  const message = action === 'push'
    ? 'Select servers to push:'
    : action === 'pull'
      ? 'Select servers to pull from:'
      : 'Select servers to sync:';
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
import { computeDefaultLinkTargets } from './core/private-agents.js';
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
import { expandTargetAgents, getConfigPaths, getSyncPaths, loadConfig, parseConfigValue, resolveAgentPath, saveConfig, setConfigValue, type SyncSkillConfig } from './config/config.js';
import { createPromptApi, runConfigUi } from './config/config-ui.js';
import { collectLinkStatus, discoverSkills, findStaleLinks, findUnmanagedSkills, formatLinkStatusMatrix, linkConfiguredSkills, listLocalSkills, reconcileStaleLinks, unlinkSkill, unlinkSkillFromAgent, type StaleLinksBySkill } from './linker.js';
import { listLocalSkillNames, loadServerManifest, saveServerManifest } from './core/manifest.js';
import { formatServerListLines, formatServerShowLines, listServers, showServer } from './core/server.js';
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
  listSourcesWithDetails,
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

function getCommandPath(command: Command): string {
  const commandPath: string[] = [];
  let current: Command | null = command;

  while (current && current.parent) {
    commandPath.unshift(current.name());
    current = current.parent;

    if (!current.parent) {
      break;
    }
  }

  return commandPath.join(' ');
}

function shouldSkipAutoRefresh(command: Command): boolean {
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
  return skipCommands.includes(getCommandPath(command));
}

function normalizeConfiguredTargets(targets: string[]): string[] {
  if (targets.includes('*')) {
    return ['*'];
  }

  return [...new Set(targets)].sort();
}

function buildPlanRefMap(plan: Plan, op: string): Map<string, string> {
  const refs = new Map<string, string>();

  for (const action of plan.actions) {
    if (action.op !== op || typeof action.id !== 'string' || typeof action.skill !== 'string') {
      continue;
    }

    if (typeof action.agent === 'string') {
      refs.set(`${action.skill}:${action.agent}`, action.id);
      continue;
    }

    refs.set(action.skill, action.id);
  }

  return refs;
}

function summarizeRemovedLinks(
  config: SyncSkillConfig,
  ownedSkills: string[],
  plan: Plan
): Array<{ skill: string; agents: string[]; plan_ref?: string }> {
  const refs = buildPlanRefMap(plan, 'remove.unlink');

  return ownedSkills
    .map((skill) => {
      const agents = expandTargetAgents(config, config.links[skill] ?? []);
      if (agents.length === 0) {
        return null;
      }

      return {
        skill,
        agents,
        ...(refs.get(skill) ? { plan_ref: refs.get(skill) } : {})
      };
    })
    .filter((item): item is { skill: string; agents: string[]; plan_ref?: string } => item !== null);
}

function buildSourceRemovePlan(ownedSkills: string[]): Plan {
  let plan = createPlan('source remove');

  for (const skill of ownedSkills) {
    plan = addAction(plan, { op: 'remove.unlink', skill });
  }

  return plan;
}

function buildLinkBuildPlan(homeDir: string, config: SyncSkillConfig, staleBySkill: StaleLinksBySkill): Plan {
  let plan = createPlan('link build');
  const { skillsDir } = getSyncPaths(homeDir);

  for (const skill of Object.keys(config.links).sort()) {
    const agents = expandTargetAgents(config, config.links[skill] ?? []);

    for (const agent of agents) {
      plan = addAction(plan, {
        op: 'create-symlink',
        skill,
        agent,
        from: join(skillsDir, skill),
        to: join(resolveAgentPath(config.agents[agent], homeDir), skill)
      });
    }
  }

  for (const skill of Object.keys(staleBySkill).sort()) {
    for (const stale of [...staleBySkill[skill]].sort((left, right) => left.agent.localeCompare(right.agent))) {
      plan = addAction(plan, {
        op: 'remove-symlink',
        skill: stale.skill,
        agent: stale.agent,
        path: stale.path
      });
    }
  }

  return plan;
}

function summarizeLinkBuild(
  homeDir: string,
  config: SyncSkillConfig,
  linkResults: Array<{ skill: string; agent: string }>,
  removedLinks: Array<{ skill: string; agent: string; path: string }>,
  plan: Plan
): {
  changes: Array<{
    skill: string;
    config_before: string[];
    config_after: string[];
    symlinks_created: Array<{ agent: string; path: string; plan_ref?: string }>;
    symlinks_removed: Array<{ agent: string; path: string; plan_ref?: string }>;
  }>;
} {
  const createRefs = buildPlanRefMap(plan, 'create-symlink');
  const removeRefs = buildPlanRefMap(plan, 'remove-symlink');
  const skills = new Set<string>([
    ...Object.keys(config.links),
    ...linkResults.map((result) => result.skill),
    ...removedLinks.map((result) => result.skill)
  ]);

  const changes = [...skills]
    .sort()
    .map((skill) => {
      const configTargets = normalizeConfiguredTargets(config.links[skill] ?? []);
      const symlinksCreated = linkResults
        .filter((result) => result.skill === skill)
        .sort((left, right) => left.agent.localeCompare(right.agent))
        .map((result) => ({
          agent: result.agent,
          path: join(resolveAgentPath(config.agents[result.agent], homeDir), skill),
          ...(createRefs.get(`${result.skill}:${result.agent}`)
            ? { plan_ref: createRefs.get(`${result.skill}:${result.agent}`) }
            : {})
        }));
      const symlinksRemoved = removedLinks
        .filter((result) => result.skill === skill)
        .sort((left, right) => left.agent.localeCompare(right.agent))
        .map((result) => ({
          agent: result.agent,
          path: result.path,
          ...(removeRefs.get(`${result.skill}:${result.agent}`)
            ? { plan_ref: removeRefs.get(`${result.skill}:${result.agent}`) }
            : {})
        }));

      if (symlinksCreated.length === 0 && symlinksRemoved.length === 0) {
        return null;
      }

      return {
        skill,
        config_before: configTargets,
        config_after: configTargets,
        symlinks_created: symlinksCreated,
        symlinks_removed: symlinksRemoved
      };
    })
    .filter((item): item is {
      skill: string;
      config_before: string[];
      config_after: string[];
      symlinks_created: Array<{ agent: string; path: string; plan_ref?: string }>;
      symlinks_removed: Array<{ agent: string; path: string; plan_ref?: string }>;
    } => item !== null);

  return { changes };
}

function collectRemovedLinks(
  staleBySkill: StaleLinksBySkill,
  removedPaths: string[]
): Array<{ skill: string; agent: string; path: string }> {
  const removedPathSet = new Set(removedPaths);

  return Object.values(staleBySkill)
    .flat()
    .filter((link) => removedPathSet.has(link.path))
    .sort((left, right) => {
      if (left.skill !== right.skill) {
        return left.skill.localeCompare(right.skill);
      }
      return left.agent.localeCompare(right.agent);
    });
}

function summarizeDeletedPaths(homeDir: string, sourceName: string, ownedSkills: string[]): string[] {
  const { skillsDir, syncDir } = getSyncPaths(homeDir);

  return [
    ...ownedSkills.map((skill) => join(skillsDir, skill)),
    join(syncDir, '.sources', sourceName)
  ];
}

function summarizeSourceRemoval(
  homeDir: string,
  name: string,
  action: RemovalAction,
  config: SyncSkillConfig,
  ownedSkills: string[]
): Record<string, unknown> {
  const plan = buildSourceRemovePlan(ownedSkills);

  if (action === RemovalAction.ConvertToLocal) {
    return {
      name,
      mode: 'keep-files',
      converted_to_local: true,
      deleted_paths: [],
      removed_skills: [],
      removed_links: []
    };
  }

  return {
    name,
    mode: action === RemovalAction.RemoveAll ? 'completely' : 'keep-files',
    deleted_paths: action === RemovalAction.RemoveAll ? summarizeDeletedPaths(homeDir, name, ownedSkills) : [],
    removed_skills: ownedSkills,
    removed_links: summarizeRemovedLinks(config, ownedSkills, plan)
  };
}

interface StaleLinkCleanupSummary {
  staleBySkill: StaleLinksBySkill;
  removed: Array<{ skill: string; agent: string; path: string }>;
  errors: string[];
}

function formatPullRows(result: PullResult): string[] {
  return [
    ...result.pulled_skills.map((skill: string) => `${skill}\t${result.server}\tpull\tin-sync`),
    ...(result.deleted_skills ?? []).map((skill: string) => `${skill}\t${result.server}\tdelete\tin-sync`),
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

function isNoInteractive(program: Command): true | undefined {
  const options = program.opts<{ noInteractive?: boolean; interactive?: boolean }>();
  return options.noInteractive === true || options.interactive === false ? true : undefined;
}

function failForNoInteractive(hint?: string): never {
  try {
    const output = getGlobalOutput();
    const exitCode = output.error(
      'E_NEEDS_INPUT',
      'This command requires interactive input',
      { hint: hint ?? 'Use non-interactive flags or remove --no-interactive' }
    );
    output.result(false, { error: 'E_NEEDS_INPUT' });
    process.exit(exitCode);
  } catch {
    console.error('Error: This command requires interactive input');
    if (hint) console.error(`Hint: ${hint}`);
    process.exit(ExitCode.NEEDS_INPUT);
  }
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('Expected an integer value');
  }
  return parsed;
}

function parseOnConflict(value: string): 'keep-local' | 'keep-remote' | 'skip' | 'abort' {
  if (value === 'keep-local' || value === 'keep-remote' || value === 'skip' || value === 'abort') {
    return value;
  }

  throw new InvalidArgumentError('Expected one of: keep-local, keep-remote, skip, abort');
}

function parseOnDeletion(value: string): 'keep-local' | 'delete' | 'prompt' {
  if (value === 'keep-local' || value === 'delete' || value === 'prompt') {
    return value;
  }

  throw new InvalidArgumentError('Expected one of: keep-local, delete, prompt');
}

function failWithOutputError(code: string, message: string, hint?: string): never {
  try {
    const output = getGlobalOutput();
    const exitCode = output.error(code, message, hint ? { hint } : undefined);
    output.result(false, { error: code });
    process.exit(exitCode);
  } catch {
    console.error(message);
    if (hint) {
      console.error(`Hint: ${hint}`);
    }
    process.exit(errorCodeToExitCode(code));
  }
}

function parseStructuredError(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = error.message.match(/^(E_[A-Z_]+):\s*(.*)$/s);
  if (!match) {
    return null;
  }

  return {
    code: match[1],
    message: match[2] || error.message
  };
}

function handleSyncCommandError(error: unknown): never {
  const parsed = parseStructuredError(error);
  if (!parsed) {
    throw error;
  }

  if (parsed.code === 'E_SERVER_NOT_FOUND') {
    return failWithOutputError(parsed.code, parsed.message, 'Use `syncskill server list` to inspect configured servers');
  }

  if (parsed.code === 'E_CONFLICT') {
    return failWithOutputError(parsed.code, parsed.message);
  }

  if (parsed.code === 'E_NEEDS_INPUT') {
    return failWithOutputError(parsed.code, parsed.message, 'Use --cross-server-policy / --on-conflict / --on-deletion, or remove --no-interactive');
  }

  throw error;
}

// Install-specific plan actions
type InstallAction =
  | { op: 'install-self'; to: string }
  | { op: 'link-skill'; skill: string; agents: string[] };

async function buildInstallPlan(
  homeDir: string,
  urlOrPath: string | undefined,
  options: { self?: boolean; yes?: boolean }
): Promise<Plan> {
  let plan = createPlan('install');
  const { skillsDir } = getSyncPaths(homeDir);

  if (options.self || urlOrPath === 'self') {
    const targetPath = join(skillsDir, 'syncskill');
    plan = addAction(plan, { op: 'install-self', to: targetPath } satisfies InstallAction);

    const config = await loadConfig(homeDir);
    const targets = config.links['syncskill'] ?? (await computeDefaultLinkTargets(homeDir, config)).targets;
    const agents = expandTargetAgents(config, targets);

    if (agents.length > 0) {
      plan = addAction(plan, { op: 'link-skill', skill: 'syncskill', agents } satisfies InstallAction);
    }
  }

  return plan;
}

async function executeInstallPlan(
  homeDir: string,
  plan: Plan,
  _resolutions: Resolutions,
  deprecations: string[] = []
): Promise<void> {
  const output = getGlobalOutput();
  const installAction = plan.actions.find((action) => action.op === 'install-self');
  const linkAction = plan.actions.find((action) => action.op === 'link-skill' && action.skill === 'syncskill');

  if (!installAction || installAction.op !== 'install-self') {
    output.result(true, {});
    return;
  }

  const result = await installSyncskillSkill(homeDir);
  let summary: Record<string, unknown>;

  if (result.alreadyInstalled) {
    output.info('syncskill skill already installed');
    summary = {
      installed: false,
      skill: 'syncskill',
      alreadyInstalled: true,
      linkedAgents: result.linkedAgents ?? [],
      ...(deprecations.length > 0 ? { deprecations } : {}),
      data: {
        skills: {
          already_installed: ['syncskill']
        }
      }
    };
  } else {
    output.change('add', 'skill', 'syncskill', { target: result.installedPath });
    if (result.linkedAgents?.length) {
      output.info(`Linked to: ${result.linkedAgents.join(', ')}`);
    }
    summary = {
      installed: true,
      skill: 'syncskill',
      path: result.installedPath,
      linkedAgents: result.linkedAgents ?? [],
      ...(deprecations.length > 0 ? { deprecations } : {}),
      data: {
        skills: {
          installed: [
            {
              name: 'syncskill',
              path: result.installedPath,
              ...(installAction.id ? { plan_ref: installAction.id } : {})
            }
          ]
        },
        links_created: (result.linkedAgents ?? []).map((agent) => ({
          skill: 'syncskill',
          agent,
          ...(linkAction?.id ? { plan_ref: linkAction.id } : {})
        }))
      }
    };
  }

  output.result(true, summary);
}

/**
 * Build CLI introspection data for --help --json.
 * See spec §11.10 for schema.
 */
function getCommandMetadata(commandPath: string): { audience: 'human' | 'agent' | 'both'; prefer: string | null } {
  switch (commandPath) {
    case 'link edit':
    case 'link add':
    case 'link remove':
    case 'link clear':
    case 'unlink':
      return { audience: 'human', prefer: 'link set' };
    case 'link set':
    case 'link build':
    case 'link list':
      return { audience: 'agent', prefer: null };
    default:
      return { audience: 'both', prefer: null };
  }
}

function isVisibleOption(option: Option): boolean {
  return (option as Option & { hidden?: boolean }).hidden !== true;
}

function buildCommandIntrospection(command: Command, parentPath?: string): object {
  const commandPath = parentPath ? `${parentPath} ${command.name()}` : command.name();
  const metadata = getCommandMetadata(commandPath);

  return {
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    arguments: command.registeredArguments.map(arg => ({
      name: arg.name(),
      required: arg.required,
      description: arg.description,
    })),
    options: command.options.filter(isVisibleOption).map(opt => ({
      flags: opt.flags,
      description: opt.description,
      required: opt.required,
      defaultValue: opt.defaultValue ?? null,
    })),
    audience: metadata.audience,
    prefer: metadata.prefer,
    ...(command.commands.length > 0 ? { commands: command.commands.map(child => buildCommandIntrospection(child, commandPath)) } : {})
  };
}

function buildCliIntrospection(program: Command): object {
  return {
    name: program.name(),
    version: program.version(),
    description: program.description(),
    commands: program.commands.map(cmd => buildCommandIntrospection(cmd)),
    globalOptions: program.options.filter(isVisibleOption).map(opt => ({
      flags: opt.flags,
      description: opt.description,
      required: opt.required,
      defaultValue: opt.defaultValue ?? null,
    })),
  };
}

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool. No args: show local dashboard summary')
    .option('--json', 'Output in JSONL format for machine consumption')
    .option('--no-interactive', 'Disable interactive prompts')
    .option('--plan', 'Output plan without executing')
    .option('--apply <path|->', 'Execute a pre-generated plan file or read plan from stdin')
    .addOption(new Option('--apply-stdin').hideHelp())
    .option('--resolutions <path|->', 'Provide resolutions file or read resolutions from stdin')
    .addOption(new Option('--resolutions-stdin').hideHelp())
    .option('--sync-dir <path>', 'Override ~/.syncskill directory')
    .option('--config <path>', 'Override config file path')
    .option('--no-refresh', 'Skip automatic manifest refresh before commands')
    .configureHelp({
      formatHelp: (cmd, helper) => {
        const rootOpts = cmd.parent?.opts() ?? cmd.opts();
        if (rootOpts.json) {
          const introspection = buildCliIntrospection(cmd.parent ?? cmd);
          return JSON.stringify(introspection, null, 2);
        }

        const formatter = Object.getPrototypeOf(helper).formatHelp as (this: object, cmd: Command, helper: object) => string;
        return formatter.call(helper, cmd, helper);
      }
    })
    .hook('preAction', async (thisCommand, actionCommand) => {
      const envConfig = loadEnvConfig();
      const opts = thisCommand.opts<{
        json?: boolean;
        noInteractive?: boolean;
        syncDir?: string;
        config?: string;
        refresh?: boolean;
      }>();
      const mergedConfig = mergeWithFlags(envConfig, {
        json: opts.json,
        noInteractive: opts.noInteractive,
        syncDir: opts.syncDir,
        configPath: opts.config,
      });
      const output = createOutput({
        json: mergedConfig.json,
        noColor: mergedConfig.noColor,
      });
      output.setCommand(getCommandPath(actionCommand) || actionCommand.name());
      setGlobalOutput(output);

      if (shouldSkipAutoRefresh(actionCommand)) {
        return;
      }

      await autoRefreshManifests(resolvedHomeDir, opts.refresh !== false);
    });

  program
    .command('init')
    .description('Initialize the local syncskill repository')
    .option('--skip-scan', 'Skip migrating skills from detected agent directories')
    .option('--skip-self', 'Skip installing syncskill skill')
    .option('-y, --yes', 'Accept all defaults')
    .action(async (options: { skipScan?: boolean; skipSelf?: boolean; yes?: boolean }) => {
      await initializeRepo(resolvedHomeDir, {
        skipScan: Boolean(options.skipScan),
        skipSelf: Boolean(options.skipSelf),
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
      _planMode?: boolean;
      _applyPath?: string;
      _resolutionsPath?: string;
    }) => {
      const output = getGlobalOutput();

      const rootOptions = program.opts<{
        noInteractive?: boolean;
        plan?: boolean;
        apply?: string;
        applyStdin?: boolean;
        resolutions?: string;
        resolutionsStdin?: boolean;
      }>();
      const deprecatedApplyStdin = rootOptions.applyStdin ? '-' : undefined;
      const deprecatedResolutionsStdin = rootOptions.resolutionsStdin ? '-' : undefined;
      const planMode = options._planMode ?? rootOptions.plan;
      const applyPath = options._applyPath ?? rootOptions.apply ?? deprecatedApplyStdin;
      const resolutionsPath = options._resolutionsPath ?? rootOptions.resolutions ?? deprecatedResolutionsStdin;

      if (rootOptions.applyStdin) {
        output.info('Deprecated alias: use --apply -', { deprecated: '--apply-stdin', replacement: '--apply -' });
      }
      if (rootOptions.resolutionsStdin) {
        output.info('Deprecated alias: use --resolutions -', { deprecated: '--resolutions-stdin', replacement: '--resolutions -' });
      }

      if (!urlOrPath && !options.self) {
        if (process.stdout.isTTY) {
          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

          const choice = await select({
            message: 'What would you like to install?',
            choices: [
              { name: 'Built-in syncskill skill', value: 'self' },
              { name: 'From a URL or local path', value: 'url' },
              { name: 'Cancel', value: 'cancel' }
            ]
          });

          if (choice === 'self') {
            options.self = true;
          } else if (choice === 'url') {
            urlOrPath = await input({ message: 'Enter URL or path:' });
          } else {
            return;
          }
        } else {
          program.commands.find(c => c.name() === 'install')?.help();
          return;
        }
      }

      const selfPathExists = urlOrPath === 'self' ? await pathExists(resolve('./self')) : false;
      const isSelfInstall = options.self || (urlOrPath === 'self' && !selfPathExists);
      const isPlanOperation = Boolean(planMode || applyPath);
      const isSimpleCase = Boolean(options.self || urlOrPath === 'self');

      if (isPlanOperation && isSimpleCase) {
        const planOptions: PlanExecuteOptions = {
          plan: planMode,
          apply: applyPath,
          resolutions: resolutionsPath,
          yes: options.yes
        };

        const deprecations: string[] = [];
        if (rootOptions.applyStdin) {
          deprecations.push('--apply-stdin');
        }
        if (rootOptions.resolutionsStdin) {
          deprecations.push('--resolutions-stdin');
        }

        const result = await withPlanExecute({
          buildPlan: () => buildInstallPlan(resolvedHomeDir, urlOrPath, options),
          executePlan: (plan, resolutions) => executeInstallPlan(resolvedHomeDir, plan, resolutions, deprecations),
          options: planOptions
        });

        if (result.planOnly && result.plan) {
          console.log(serializePlan(result.plan));
        }
        return;
      }

      if (isSelfInstall) {
        const result = await installSyncskillSkill(resolvedHomeDir);

        if (result.alreadyInstalled) {
          output.info('syncskill skill already installed');
          output.result(true, {
            installed: false,
            skill: 'syncskill',
            alreadyInstalled: true,
            linkedAgents: result.linkedAgents ?? []
          });
          return;
        }

        output.change('add', 'skill', 'syncskill', { target: result.installedPath });
        if (result.linkedAgents && result.linkedAgents.length > 0) {
          output.info(`Linked to: ${result.linkedAgents.join(', ')}`);
        }
        output.result(true, {
          installed: true,
          skill: 'syncskill',
          path: result.installedPath,
          linkedAgents: result.linkedAgents ?? []
        });
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
            output.info('All skills from this source already exist.');
            return [];
          }

          if (options.yes) {
            return available.map(s => s.name);
          }

          console.log(`\nFound ${skills.length} skill(s):\n`);

          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

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
    if (isNoInteractive(program)) {
      failForNoInteractive();
    }

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
      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      console.log('Note: "config link" is deprecated. Use "syncskill link" instead.');
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
    });

  configCommand
    .command('server')
    .description('Manage remote servers')
    .action(async () => {
      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'server' });
    });

  configCommand
    .command('remote')
    .description('Edit skill → server sync mapping (matrix editor)')
    .action(async () => {
      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'remote' });
    });

  program
    .command('scan')
    .description('Scan for new skills in sources and ~/.syncskill/skills/, check for unmanaged agent skills')
    .option('--migrate-unmanaged', 'Migrate unmanaged skills from agent directories to ~/.syncskill/skills/')
    .option('--dry-run', 'Preview scan results without making changes')
    .action(async (options: { migrateUnmanaged?: boolean; dryRun?: boolean }) => {
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
          if (options.migrateUnmanaged) {
            console.log(`\n[dry-run] Would migrate ${unmanaged.length} skill(s) to ~/.syncskill/skills/`);
          }
        } else if (options.migrateUnmanaged) {
          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

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
          console.log('\nUse `syncskill scan --migrate-unmanaged` to migrate unmanaged skills.');
        }
      }

      // Generate skills-index.json (skip in dry-run mode)
      if (!isDryRun) {
        const index = await buildSkillsIndex(resolvedHomeDir);
        await saveSkillsIndex(resolvedHomeDir, index);
      }
    });

  async function ensureLinkCommandReady(): Promise<SyncSkillConfig> {
    const config = await loadConfig(resolvedHomeDir);
    const { skillsDir } = getSyncPaths(resolvedHomeDir);
    await autoDiagnoseConfig(config, skillsDir);
    return config;
  }

  function validateTargetAgents(config: SyncSkillConfig, targets: string[]): void {
    for (const agent of targets) {
      if (agent === '*') {
        continue;
      }

      if (!config.agents[agent]) {
        console.error(`Error: Agent '${agent}' not configured`);
        process.exit(1);
        return;
      }
    }
  }

  function normalizeSkillTargets(config: SyncSkillConfig, targets: string[]): string[] {
    if (targets.includes('*')) {
      return ['*'];
    }

    validateTargetAgents(config, targets);
    return [...new Set(targets)].sort();
  }

  async function saveSkillTargets(skill: string, targets: string[]): Promise<SyncSkillConfig> {
    const config = await ensureLinkCommandReady();
    config.links[skill] = normalizeSkillTargets(config, targets);
    await saveConfig(config, resolvedHomeDir);
    return config;
  }

  async function applySkillLinks(skill: string, options: { dryRun?: boolean; yes?: boolean }): Promise<void> {
    if (options.dryRun) {
      console.log(`[dry-run] Would link ${skill}`);
      const staleBySkill = await findStaleLinks(resolvedHomeDir, [skill]);
      await displayStaleLinksPreview(staleBySkill);
      return;
    }

    const results = await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skill });
    const agents = results.map((result) => result.agent);
    if (agents.length > 0) {
      console.log(`✓ Linked ${skill} to: ${agents.join(', ')}`);
    }
    await handleStaleLinksReconciliation(resolvedHomeDir, [skill], options);
  }

  const linkCommand = program
    .command('link')
    .description('Manage skill-to-agent links')
    .action(async () => {
      await ensureLinkCommandReady();

      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      if (!process.stdout.isTTY) {
        linkCommand.outputHelp();
        return;
      }

      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
    });

  linkCommand
    .command('list')
    .alias('ls')
    .description('Show link status matrix')
    .option('-v, --verbose', 'Show text status instead of symbols')
    .action(async (options: { verbose?: boolean }) => {
      const config = await ensureLinkCommandReady();
      const statuses = await collectLinkStatus(resolvedHomeDir);
      console.log(formatLinkStatusMatrix(statuses, options.verbose ?? false, config.private_agents));
    });

  linkCommand
    .command('edit [skill]')
    .description('Open matrix editor for humans')
    .action(async (skill: string | undefined) => {
      const config = await ensureLinkCommandReady();

      if (!process.stdout.isTTY) {
        console.error('Error: link edit requires an interactive terminal.');
        console.error('Use `syncskill link set <skill> <agents...>` or `syncskill link add <skill> <agent>` instead.');
        process.exit(1);
        return;
      }

      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      if (!skill) {
        await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
        return;
      }

      const allAgents = Object.keys(config.agents).sort();
      const currentTargets = config.links[skill] ?? [];
      const selectedAgents = await checkbox({
        message: `${skill} is currently linked to:\n`,
        choices: allAgents.map((agent) => ({
          name: agent,
          value: agent,
          checked: currentTargets.includes('*') || currentTargets.includes(agent)
        }))
      });

      const previousAgents = new Set(currentTargets.includes('*') ? allAgents : currentTargets);
      const nextAgents = [...selectedAgents].sort();
      config.links[skill] = nextAgents;
      await saveConfig(config, resolvedHomeDir);
      await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skill });
      await handleStaleLinksReconciliation(resolvedHomeDir, [skill], {});

      const linkedAgents = nextAgents.filter((agent) => !previousAgents.has(agent));
      const unlinkedAgents = [...previousAgents].filter((agent) => !nextAgents.includes(agent)).sort();
      const changes: string[] = [];
      if (linkedAgents.length > 0) {
        changes.push(`linked to ${linkedAgents.join(', ')}`);
      }
      if (unlinkedAgents.length > 0) {
        changes.push(`unlinked from ${unlinkedAgents.join(', ')}`);
      }
      console.log(`✓ Updated ${skill}${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`);
    });

  linkCommand
    .command('set <skill> <agents...>')
    .description('Set skill targets declaratively')
    .option('--dry-run', 'Preview changes without applying')
    .option('-y, --yes', 'Auto-confirm stale link removal')
    .action(async (skill: string, agents: string[], options: { dryRun?: boolean; yes?: boolean }) => {
      const config = await ensureLinkCommandReady();
      const nextTargets = normalizeSkillTargets(config, agents);

      if (options.dryRun) {
        console.log(`[dry-run] Would set ${skill} targets to ${nextTargets.join(', ')}`);
        return;
      }

      config.links[skill] = nextTargets;
      await saveConfig(config, resolvedHomeDir);
      await applySkillLinks(skill, options);
    });

  linkCommand
    .command('add <skill> <agent>')
    .description('Add agent to skill targets')
    .option('--dry-run', 'Preview changes without applying')
    .option('-y, --yes', 'Auto-confirm stale link removal')
    .action(async (skill: string, agent: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const config = await ensureLinkCommandReady();
      validateTargetAgents(config, [agent]);

      const currentTargets = config.links[skill] ?? [];
      const nextTargets = currentTargets.includes('*') || currentTargets.includes(agent)
        ? currentTargets
        : [...currentTargets, agent].sort();

      if (options.dryRun) {
        console.log(`[dry-run] Would link ${skill} to ${agent}`);
        const staleBySkill = await findStaleLinks(resolvedHomeDir, [skill]);
        await displayStaleLinksPreview(staleBySkill);
        return;
      }

      config.links[skill] = nextTargets;
      await saveConfig(config, resolvedHomeDir);
      await applySkillLinks(skill, options);
    });

  linkCommand
    .command('remove <skill> <agent>')
    .description('Remove agent from skill targets')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, agent: string, options: { dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      validateTargetAgents(config, [agent]);

      const currentTargets = expandTargetAgents(config, config.links[skill] ?? []);
      const nextTargets = currentTargets.filter((target) => target !== agent);

      if (options.dryRun) {
        console.log(`[dry-run] Would remove ${agent} from ${skill}`);
        return;
      }

      config.links[skill] = nextTargets;
      await saveConfig(config, resolvedHomeDir);
      await unlinkSkillFromAgent(resolvedHomeDir, skill, agent);
      console.log(`✓ Removed ${agent} from ${skill}`);
    });

  linkCommand
    .command('clear <skill>')
    .description('Remove all links for a skill')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, options: { yes?: boolean; dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      const agents = [...new Set(expandTargetAgents(config, config.links[skill] ?? []))].sort();

      if (options.dryRun) {
        console.log(`[dry-run] Would unlink ${skill} from all agents (${agents.join(', ')})`);
        return;
      }

      if (!options.yes) {
        if (isNoInteractive(program)) {
          failForNoInteractive();
        }

        const confirmed = await confirm({
          message: `Unlink ${skill} from all agents (${agents.join(', ')})?`,
          default: false,
        });
        if (!confirmed) {
          console.log('Cancelled.');
          return;
        }
      }

      await unlinkSkill(resolvedHomeDir, skill);
      config.links[skill] = [];
      await saveConfig(config, resolvedHomeDir);
      console.log(`✓ Unlinked ${skill} from all agents (${agents.join(', ')})`);
    });

  linkCommand
    .command('build')
    .alias('apply')
    .description('Reconcile symlinks to match config')
    .option('--dry-run', 'Preview changes without applying')
    .option('-y, --yes', 'Auto-confirm stale link removal')
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      setCommandName('link build');
      const output = getGlobalOutput();
      const config = await ensureLinkCommandReady();

      if (options.dryRun) {
        output.info('[dry-run] Would link all configured skills');
        const staleBySkill = await findStaleLinks(resolvedHomeDir);
        await displayStaleLinksPreview(staleBySkill);
        return;
      }

      const staleBySkill = await findStaleLinks(resolvedHomeDir);
      const plan = buildLinkBuildPlan(resolvedHomeDir, config, staleBySkill);
      const results = await linkConfiguredSkills(resolvedHomeDir, { all: true });
      const skillCount = new Set(results.map(r => r.skill)).size;
      output.info(`Linked ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
      const cleanupSummary = await handleStaleLinksReconciliation(resolvedHomeDir, undefined, options);
      output.result(true, summarizeLinkBuild(resolvedHomeDir, config, results, cleanupSummary.removed, plan));
    });

  program
    .command('unlink <skill>')
    .description('Remove all skill links (alias for "link clear")')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, options: { yes?: boolean; dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      const agents = [...new Set(expandTargetAgents(config, config.links[skill] ?? []))].sort();

      if (agents.length === 0) {
        console.log(`No links found for "${skill}".`);
        return;
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would unlink ${skill} from all agents (${agents.join(', ')})`);
        console.log(`[dry-run] Would remove "${skill}" from config links.`);
        return;
      }

      if (!options.yes) {
        if (isNoInteractive(program)) {
          failForNoInteractive();
        }

        const confirmed = await confirm({
          message: `Unlink ${skill} from all agents (${agents.join(', ')})?`,
          default: false,
        });
        if (!confirmed) {
          console.log('Cancelled.');
          return;
        }
      }

      await unlinkSkill(resolvedHomeDir, skill);
      delete config.links[skill];
      await saveConfig(config, resolvedHomeDir);
      console.log(`✓ Unlinked ${skill} from all agents (${agents.join(', ')})`);
      console.log(`✓ Removed "${skill}" from config links.`);
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
  ): Promise<StaleLinkCleanupSummary> {
    const output = getGlobalOutput();
    const staleBySkill = await findStaleLinks(homeDir, skillNames);
    const allStale = Object.values(staleBySkill).flat();

    if (allStale.length === 0) {
      return { staleBySkill, removed: [], errors: [] };
    }

    const config = await loadConfig(homeDir);

    if (skillNames && skillNames.length === 1) {
      const skillName = skillNames[0];
      const staleLinks = staleBySkill[skillName] ?? [];
      if (staleLinks.length === 0) {
        return { staleBySkill, removed: [], errors: [] };
      }

      const agents = staleLinks.map(l => l.agent).join(', ');

      if (options.dryRun) {
        output.info(`[dry-run] Would remove ${skillName} from: ${agents}`);
        return { staleBySkill, removed: [], errors: [] };
      }

      let shouldRemove = options.yes;
      if (!shouldRemove) {
        if (isNoInteractive(program)) {
          failForNoInteractive();
        }

        shouldRemove = await confirm({
          message: `Remove ${skillName} from ${agents}? (no longer in config)`,
          default: true
        });
      }

      if (!shouldRemove) {
        return { staleBySkill, removed: [], errors: [] };
      }

      const result = await reconcileStaleLinks(homeDir, skillNames, config);
      if (result.removed.length > 0) {
        output.info('Removed stale links');
      }
      if (result.errors.length > 0) {
        output.info(`Failed to remove ${result.errors.length} link(s)`);
      }

      return {
        staleBySkill,
        removed: collectRemovedLinks(staleBySkill, result.removed),
        errors: result.errors
      };
    }

    output.info('Links to remove (no longer in config):');
    for (const [skillName, links] of Object.entries(staleBySkill)) {
      const agents = links.map(l => l.agent).join(', ');
      output.info(`  ${skillName}: ${agents}`);
    }

    if (options.dryRun) {
      output.info(`[dry-run] Would remove ${allStale.length} link${allStale.length !== 1 ? 's' : ''}`);
      return { staleBySkill, removed: [], errors: [] };
    }

    let shouldRemove = options.yes;
    if (!shouldRemove) {
      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

      shouldRemove = await confirm({
        message: `Remove ${allStale.length} link${allStale.length !== 1 ? 's' : ''}?`,
        default: true
      });
    }

    if (!shouldRemove) {
      return { staleBySkill, removed: [], errors: [] };
    }

    const result = await reconcileStaleLinks(homeDir, [], config);
    if (result.removed.length > 0) {
      output.info(`Removed ${result.removed.length} stale link${result.removed.length !== 1 ? 's' : ''}`);
    }
    if (result.errors.length > 0) {
      output.info(`Failed to remove ${result.errors.length} link(s)`);
    }

    return {
      staleBySkill,
      removed: collectRemovedLinks(staleBySkill, result.removed),
      errors: result.errors
    };
  }

  function setCommandName(name: string): void {
    getGlobalOutput().setCommand(name);
  }

  const sourceCommand = program.command('source').description('Manage external skill sources and source recovery');

  sourceCommand
    .command('list')
    .alias('ls')
    .description('List configured sources')
    .action(async () => {
      for (const line of formatSourceListLines(await listSourcesWithDetails(resolvedHomeDir))) {
        console.log(line);
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
      setCommandName('source remove');
      const output = getGlobalOutput();
      const config = await loadConfig(resolvedHomeDir);
      const sourceRaw = config.sources[name];

      if (!sourceRaw) {
        console.error(`Source not found: ${name}`);
        process.exit(1);
      }

      const sourceType = (sourceRaw as Record<string, unknown>).type;
      const isGitSource = sourceType === 'git';

      const ownershipState = await loadSkillOwnershipState(resolvedHomeDir);
      const localSkills = new Set(await listLocalSkillNames(resolvedHomeDir));
      const orphans = findOrphanSkills(name, config, ownershipState, localSkills);
      const ownedSkills = Object.entries(ownershipState.owners)
        .filter(([, owner]) => owner === name)
        .map(([skill]) => skill)
        .sort();

      if (ownedSkills.length > 0) {
        output.info(`Skills provided by source "${name}":`);
        for (const skill of ownedSkills) {
          const isOrphan = orphans.includes(skill);
          output.info(`  - ${skill}${isOrphan ? ' (orphan - only from this source)' : ''}`);
        }
      } else {
        output.info(`Source "${name}" provides no skills.`);
      }

      let action: RemovalAction;

      if (options.force) {
        action = RemovalAction.RemoveAll;
      } else {
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

      if (action === RemovalAction.RemoveAll && orphans.length > 0) {
        const confirmed = await confirm({
          message: `This will permanently delete ${orphans.length} orphan skill(s). Continue?`,
          default: false,
        });
        if (!confirmed) {
          output.info('Cancelled.');
          return;
        }
      }

      await removeSource(resolvedHomeDir, name, { action });

      switch (action) {
        case RemovalAction.ConvertToLocal:
          output.info(`Converted source "${name}" to local type.`);
          break;
        case RemovalAction.RemoveConfigKeepFiles:
          output.info(`Removed source "${name}" (skill files kept on disk).`);
          break;
        case RemovalAction.RemoveAll:
          output.info(`Removed source "${name}" and all associated files.`);
          break;
      }

      output.result(true, summarizeSourceRemoval(resolvedHomeDir, name, action, config, ownedSkills));
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


  program
    .command('remote')
    .description('Edit skill → server sync mapping (matrix editor)')
    .action(async () => {
      if (isNoInteractive(program)) {
        failForNoInteractive();
      }

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
          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

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
          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

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
    .addOption(new Option('--pull-backup').hideHelp())
    .option('--no-pull-backup', 'Skip pre-pull backups before overwriting or deleting local skills')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; timeout?: number; pullBackup?: boolean; yes?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      // Auto-check config health
      const { skillsDir } = getSyncPaths(resolvedHomeDir);
      await autoDiagnoseConfig(config, skillsDir);

      const allServers = Object.keys(config.servers);

      const targetServers = await selectTargetServers(allServers, server, options, 'push');
      if (!targetServers) return;

      const results = await pushToServers(resolvedHomeDir, targetServers, {
        dryRun: options.dryRun,
        noRefresh: !program.opts<{ refresh: boolean }>().refresh,
        timeout: options.timeout,
        pullBackup: options.pullBackup,
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
    .option('--cross-server-policy <policy>', 'How to resolve cross-server conflicts: first-wins, last-wins, abort, prompt, or server:<name>')
    .option('--on-conflict <policy>', 'How to resolve per-server conflicts: keep-local, keep-remote, skip, abort', parseOnConflict)
    .option('--on-deletion <policy>', 'How to handle remote deletions: keep-local, delete, prompt', parseOnDeletion)
    .addOption(new Option('--pull-backup').hideHelp())
    .option('--no-pull-backup', 'Skip pre-pull backups before overwriting or deleting local skills')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (
      server: string | undefined,
      options: {
        all?: boolean;
        dryRun?: boolean;
        timeout?: number;
        pullBackup?: boolean;
        yes?: boolean;
        crossServerPolicy?: string;
        onConflict?: 'keep-local' | 'keep-remote' | 'skip' | 'abort';
        onDeletion?: 'keep-local' | 'delete' | 'prompt';
      }
    ) => {
      try {
        const config = await loadConfig(resolvedHomeDir);
        const { skillsDir } = getSyncPaths(resolvedHomeDir);
        await autoDiagnoseConfig(config, skillsDir);

        const allServers = Object.keys(config.servers);
        const targetServers = await selectTargetServers(allServers, server, {
          ...options,
          noInteractive: isNoInteractive(program)
        }, 'pull');
        if (!targetServers) return;

        const results = await pullFromServers(resolvedHomeDir, targetServers, {
          dryRun: options.dryRun,
          timeout: options.timeout,
          pullBackup: options.pullBackup,
          yes: options.yes,
          noInteractive: isNoInteractive(program),
          crossServerPolicy: options.crossServerPolicy,
          onConflict: options.onConflict,
          onDeletion: options.onDeletion
        });

        for (const result of results) {
          for (const line of formatSkillRows('pull', result)) {
            console.log(line);
          }
        }
      } catch (error) {
        handleSyncCommandError(error);
      }
    });

  program
    .command('sync [server]')
    .description('Pull then push changes for one server or all configured servers')
    .option('--all', 'Sync all configured servers')
    .option('--dry-run', 'Preview changes without syncing')
    .option('--timeout <seconds>', 'Per-server SSH timeout in seconds', parseInteger)
    .option('--cross-server-policy <policy>', 'How to resolve cross-server conflicts: first-wins, last-wins, abort, prompt, or server:<name>')
    .option('--on-conflict <policy>', 'How to resolve per-server conflicts: keep-local, keep-remote, skip, abort', parseOnConflict)
    .option('--on-deletion <policy>', 'How to handle remote deletions: keep-local, delete, prompt', parseOnDeletion)
    .addOption(new Option('--pull-backup').hideHelp())
    .option('--no-pull-backup', 'Skip pre-pull backups before overwriting or deleting local skills')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (
      server: string | undefined,
      options: {
        all?: boolean;
        dryRun?: boolean;
        timeout?: number;
        pullBackup?: boolean;
        yes?: boolean;
        crossServerPolicy?: string;
        onConflict?: 'keep-local' | 'keep-remote' | 'skip' | 'abort';
        onDeletion?: 'keep-local' | 'delete' | 'prompt';
      }
    ) => {
      try {
        const config = await loadConfig(resolvedHomeDir);
        const { skillsDir } = getSyncPaths(resolvedHomeDir);
        await autoDiagnoseConfig(config, skillsDir);

        const allServers = Object.keys(config.servers);
        const globalOptions = program.opts<{ refresh: boolean }>();
        const targetServers = await selectTargetServers(allServers, server, {
          ...options,
          noInteractive: isNoInteractive(program)
        }, 'sync');
        if (!targetServers) return;

        const results = await syncServers(resolvedHomeDir, targetServers, {
          dryRun: options.dryRun,
          noRefresh: !globalOptions.refresh,
          timeout: options.timeout,
          pullBackup: options.pullBackup,
          yes: options.yes,
          noInteractive: isNoInteractive(program),
          crossServerPolicy: options.crossServerPolicy,
          onConflict: options.onConflict,
          onDeletion: options.onDeletion
        });

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

        const allConflicts: Array<{ server: string; skill: string }> = [];
        for (const result of results) {
          for (const skill of result.pull.conflicted_skills) {
            allConflicts.push({ server: result.server, skill });
          }
          for (const skill of result.push.conflicted_skills) {
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
      } catch (error) {
        handleSyncCommandError(error);
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
        const shouldFix = options.yes || (await (async () => {
          if (isNoInteractive(program)) {
            failForNoInteractive();
          }

          return confirm({
            message: `${item.suggestion ?? `Fix ${item.path}`}?`,
            default: true
          });
        })());

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
