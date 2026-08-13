#!/usr/bin/env node

import { cp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { checkbox, select, confirm } from '@inquirer/prompts';
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
      return failWithOutputError('E_REMOTE_NOT_FOUND', `Remote not found: ${server}`, 'Use `syncskill remote list` to inspect configured remotes');
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

async function prepareSyncTargetServers(
  homeDir: string,
  server: string | undefined,
  options: { all?: boolean; yes?: boolean },
  action: 'push' | 'pull' | 'sync',
  noInteractive?: boolean
): Promise<string[] | null> {
  const config = await loadConfig(homeDir);

  return selectTargetServers(Object.keys(config.servers), server, {
    ...options,
    noInteractive
  }, action);
}

import { applyResolution, reconcileManifest } from './core/conflict.js';
import { computeDefaultLinkTargets, listSelectableAgentNames } from './core/private-agents.js';
import {
  autoDiagnoseConfig,
  diagnoseConfig,
  formatDiagnosticReport,
  repairConfig,
  repairRegistry,
  isRegistryDiagnostic,
  DiagnosticCode,
  type RepairOptions
} from './config/config-doctor.js';
import { buildExternalInstallPlan, executeExternalInstallPlan, installSyncskillSkill } from './install.js';
import { expandMaterializedTargetAgents, expandTargetAgents, getConfigPaths, getConfiguredServer, getSyncPaths, loadConfig, parseConfigValue, resolveAgentPath, saveConfig, setConfigValue, type SyncSkillConfig } from './config/config.js';
import { createPromptApi, runConfigUi } from './config/config-ui.js';
import { collectLinkStatus, discoverSkills, findStaleLinks, findUnmanagedSkills, formatLinkStatusMatrix, linkConfiguredSkills, listLocalSkills, reconcileStaleLinks, unlinkSkill, unlinkSkillFromAgent, type StaleLinksBySkill } from './linker.js';
import { listLocalSkillNames, loadServerManifest, saveServerManifest } from './core/manifest.js';
import {
  expandReceiverLinkAgents,
  formatRemoteAgentLines,
  formatRemoteLinkLines,
  formatServerListLines,
  formatServerShowLines,
  listServers,
  loadReceiverBackup,
  loadReceiverBackupIfExists,
  mutateReceiverBackup,
  snapshotReceiverBackupState,
  showServer,
} from './core/server.js';
import { initializeRepo } from './repo.js';
import { getPullBackupDir, getRestorePreBackupDir, restoreSkillFromPullBackup } from './utils/backup.js';
import { pathExists } from './utils/utils.js';
import { takeOverRemoteSkill } from './core/transport.js';
import {
  autoRefreshManifests,
  buildStatusJson,
  formatDiffLines,
  formatStatusLines,
  listTrackedServers,
  loadTrackedManifests,
  refreshStoredManifests
} from './refresh.js';
import {
  addSourceFromUrl,
  findOrphanSkills,
  formatSourceListLines,
  listSourcesWithDetails,
  loadSkillOwnershipState,
  RemovalAction,
  removeSource,
  scanSkillsInSource,
  SourceType,
  updateAllSources,
  updateSource,
  buildSkillsRegistry,
} from './source.js';
import { rebuildRegistryV2 } from './core/registry-builder.js';
import { saveSkillsRegistryV2 } from './core/skills-registry.js';
import { pullFromServer, pullFromServers, pushToServers, syncServers, type PullResult, type PushResult, type SyncResult } from './core/sync_engine.js';
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

function shouldSkipCommandPreflight(command: Command): boolean {
  const commandPath = getCommandPath(command);
  const skipCommands = [
    '',
    'init',
    'config',
    'config show',
    'config set',
    'config link',
    'config remote',
    'refresh',
    'doctor',
    'restore'
  ];
  return skipCommands.includes(commandPath);
}

async function runCommandPreflight(homeDir: string): Promise<void> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  await autoDiagnoseConfig(config, skillsDir, homeDir);
}

function failForNeedsInput(message: string, hint: string): never {
  return failWithOutputError('E_NEEDS_INPUT', message, hint);
}

function failForAgentNotConfigured(agent: string): never {
  return failWithOutputError('E_AGENT_NOT_CONFIGURED', `Agent '${agent}' not configured`);
}

function formatNoReceiverBackupNoOp(server: string): string {
  return `Receiver backup does not exist for ${server}; no-op.`;
}

function normalizeReceiverLinkTargets(remoteAgents: Record<string, string>, targets: string[]): string[] {
  if (targets.includes('*')) {
    return Object.keys(remoteAgents).sort();
  }

  return [...new Set(targets)].sort();
}

async function removeAllSkillLinks(homeDir: string, skill: string, config: SyncSkillConfig): Promise<void> {
  await unlinkSkill(homeDir, skill);
  delete config.links[skill];
  await saveConfig(config, homeDir);
}

type ReceiverBackupMutation = Awaited<ReturnType<typeof mutateReceiverBackup>>;
type ReceiverBackupSnapshot = NonNullable<ReceiverBackupMutation>;

function resolveMaterializedAgentPath(config: SyncSkillConfig, agent: string, homeDir: string): string {
  if (agent === 'agents') {
    return join(homeDir, '.agents', 'skills');
  }

  return resolveAgentPath(config.agents[agent], homeDir);
}

function getLinkedAgentsForSkill(config: SyncSkillConfig, skill: string): string[] {
  return [...new Set(expandMaterializedTargetAgents(config, config.links[skill] ?? []))].sort();
}

async function executeRemoveAllSkillLinks(
  homeDir: string,
  program: Command,
  skill: string,
  config: SyncSkillConfig,
  options: { yes?: boolean; dryRun?: boolean },
  behavior: {
    verb: string;
    showNoLinksMessage?: boolean;
    getDryRunLines: (skill: string, agents: string[]) => string[];
  }
): Promise<void> {
  const agents = getLinkedAgentsForSkill(config, skill);

  if (agents.length === 0 && behavior.showNoLinksMessage) {
    console.log(`No links found for "${skill}".`);
    return;
  }

  if (options.dryRun) {
    for (const line of behavior.getDryRunLines(skill, agents)) {
      console.log(line);
    }
    return;
  }

  ensureDestructiveVerbAllowed(program, behavior.verb, options);

  if (!shouldSkipLinkRemovalPrompt(program, options)) {
    const confirmed = await confirm({
      message: `Unlink ${skill} from all agents (${agents.join(', ')})?`,
      default: false,
    });
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
  }

  await removeAllSkillLinks(homeDir, skill, config);
  logLinkRemovalSummary(skill, agents);
}

async function removeReceiverAgentLinks(homeDir: string, serverName: string, agentName: string): Promise<{
  backup: ReceiverBackupMutation;
  before: Record<string, unknown> | null;
  changed: boolean;
}> {
  let before: Record<string, unknown> | null = null;
  let changed = true;
  const backup = await mutateReceiverBackup(
    homeDir,
    serverName,
    (currentBackup) => {
      const hadAgent = agentName in currentBackup.remote_agents;
      const previousAgents = Object.keys(currentBackup.remote_agents).sort();
      before = snapshotReceiverBackupState(currentBackup, 'remote_agents') as Record<string, unknown>;

      delete currentBackup.remote_agents[agentName];
      for (const [skillName, targets] of Object.entries(currentBackup.links)) {
        currentBackup.links[skillName] = targets.includes('*')
          ? previousAgents.filter((target) => target !== agentName)
          : targets.filter((target) => target !== agentName);
      }

      if (!hadAgent && previousAgents.every((target) => !Object.values(currentBackup.links).some((targets) => targets.includes(target)))) {
        changed = false;
        return false;
      }
    },
    { createIfMissing: false }
  );

  return { backup, before, changed };
}

async function removeReceiverSkillLink(homeDir: string, serverName: string, skill: string, agentName?: string): Promise<{
  backup: ReceiverBackupMutation;
  before: Record<string, unknown> | null;
  changed: boolean;
}> {
  let before: Record<string, unknown> | null = null;
  let changed = true;
  const backup = await mutateReceiverBackup(
    homeDir,
    serverName,
    (currentBackup) => {
      const currentTargets = currentBackup.links[skill] ?? [];
      if (currentTargets.length === 0 && agentName !== undefined) {
        changed = false;
        return false;
      }

      before = snapshotReceiverBackupState(currentBackup, 'links') as Record<string, unknown>;
      currentBackup.links[skill] = agentName === undefined
        ? []
        : normalizeReceiverLinkTargets(
            currentBackup.remote_agents,
            currentTargets.includes('*')
              ? Object.keys(currentBackup.remote_agents).filter((target) => target !== agentName)
              : currentTargets.filter((target) => target !== agentName)
          );
    },
    { createIfMissing: false }
  );

  return { backup, before, changed };
}

function emitReceiverBackupNoOp(serverName: string): void {
  const output = getGlobalOutput();
  output.info(formatNoReceiverBackupNoOp(serverName));
}

function emitReceiverBackupNoOpResult(program: Command, serverName: string, op: string): void {
  emitReceiverBackupNoOp(serverName);
  if (hasJsonOutputEnabled(program)) {
    getGlobalOutput().result(true, {
      server: serverName,
      op,
      noop: true,
      reason: 'receiver-backup-missing'
    });
  }
}

function emitReceiverBackupMutationResult(
  program: Command,
  backup: ReceiverBackupSnapshot,
  payload: { server: string; op: string; before: Record<string, unknown>; after: Record<string, unknown> },
  formatLines: (backup: ReceiverBackupSnapshot) => string[]
): void {
  if (hasJsonOutputEnabled(program)) {
    getGlobalOutput().result(true, {
      data: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    });
    return;
  }

  for (const line of formatLines(backup)) {
    console.log(line);
  }
}

function logLinkRemovalSummary(skill: string, agents: string[]): void {
  console.log(`✓ Unlinked ${skill} from all agents (${agents.join(', ')})`);
  console.log(`✓ Removed "${skill}" from config links.`);
}

function hasJsonOutputEnabled(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json === true;
}

function shouldSkipLinkRemovalPrompt(program: Command, options: { yes?: boolean }): boolean {
  return options.yes === true || isNoInteractive(program) === true || hasJsonOutputEnabled(program);
}

function shouldSkipInstallPreflight(command: Command): boolean {
  return getCommandPath(command) === 'install';
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
      const agents = expandMaterializedTargetAgents(config, config.links[skill] ?? []);
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
    const agents = expandMaterializedTargetAgents(config, config.links[skill] ?? []);

    for (const agent of agents) {
      plan = addAction(plan, {
        op: 'create-symlink',
        skill,
        agent,
        from: join(skillsDir, skill),
        to: join(resolveMaterializedAgentPath(config, agent, homeDir), skill)
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
          path: join(resolveMaterializedAgentPath(config, result.agent, homeDir), skill),
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

function summarizePushResults(results: PushResult[]): Record<string, unknown> {
  const pushed = results.flatMap((result) => result.pushed_skills.map((skill) => ({ skill, server: result.server })));
  const skipped = results.flatMap((result) => result.skipped_skills.map((skill) => ({ skill, server: result.server })));
  const conflicts = results.flatMap((result) => result.conflicted_skills.map((skill) => ({ skill, server: result.server })));
  const servers = results.map((result) => ({
    server: result.server,
    ok: true,
    pushed: result.pushed_skills.length,
    pulled: 0,
    skipped: result.skipped_skills.length,
    conflicts: result.conflicted_skills.length
  }));

  return {
    pushed: pushed.length,
    pulled: 0,
    skipped: skipped.length,
    conflicts: conflicts.length,
    warnings: 0,
    data: {
      servers,
      pushed,
      pulled: [],
      deleted: [],
      skipped,
      conflicts,
      failed: [],
      changes: pushed.map((entry) => ({ op: 'push', ...entry })),
      backups: []
    }
  };
}

function summarizePullResults(results: PullResult[]): Record<string, unknown> {
  const pulled = results.flatMap((result) => result.pulled_skills.map((skill) => ({ skill, server: result.server })));
  const deleted = results.flatMap((result) => (result.deleted_skills ?? []).map((skill) => ({ skill, server: result.server })));
  const skipped = results.flatMap((result) => result.skipped_skills.map((skill) => ({ skill, server: result.server })));
  const conflicts = results.flatMap((result) => result.conflicted_skills.map((skill) => ({ skill, server: result.server })));
  const backups = results.flatMap((result) => result.backups ?? []);
  const servers = results.map((result) => ({
    server: result.server,
    ok: true,
    pushed: 0,
    pulled: result.pulled_skills.length,
    skipped: result.skipped_skills.length,
    conflicts: result.conflicted_skills.length
  }));

  return {
    pushed: 0,
    pulled: pulled.length,
    skipped: skipped.length,
    conflicts: conflicts.length,
    warnings: 0,
    data: {
      servers,
      pushed: [],
      pulled,
      deleted,
      skipped,
      conflicts,
      failed: [],
      changes: [
        ...pulled.map((entry) => ({ op: 'pull', ...entry })),
        ...deleted.map((entry) => ({ op: 'delete', ...entry }))
      ],
      backups
    }
  };
}

function summarizeSyncResults(results: SyncResult[]): Record<string, unknown> {
  const pushed = results.flatMap((result) => result.push.pushed_skills.map((skill) => ({ skill, server: result.server })));
  const pulled = results.flatMap((result) => result.pull.pulled_skills.map((skill) => ({ skill, server: result.server })));
  const deleted = results.flatMap((result) => (result.pull.deleted_skills ?? []).map((skill) => ({ skill, server: result.server })));
  const skipped = results.flatMap((result) => [
    ...result.pull.skipped_skills.map((skill) => ({ skill, server: result.server, phase: 'pull' })),
    ...result.push.skipped_skills.map((skill) => ({ skill, server: result.server, phase: 'push' }))
  ]);
  const conflictMap = new Map<string, { skill: string; server: string }>();
  for (const result of results) {
    for (const skill of [...result.pull.conflicted_skills, ...result.push.conflicted_skills]) {
      conflictMap.set(`${result.server}:${skill}`, { skill, server: result.server });
    }
  }
  const conflicts = [...conflictMap.values()];
  const backups = results.flatMap((result) => result.pull.backups ?? []);
  const servers = results.map((result) => ({
    server: result.server,
    ok: true,
    pushed: result.push.pushed_skills.length,
    pulled: result.pull.pulled_skills.length,
    skipped: result.pull.skipped_skills.length + result.push.skipped_skills.length,
    conflicts: new Set([...result.pull.conflicted_skills, ...result.push.conflicted_skills]).size
  }));

  return {
    pushed: pushed.length,
    pulled: pulled.length,
    skipped: skipped.length,
    conflicts: conflicts.length,
    warnings: 0,
    data: {
      servers,
      pushed,
      pulled,
      deleted,
      skipped,
      conflicts,
      failed: [],
      changes: [
        ...pulled.map((entry) => ({ op: 'pull', ...entry })),
        ...deleted.map((entry) => ({ op: 'delete', ...entry })),
        ...pushed.map((entry) => ({ op: 'push', ...entry }))
      ],
      backups
    }
  };
}

function isNoInteractive(program: Command): true | undefined {
  const options = program.opts<{ noInteractive?: boolean; interactive?: boolean }>();
  return options.noInteractive === true || options.interactive === false ? true : undefined;
}

function isStrictMode(): boolean {
  return loadEnvConfig().strict;
}

function isYesDestructiveEnabled(program: Command): boolean {
  const options = program.opts<{ yesDestructive?: boolean }>();
  return options.yesDestructive === true || process.env.SYNCSKILL_YES_DESTRUCTIVE === '1';
}

function ensureDestructiveVerbAllowed(program: Command, verb: string, options: { yes?: boolean }): void {
  const rootOptions = program.opts<{ json?: boolean }>();
  const requiresNonInteractiveOverride = options.yes === true || isNoInteractive(program) === true || rootOptions.json === true;

  if (!requiresNonInteractiveOverride || isYesDestructiveEnabled(program)) {
    return;
  }

  failWithOutputError(
    'E_USAGE',
    `Destructive command \"${verb}\" requires --yes-destructive in non-interactive mode`,
    `Re-run with --yes-destructive to allow ${verb}`
  );
}

function shouldExitDirtySkip<T>(
  results: T[],
  options: {
    strict: boolean;
    dryRun?: boolean;
    countSkips: (result: T) => number;
    hasSuccessfulTarget: (result: T) => boolean;
  }
): boolean {
  if (options.dryRun) {
    return false;
  }

  const hasAnySkips = results.some((result) => options.countSkips(result) > 0);
  if (!hasAnySkips) {
    return false;
  }

  if (results.length === 1 || options.strict) {
    return true;
  }

  return !results.some((result) => options.hasSuccessfulTarget(result));
}

function countPushSkips(result: PushResult): number {
  return result.skipped_skills.length + result.conflicted_skills.length;
}

function countPullSkips(result: PullResult): number {
  return result.skipped_skills.length + result.conflicted_skills.length;
}

function countSyncSkips(result: { pull: PullResult; push: PushResult }): number {
  return new Set([
    ...result.pull.skipped_skills.map((skill) => `pull:skip:${skill}`),
    ...result.pull.conflicted_skills.map((skill) => `pull:conflict:${skill}`),
    ...result.push.skipped_skills.map((skill) => `push:skip:${skill}`),
    ...result.push.conflicted_skills.map((skill) => `push:conflict:${skill}`)
  ]).size;
}

function hasSuccessfulPushTarget(result: PushResult): boolean {
  return result.pushed_skills.length > 0 || countPushSkips(result) === 0;
}

function hasSuccessfulPullTarget(result: PullResult): boolean {
  return result.pulled_skills.length > 0 || (result.deleted_skills?.length ?? 0) > 0 || countPullSkips(result) === 0;
}

function hasSuccessfulSyncTarget(result: { pull: PullResult; push: PushResult }): boolean {
  return (
    result.pull.pulled_skills.length > 0 ||
    (result.pull.deleted_skills?.length ?? 0) > 0 ||
    result.push.pushed_skills.length > 0 ||
    countSyncSkips(result) === 0
  );
}

function failForNoInteractive(hint?: string): never {
  const fallbackHint = hint ?? 'Use non-interactive flags or remove --no-interactive';
  let exitCode: number = ExitCode.NEEDS_INPUT;

  try {
    const output = getGlobalOutput();
    exitCode = output.error(
      'E_NEEDS_INPUT',
      'This command requires interactive input',
      { hint: fallbackHint }
    );
    output.result(false, { error: 'E_NEEDS_INPUT' });
  } catch {
    console.error('Error: This command requires interactive input');
    console.error(`Hint: ${fallbackHint}`);
  }

  process.exit(exitCode);
  return undefined as never;
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
  let exitCode = errorCodeToExitCode(code);

  try {
    const output = getGlobalOutput();
    exitCode = output.error(code, message, hint ? { hint } : undefined);
    output.result(false, { error: code });
  } catch {
    console.error(message);
    if (hint) {
      console.error(`Hint: ${hint}`);
    }
  }

  process.exit(exitCode);
  return undefined as never;
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

  if (parsed.code === 'E_SERVER_NOT_FOUND' || parsed.code === 'E_REMOTE_NOT_FOUND') {
    return failWithOutputError(parsed.code, parsed.message, 'Use `syncskill remote list` to inspect configured remotes');
  }

  if (parsed.code === 'E_CONFLICT') {
    return failWithOutputError(parsed.code, parsed.message);
  }

  if (parsed.code === 'E_NEEDS_INPUT') {
    return failWithOutputError(parsed.code, parsed.message, 'Use --cross-server-policy / --on-conflict / --on-remote-deletion, or remove --no-interactive');
  }

  if (parsed.code === 'E_USAGE') {
    return failWithOutputError(parsed.code, parsed.message, 'Re-run with --yes-destructive or remove non-interactive flags');
  }

  if (parsed.code === 'E_TAKEOVER_FAILED' || parsed.code === 'E_AGENT_NOT_CONFIGURED') {
    return failWithOutputError(parsed.code, parsed.message);
  }

  throw error;
}

function handleInstallCommandError(error: unknown): never {
  const parsed = parseStructuredError(error);
  if (!parsed) {
    throw error;
  }

  if (parsed.code === 'E_NEEDS_INPUT') {
    return failWithOutputError(parsed.code, parsed.message, 'Use -y / --resolutions, or remove --no-interactive');
  }

  if (parsed.code === 'E_UNRESOLVED') {
    return failWithOutputError(parsed.code, parsed.message, 'Provide --resolutions when using --apply');
  }

  if (parsed.code === 'E_USAGE') {
    return failWithOutputError(parsed.code, parsed.message);
  }

  throw error;
}

// Install-specific plan actions
type InstallAction =
  | { op: 'install-self'; to: string }
  | { op: 'link-skill'; skill: string; agents: string[] };

interface InstallExecutionRuntimeOptions {
  yes?: boolean;
  applyMode?: boolean;
  selectSkills?: (skills: Array<{ name: string; relativePath: string }>, existingSkills: Set<string>) => Promise<string[]>;
}

async function buildInstallPlan(
  homeDir: string,
  urlOrPath: string | undefined,
  options: { self?: boolean; yes?: boolean; name?: string; path?: string; skillSubdir?: string; type?: 'git' | 'http' | 'local'; branch?: string }
): Promise<Plan> {
  let plan = createPlan('install');
  const { skillsDir } = getSyncPaths(homeDir);

  if (options.self || urlOrPath === 'self') {
    const targetPath = join(skillsDir, 'syncskill');
    plan = addAction(plan, { op: 'install-self', to: targetPath } satisfies InstallAction);

    const config = await loadConfig(homeDir);
    const targets = config.links['syncskill'] ?? (await computeDefaultLinkTargets(homeDir, config)).targets;
    const agents = expandMaterializedTargetAgents(config, targets);

    if (agents.length > 0) {
      plan = addAction(plan, { op: 'link-skill', skill: 'syncskill', agents } satisfies InstallAction);
    }

    return plan;
  }

  if (!urlOrPath) {
    throw new Error('E_USAGE: install requires a URL/path or use "self"');
  }

  return buildExternalInstallPlan(homeDir, urlOrPath, options);
}

async function executeInstallPlan(
  homeDir: string,
  plan: Plan,
  resolutions: Resolutions,
  deprecations: string[] = [],
  runtimeOptions: InstallExecutionRuntimeOptions = {}
): Promise<void> {
  const output = getGlobalOutput();
  const installAction = plan.actions.find((action) => action.op === 'install-self');
  const linkAction = plan.actions.find((action) => action.op === 'link-skill' && action.skill === 'syncskill');

  if (installAction && installAction.op === 'install-self') {
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
    return;
  }

  const result = await executeExternalInstallPlan(homeDir, plan, resolutions, runtimeOptions);
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);

  if (result.installedSkills.length === 0) {
    if (result.alreadyInstalledSkills.length > 0) {
      output.info(`Already installed: ${result.alreadyInstalledSkills.join(', ')}`);
    } else {
      output.info('No skills installed.');
    }
  } else {
    output.info(`Installed ${result.installedSkills.length} skill(s)`);
    for (const skill of result.installedSkills) {
      output.change('add', 'skill', skill, { target: join(skillsDir, skill) });
    }
  }

  for (const conflict of result.skippedConflicts) {
    if (conflict.reason === 'owned-by-other-source') {
      output.warning(
        'E_SKILL_OWNED',
        `Skipped ${conflict.skill} (already owned by source '${conflict.owner}')`,
        { hint: `Run \`syncskill remove ${conflict.owner}\` then reinstall to take it over.` }
      );
    } else {
      output.warning(
        'E_SKILL_PATH_OCCUPIED',
        `Skipped ${conflict.skill} (a directory already exists at ${join(skillsDir, conflict.skill)}, not tracked by any source)`,
        { path: join(skillsDir, conflict.skill), hint: `Remove or rename that directory, then reinstall to take it over.` }
      );
    }
  }

  if (result.linkedAgents.length > 0) {
    output.info(`Linked to: ${result.linkedAgents.join(', ')}`);
  }

  output.result(true, {
    source: result.source,
    installedSkills: result.installedSkills,
    linkedAgents: result.linkedAgents,
    ...(deprecations.length > 0 ? { deprecations } : {}),
    data: {
      source: result.source,
      skills: {
        installed: result.installedSkills.map((skill) => ({
          name: skill,
          path: join(skillsDir, skill),
          ...(result.installActionId ? { plan_ref: result.installActionId } : {})
        })),
        ignored: result.ignoredSkills.map((skill) => ({
          name: skill,
          reason: 'user-deselected'
        })),
        already_installed: result.alreadyInstalledSkills,
        skipped_conflicts: result.skippedConflicts.map((conflict) => ({
          name: conflict.skill,
          reason: conflict.reason,
          ...(conflict.owner !== undefined ? { owner: conflict.owner } : {})
        }))
      },
      links_created: result.linkStatuses.map((status) => ({
        skill: status.skill,
        agent: status.agent,
        path: join(resolveMaterializedAgentPath(config, status.agent, homeDir), status.skill),
        ...(result.linkActionId ? { plan_ref: result.linkActionId } : {})
      }))
    }
  });
}

async function resolveRestoreTargetPath(homeDir: string, skill: string): Promise<string> {
  const registry = await buildSkillsRegistry(homeDir);
  const registryPath = registry.skills[skill]?.path;

  if (typeof registryPath === 'string' && registryPath.length > 0) {
    return registryPath;
  }

  return join(getSyncPaths(homeDir).skillsDir, skill);
}

async function markRestoreConflicts(
  homeDir: string,
  skill: string,
  servers: string[],
  updatedAt: string,
  dryRun: boolean
): Promise<{
  affected_servers: Array<{ server: string; status_set: 'conflict'; direction_set: 'conflict' }>;
  skipped_servers: Array<{ server: string; reason: string }>;
}> {
  const affected_servers: Array<{ server: string; status_set: 'conflict'; direction_set: 'conflict' }> = [];
  const skipped_servers: Array<{ server: string; reason: string }> = [];

  for (const server of servers) {
    const manifest = await loadServerManifest(homeDir, server);

    if (!(skill in manifest.skills)) {
      skipped_servers.push({ server, reason: 'skill not in manifest' });
      continue;
    }

    affected_servers.push({ server, status_set: 'conflict', direction_set: 'conflict' });

    if (dryRun) {
      continue;
    }

    await saveServerManifest(homeDir, {
      ...manifest,
      updated_at: updatedAt,
      skills: {
        ...manifest.skills,
        [skill]: {
          ...manifest.skills[skill],
          direction: 'conflict',
          status: 'conflict',
          forced_conflict: true
        }
      }
    });
  }

  return { affected_servers, skipped_servers };
}

/**
 * Build CLI introspection data for --help --json.
 * See spec §11.10 for schema.
 */
type CommandAudience = 'human' | 'agent' | 'both';

type JsonSchema = Record<string, unknown>;

interface CommandMetadata {
  audience: CommandAudience;
  prefer: string | null;
}

interface CommandSchemas {
  plan_schema: JsonSchema | null;
  result_schema: JsonSchema;
  resolutions_schema: JsonSchema | null;
}

interface IntrospectionArg {
  name: string;
  required: boolean;
}

interface IntrospectionFlag {
  name: string;
  type: 'boolean' | 'string';
  description: string;
}

interface CommandIntrospectionEntry {
  name: string;
  aliases: string[];
  description: string;
  args: IntrospectionArg[];
  flags: IntrospectionFlag[];
  audience: CommandAudience;
  prefer: string | null;
  plan_schema: JsonSchema | null;
  result_schema: JsonSchema;
  resolutions_schema: JsonSchema | null;
}

const GENERIC_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

const INSTALL_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['version', 'command', 'generated_at', 'actions', 'unresolved', 'warnings'],
  properties: {
    version: { type: 'number' },
    command: { const: 'install' },
    generated_at: { type: 'string' },
    actions: { type: 'array' },
    unresolved: { type: 'array' },
    warnings: { type: 'array' },
  },
};

const INSTALL_RESOLUTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

function getCommandMetadata(commandPath: string): CommandMetadata {
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

function getCommandSchemas(commandPath: string): CommandSchemas {
  if (commandPath === 'install') {
    return {
      plan_schema: INSTALL_PLAN_SCHEMA,
      result_schema: GENERIC_RESULT_SCHEMA,
      resolutions_schema: INSTALL_RESOLUTIONS_SCHEMA,
    };
  }

  return {
    plan_schema: null,
    result_schema: GENERIC_RESULT_SCHEMA,
    resolutions_schema: null,
  };
}

function isVisibleOption(option: Option): boolean {
  return (option as Option & { hidden?: boolean }).hidden !== true;
}

function normalizeCliName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function getOptionType(option: Option): 'boolean' | 'string' {
  return option.flags.includes('<') || option.flags.includes('[') ? 'string' : 'boolean';
}

function buildFlagIntrospection(option: Option): IntrospectionFlag {
  return {
    name: option.long ?? option.flags,
    type: getOptionType(option),
    description: option.description,
  };
}

function buildCommandIntrospection(command: Command): CommandIntrospectionEntry {
  const commandPath = getCommandPath(command);
  const metadata = getCommandMetadata(commandPath);
  const schemas = getCommandSchemas(commandPath);

  return {
    name: commandPath,
    aliases: command.aliases(),
    description: command.description(),
    args: command.registeredArguments.map(arg => ({
      name: normalizeCliName(arg.name()),
      required: arg.required,
    })),
    flags: command.options.filter(isVisibleOption).map(buildFlagIntrospection),
    audience: metadata.audience,
    prefer: metadata.prefer,
    plan_schema: schemas.plan_schema,
    result_schema: schemas.result_schema,
    resolutions_schema: schemas.resolutions_schema,
  };
}

function flattenCommandIntrospection(command: Command): CommandIntrospectionEntry[] {
  return [
    buildCommandIntrospection(command),
    ...command.commands.flatMap(child => flattenCommandIntrospection(child)),
  ];
}

function buildCliIntrospection(program: Command): object {
  return {
    version: program.version() ?? '0.1.0',
    commands: program.commands.flatMap(cmd => flattenCommandIntrospection(cmd)),
    global_flags: program.options.filter(isVisibleOption).map(buildFlagIntrospection),
  };
}

function buildHelpIntrospection(command: Command): object {
  return command.parent ? buildCommandIntrospection(command) : buildCliIntrospection(command);
}

export function createProgram(homeDir?: string): Command {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool. No args: show local dashboard summary')
    .option('--json', 'Output in JSONL format for machine consumption')
    .option('--no-interactive', 'Disable interactive prompts')
    .option('--yes-destructive', 'Allow destructive actions in non-interactive mode')
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
          const introspection = buildHelpIntrospection(cmd);
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

      if (shouldSkipCommandPreflight(actionCommand) || shouldSkipInstallPreflight(actionCommand)) {
        return;
      }

      await runCommandPreflight(resolvedHomeDir);
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
    .command('install [url-or-path]')
    .alias('i')
    .description('Install skill(s). Use "self" for built-in skill; URL/path for external source')
    .option('--name <name>', 'Source name (for URL/path)')
    .option('--path <path>', 'Repo-relative subdirectory within source containing skills')
    .option('--skill-subdir <dir>', 'Alias for --path')
    .option('--type <type>', 'Source type: git, http, or local')
    .option('--branch <branch>', 'Git branch')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (urlOrPath: string | undefined, options: {
      name?: string;
      path?: string;
      skillSubdir?: string;
      type?: 'git' | 'http' | 'local';
      branch?: string;
      yes?: boolean;
      _planMode?: boolean;
      _applyPath?: string;
      _resolutionsPath?: string;
    }) => {
      const output = getGlobalOutput();

      const rootOptions = program.opts<{
        json?: boolean;
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

      if (!urlOrPath) {
        const installCommand = program.commands.find(c => c.name() === 'install');
        if (rootOptions.noInteractive && !rootOptions.json) {
          installCommand?.outputHelp();
          return;
        }

        if (rootOptions.json) {
          output.result(true, {
            message: 'no target provided; use `install self` or `install <url>`',
            data: {
              hint: 'first-run users: run `syncskill init` for guided setup'
            }
          });
          return;
        }

        installCommand?.outputHelp();
        return;
      }

      const selfPathExists = urlOrPath === 'self' ? await pathExists(resolve('./self')) : false;
      const isSelfInstall = urlOrPath === 'self';

      if (isSelfInstall && selfPathExists) {
        output.warning(
          'W_INSTALL_SELF_AMBIGUOUS',
          'A directory named "./self" exists in the current working directory. "install self" installs the built-in syncskill skill (not your local directory).',
          { hint: 'To install ./self, run `syncskill install ./self` instead.' }
        );
      }
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

      const interactiveSelectSkills = (!applyPath && !rootOptions.json && !isNoInteractive(program))
        ? async (skills: Array<{ name: string; relativePath: string }>, existingSkills: Set<string>) => {
            const available = skills.filter((skill) => !existingSkills.has(skill.name));

            if (available.length === 0) {
              output.info('All skills from this source already exist.');
              return [];
            }

            if (options.yes) {
              return available.map((skill) => skill.name);
            }

            console.log(`\nFound ${skills.length} skill(s):\n`);

            const selected = await checkbox({
              message: 'Select skills to install:',
              choices: available.map((skill) => ({
                name: `${skill.name} (${skill.relativePath})`,
                value: skill.name,
                checked: true
              }))
            });

            return selected;
          }
        : undefined;

      const guardInstallPlanExecution = async (plan: Plan): Promise<Resolutions> => {
        if (plan.unresolved.length === 0 || options.yes) {
          return {};
        }

        if (applyPath) {
          throw new Error('E_UNRESOLVED: install plan contains execute-phase skill-selection; provide --resolutions when using --apply');
        }

        if (rootOptions.json || isNoInteractive(program)) {
          throw new Error('E_NEEDS_INPUT: This command requires interactive input');
        }

        return {};
      };

      try {
        const result = await withPlanExecute({
          buildPlan: () => buildInstallPlan(resolvedHomeDir, urlOrPath, options),
          executePlan: (plan, resolutions) => executeInstallPlan(resolvedHomeDir, plan, resolutions, deprecations, {
            yes: options.yes,
            applyMode: Boolean(applyPath),
            selectSkills: interactiveSelectSkills
          }),
          collectResolutions: guardInstallPlanExecution,
          options: planOptions
        });

        if (result.planOnly && result.plan) {
          console.log(serializePlan(result.plan));
        }
      } catch (error) {
        return handleInstallCommandError(error);
      }

      return;
    });

  const configCommand = program.command('config').description('Manage syncskill config');

  configCommand.action(async () => {
    if (isNoInteractive(program)) {
      return failForNoInteractive();
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
        return failForNoInteractive();
      }

      console.log('Note: "config link" is deprecated. Use "syncskill link" instead.');
      await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
    });

  configCommand
    .command('remote')
    .description('Edit skill → remote sync mapping (matrix editor)')
    .action(async () => {
      if (isNoInteractive(program)) {
        return failForNoInteractive();
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
            return failForNoInteractive();
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

      // Generate skills-registry.json (skip in dry-run mode)
      if (!isDryRun) {
        const registry = await rebuildRegistryV2(resolvedHomeDir, config);
        await saveSkillsRegistryV2(resolvedHomeDir, registry);
      }
    });

  async function ensureLinkCommandReady(): Promise<SyncSkillConfig> {
    return loadConfig(resolvedHomeDir);
  }

  function validateTargetAgents(config: SyncSkillConfig, targets: string[]): void {
    for (const agent of targets) {
      if (agent === '*' || agent === 'agents') {
        continue;
      }

      if (!config.agents[agent]) {
        return failForAgentNotConfigured(agent);
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
        return failForNoInteractive();
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
    .description('Show realized link status matrix')
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
        return failForNeedsInput(
          '`link edit` requires an interactive terminal',
          'Use `syncskill link set <skill> <agent>...`, `syncskill link add <skill> <agent>...`, or `syncskill link clear <skill>` instead.'
        );
      }

      if (isNoInteractive(program)) {
        return failForNoInteractive();
      }

      if (!skill) {
        await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
        return;
      }

      const currentTargets = config.links[skill] ?? [];
      const allAgents = await listSelectableAgentNames(resolvedHomeDir, config, currentTargets);
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
    .command('add <skill> <agents...>')
    .description('Add agents to skill targets')
    .option('--dry-run', 'Preview changes without applying')
    .option('-y, --yes', 'Auto-confirm stale link removal')
    .action(async (skill: string, agents: string[], options: { dryRun?: boolean; yes?: boolean }) => {
      const config = await ensureLinkCommandReady();
      validateTargetAgents(config, agents);

      const currentTargets = config.links[skill] ?? [];
      const nextTargets = currentTargets.includes('*')
        ? currentTargets
        : [...new Set([...currentTargets, ...agents])].sort();

      if (options.dryRun) {
        console.log(`[dry-run] Would link ${skill} to ${agents.join(', ')}`);
        const staleBySkill = await findStaleLinks(resolvedHomeDir, [skill]);
        await displayStaleLinksPreview(staleBySkill);
        return;
      }

      config.links[skill] = nextTargets;
      await saveConfig(config, resolvedHomeDir);
      await applySkillLinks(skill, options);
    });

  linkCommand
    .command('remove <skill> <agents...>')
    .description('Remove agents from skill targets')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, agents: string[], options: { dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      validateTargetAgents(config, agents);

      const currentTargets = expandMaterializedTargetAgents(config, config.links[skill] ?? []);
      const nextTargets = currentTargets.filter((target) => !agents.includes(target));

      if (options.dryRun) {
        console.log(`[dry-run] Would remove ${agents.join(', ')} from ${skill}`);
        return;
      }

      config.links[skill] = nextTargets;
      await saveConfig(config, resolvedHomeDir);
      for (const agent of agents) {
        await unlinkSkillFromAgent(resolvedHomeDir, skill, agent);
      }
      console.log(`✓ Removed ${agents.join(', ')} from ${skill}`);
    });

  linkCommand
    .command('clear <skill>')
    .description('Remove all links for a skill')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, options: { yes?: boolean; dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      await executeRemoveAllSkillLinks(resolvedHomeDir, program, skill, config, options, {
        verb: 'link clear',
        getDryRunLines: (name, agents) => [`[dry-run] Would unlink ${name} from all agents (${agents.join(', ')})`]
      });
    });

  program
    .command('unlink <skill>')
    .description('Remove all skill links (alias for "link clear")')
    .option('-y, --yes', 'Skip confirmation')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (skill: string, options: { yes?: boolean; dryRun?: boolean }) => {
      const config = await ensureLinkCommandReady();
      await executeRemoveAllSkillLinks(resolvedHomeDir, program, skill, config, options, {
        verb: 'unlink',
        showNoLinksMessage: true,
        getDryRunLines: (name, agents) => [
          `[dry-run] Would unlink ${name} from all agents (${agents.join(', ')})`,
          `[dry-run] Would remove "${name}" from config links.`
        ]
      });
    });

  linkCommand
    .command('build')
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
      const allResults = await linkConfiguredSkills(resolvedHomeDir, { all: true });
      const results = allResults.filter((result) => result.state !== 'failed');
      const failed = allResults.filter((result) => result.state === 'failed');
      const skillCount = new Set(results.map(r => r.skill)).size;
      output.info(`Linked ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);

      for (const failure of failed) {
        output.warning(
          'W_LINK_SKIPPED',
          `Skipped "${failure.skill}" for agent "${failure.agent}": ${failure.error ?? 'unknown error'}`,
          {
            path: `links.${failure.skill}`,
            hint: describeLinkFailureHint(failure.error)
          }
        );
      }

      // A partially applied run is not a success: without a non-zero exit the
      // skipped links are invisible to scripts and easy to miss interactively.
      if (failed.length > 0) {
        process.exitCode = ExitCode.GENERAL_ERROR;
      }

      const cleanupSummary = await handleStaleLinksReconciliation(resolvedHomeDir, undefined, options);
      output.result(failed.length === 0, {
        ...summarizeLinkBuild(resolvedHomeDir, config, results, cleanupSummary.removed, plan),
        ...(failed.length > 0
          ? {
            skipped: failed.map((failure) => ({
              skill: failure.skill,
              agent: failure.agent,
              reason: failure.error ?? 'unknown error'
            }))
          }
          : {})
      });
    });

  /**
   * Turn a link failure into an actionable next step.
   *
   * "Source directory not found" has two very different causes, and the old
   * blanket `doctor --fix` hint only covered one of them: doctor resolves
   * skills through live source discovery, so it stays silent for a skill whose
   * source simply has not been refreshed — following that hint led nowhere.
   */
  function describeLinkFailureHint(error?: string): string {
    if (error?.includes('Refusing to replace existing non-symlink target')) {
      return 'Move or remove the conflicting directory, then run `syncskill link build` again.';
    }

    if (error?.includes('Skill source directory not found') || error?.includes('Skill source path is not a directory')) {
      return 'Run `syncskill update <source>` to re-register skills from their source, or `syncskill doctor --fix` to drop the entry if the skill is gone.';
    }

    return 'Run `syncskill doctor` to inspect the config, then run `syncskill link build` again.';
  }

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
  /**
   * `--no-interactive` is an explicit flag, but a missing TTY blocks a prompt
   * just as hard. Without this check the stale-link confirm crashed with
   * ExitPromptError when stdout was a pipe, and hung forever when stdout was
   * redirected to a file — in both cases still exiting 0.
   *
   * Interactivity is keyed on stdout to match `link` and `link edit`. A
   * terminal session that closes only stdin (`link build < /dev/null`) is not
   * covered.
   */
  function cannotPromptInteractively(): boolean {
    return isNoInteractive(program) || !process.stdout.isTTY;
  }

  const STALE_LINK_INPUT_HINT =
    'Re-run with `-y` to remove the stale links, or run `syncskill link build` from a terminal.';

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
        if (cannotPromptInteractively()) {
          return failForNoInteractive(STALE_LINK_INPUT_HINT);
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
      if (cannotPromptInteractively()) {
        return failForNoInteractive(STALE_LINK_INPUT_HINT);
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

  const sourceCommand = program.command('source').description('Manage external skill sources');

  sourceCommand
    .command('list')
    .alias('ls')
    .description('List configured sources')
    .action(async () => {
      for (const line of formatSourceListLines(await listSourcesWithDetails(resolvedHomeDir))) {
        console.log(line);
      }
    });


  // Top-level source refresh command
  program
    .command('update [name]')
    .description('Update configured source(s)')
    .option('--all', 'Update all configured sources')
    .option('-y, --yes', 'Skip confirmation prompts, auto-skip dirty sources')
    .option('--force', 'Force update dirty sources (backs up first)')
    .option('--dry-run', 'Preview update without making changes')
    .action(async (name: string | undefined, options: { all?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean }) => {
      const strict = isStrictMode();

      if (options.all || name === undefined) {
        const updatedAt = new Date().toISOString();
        const outcome = await updateAllSources(resolvedHomeDir, updatedAt, {
          yes: options.yes,
          force: options.force,
          dryRun: options.dryRun
        });

        if (!outcome.results.some((result) => result.status === 'failed') && shouldExitDirtySkip(outcome.results, {
          strict,
          dryRun: options.dryRun,
          countSkips: (result) => result.status === 'skipped' ? 1 : 0,
          hasSuccessfulTarget: (result) => result.status === 'success'
        })) {
          process.exit(ExitCode.DIRTY_SKIP);
        }
        return;
      }

      const updatedAt = new Date().toISOString();
      const result = await updateSource(resolvedHomeDir, name, {
        yes: options.yes,
        force: options.force,
        dryRun: options.dryRun
      }, updatedAt);

      if (!options.dryRun && result.updated_at !== updatedAt) {
        process.exit(ExitCode.DIRTY_SKIP);
      }
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

  const remoteCommand = program.command('remote').description('Manage and inspect remotes');

  remoteCommand.action(async () => {
    if (isNoInteractive(program)) {
      return failForNoInteractive();
    }

    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'remote' });
  });

  remoteCommand
    .command('add <name>')
    .description('Add a configured remote endpoint')
    .requiredOption('--host <host>', 'SSH host')
    .option('--user <user>', 'SSH user')
    .option('--port <port>', 'SSH port', parseInteger)
    .option('--identity-file <path>', 'SSH identity file')
    .option('--remote-repo <path>', 'Remote syncskill repository path')
    .action(async (name: string, options: { host: string; user?: string; port?: number; identityFile?: string; remoteRepo?: string }) => {
      const config = await loadConfig(resolvedHomeDir);
      const existing = config.servers[name];
      const existingRecord = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : null;
      const existingRemoteAgents = existingRecord?.remote_agents;
      const remoteAgents = typeof existingRemoteAgents === 'object' && existingRemoteAgents !== null && !Array.isArray(existingRemoteAgents)
        ? Object.fromEntries(Object.entries(existingRemoteAgents).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {};

      config.servers[name] = {
        host: options.host,
        ...(typeof options.user === 'string' ? { user: options.user } : {}),
        ...(typeof options.port === 'number' ? { port: options.port } : {}),
        ...(typeof options.identityFile === 'string' ? { identity_file: options.identityFile } : {}),
        ...(typeof options.remoteRepo === 'string' ? { remote_repo: options.remoteRepo } : {}),
        remote_agents: remoteAgents
      };
      await saveConfig(config, resolvedHomeDir);
      console.log(name);
    });

  remoteCommand
    .command('rm <name>')
    .description('Remove a configured remote endpoint')
    .action(async (name: string) => {
      const config = await loadConfig(resolvedHomeDir);
      if (!(name in config.servers)) {
        return failWithOutputError('E_REMOTE_NOT_FOUND', `Remote not found: ${name}`, 'Use `syncskill remote list` to inspect configured remotes');
      }

      delete config.servers[name];
      await saveConfig(config, resolvedHomeDir);
      console.log(name);
    });

  remoteCommand
    .command('list')
    .alias('ls')
    .description('List configured remotes')
    .action(async () => {
      for (const line of formatServerListLines(await listServers(resolvedHomeDir))) {
        console.log(line);
      }
    });

  remoteCommand
    .command('show <name>')
    .description('Show local receiver backup for one remote')
    .action(async (name: string) => {
      const backup = await showServer(resolvedHomeDir, name);

      if (program.opts<{ json?: boolean }>().json) {
        getGlobalOutput().result(true, {
          data: JSON.parse(JSON.stringify(backup)) as Record<string, unknown>
        });
        return;
      }

      for (const line of formatServerShowLines(backup)) {
        console.log(line);
      }
    });

  const remoteAgentCommand = remoteCommand.command('agent').description('Manage local remote-agent backup entries');

  remoteAgentCommand
    .command('ls <server>')
    .description('List remote agents from local receiver backup')
    .action(async (serverName: string) => {
      const backup = await loadReceiverBackup(resolvedHomeDir, serverName);

      if (program.opts<{ json?: boolean }>().json) {
        getGlobalOutput().result(true, {
          data: JSON.parse(JSON.stringify(backup.remote_agents)) as Record<string, unknown>
        });
        return;
      }

      for (const line of formatRemoteAgentLines(backup)) {
        console.log(line);
      }
    });

  remoteAgentCommand
    .command('add <server> <name> <path>')
    .description('Add one remote agent path to local receiver backup')
    .action(async (serverName: string, agentName: string, remotePath: string) => {
      let before: Record<string, unknown> | null = null;
      const backup = await mutateReceiverBackup(
        resolvedHomeDir,
        serverName,
        (currentBackup) => {
          before = snapshotReceiverBackupState(currentBackup, 'remote_agents') as Record<string, unknown>;
          currentBackup.remote_agents[agentName] = remotePath;
        }
      );

      if (backup === null || before === null) {
        return;
      }

      emitReceiverBackupMutationResult(program, backup, {
        server: serverName,
        op: 'agent.add',
        before,
        after: { remote_agents: backup.remote_agents }
      }, formatRemoteAgentLines);
    });

  remoteAgentCommand
    .command('rm <server> <name>')
    .description('Remove one remote agent from local receiver backup')
    .action(async (serverName: string, agentName: string) => {
      const { backup, before, changed } = await removeReceiverAgentLinks(resolvedHomeDir, serverName, agentName);

      if (backup === null) {
        emitReceiverBackupNoOpResult(program, serverName, 'agent.rm');
        return;
      }

      if (before === null || !changed) {
        return;
      }

      emitReceiverBackupMutationResult(program, backup, {
        server: serverName,
        op: 'agent.rm',
        before,
        after: { remote_agents: backup.remote_agents }
      }, formatRemoteAgentLines);
    });

  const remoteLinkCommand = remoteCommand.command('link').description('Manage local remote-link backup entries');

  remoteLinkCommand
    .command('ls <server>')
    .description('List remote skill links from local receiver backup')
    .action(async (serverName: string) => {
      const backup = await loadReceiverBackup(resolvedHomeDir, serverName);

      if (program.opts<{ json?: boolean }>().json) {
        getGlobalOutput().result(true, {
          data: JSON.parse(JSON.stringify(backup.links)) as Record<string, unknown>
        });
        return;
      }

      for (const line of formatRemoteLinkLines(backup)) {
        console.log(line);
      }
    });

  remoteLinkCommand
    .command('add <server> <skill> <agent>')
    .description('Add one remote skill link to local receiver backup')
    .action(async (serverName: string, skill: string, agentName: string) => {
      let before: Record<string, unknown> | null = null;
      let blocked = false;
      const backup = await mutateReceiverBackup(
        resolvedHomeDir,
        serverName,
        (currentBackup) => {
          if (!(agentName in currentBackup.remote_agents)) {
            blocked = true;
            failWithOutputError('E_AGENT_NOT_CONFIGURED', `Remote agent not configured: ${agentName}`);
            return false;
          }

          before = snapshotReceiverBackupState(currentBackup, 'links') as Record<string, unknown>;
          const currentTargets = currentBackup.links[skill] ?? [];
          currentBackup.links[skill] = currentTargets.includes('*') ? ['*'] : [...new Set([...currentTargets, agentName])].sort();
        }
      );

      if (backup === null || before === null || blocked) {
        return;
      }

      emitReceiverBackupMutationResult(program, backup, {
        server: serverName,
        op: 'link.add',
        before,
        after: { links: backup.links }
      }, formatRemoteLinkLines);
    });

  remoteLinkCommand
    .command('rm <server> <skill> [agent]')
    .description('Remove one remote skill link from local receiver backup')
    .action(async (serverName: string, skill: string, agentName: string | undefined) => {
      const { backup, before, changed } = await removeReceiverSkillLink(resolvedHomeDir, serverName, skill, agentName);

      if (backup === null) {
        emitReceiverBackupNoOpResult(program, serverName, 'link.rm');
        return;
      }

      if (before === null || !changed) {
        return;
      }

      emitReceiverBackupMutationResult(program, backup, {
        server: serverName,
        op: 'link.rm',
        before,
        after: { links: backup.links }
      }, formatRemoteLinkLines);
    });

  remoteCommand
    .command('takeover <server> <skill>')
    .description('Replace remote directories with syncskill-managed symlinks')
    .option('--agent <agent>', 'Take over only one remote agent path')
    .option('--dry-run', 'Preview takeover without making changes')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (serverName: string, skill: string, options: { agent?: string; dryRun?: boolean; yes?: boolean }) => {
      const rootOptions = program.opts<{ json?: boolean }>();
      const destructiveBlocked = (options.yes === true || isNoInteractive(program) === true || rootOptions.json === true)
        && !isYesDestructiveEnabled(program);
      if (destructiveBlocked) {
        ensureDestructiveVerbAllowed(program, 'remote takeover', options);
        return;
      }

      try {
        const backup = await loadReceiverBackupIfExists(resolvedHomeDir, serverName);
        if (backup === null) {
          return failWithOutputError('E_REMOTE_NOT_INITIALIZED', `Remote not initialized: ${serverName}`, `Run \`syncskill refresh ${serverName}\` first`);
        }

        const linkedAgents = expandReceiverLinkAgents(backup, skill);
        if (linkedAgents.length === 0) {
          return failWithOutputError('E_USAGE', `Remote skill has no linked agents in backup: ${skill}`, `Run \`syncskill remote link add ${serverName} ${skill} <agent>\` first`);
        }

        if (options.agent && !linkedAgents.includes(options.agent)) {
          return failWithOutputError('E_AGENT_NOT_CONFIGURED', `Remote agent not configured for ${skill}: ${options.agent}`);
        }

        const config = await loadConfig(resolvedHomeDir);
        const configuredServer = getConfiguredServer(config, serverName);
        const selectedAgents = options.agent ? [options.agent] : linkedAgents;
        const selectedRemoteAgents = Object.fromEntries(
          selectedAgents.map((agent) => [agent, backup.remote_agents[agent]]).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        );

        if (Object.keys(selectedRemoteAgents).length !== selectedAgents.length) {
          const missingAgent = selectedAgents.find((agent) => !(agent in selectedRemoteAgents)) ?? options.agent ?? skill;
          return failWithOutputError('E_AGENT_NOT_CONFIGURED', `Remote agent not configured: ${missingAgent}`);
        }

        const result = await takeOverRemoteSkill(
          {
            ...configuredServer,
            remote_agents: selectedRemoteAgents
          },
          skill,
          {
            agent: options.agent,
            dryRun: options.dryRun,
          }
        );

        if (program.opts<{ json?: boolean }>().json) {
          getGlobalOutput().result(true, {
            data: JSON.parse(JSON.stringify(result)) as Record<string, unknown>
          });
          return;
        }

        for (const entry of result.takeovers) {
          console.log(`${options.dryRun ? 'would-takeover' : 'takeover'}\t${entry.agent}\t${entry.path}\t${entry.remote_type}`);
        }

        for (const entry of result.skipped) {
          console.log(`skip\t${entry.agent}\t${entry.path}\t${entry.reason}`);
        }

        if (result.takeovers.length === 0 && result.skipped.length === 0) {
          console.log('No remote takeover actions needed.');
        }
      } catch (error) {
        const parsed = parseStructuredError(error);
        if (parsed?.code === 'E_USAGE' || parsed?.code === 'E_AGENT_NOT_CONFIGURED' || parsed?.code === 'E_TAKEOVER_FAILED') {
          return failWithOutputError(parsed.code, parsed.message);
        }
        handleSyncCommandError(error);
      }
    });


  program
    .command('refresh [server]')
    .description('Refresh manifest state (no flags: local + remote, then show status)')
    .option('--all', 'Refresh both local and remote')
    .option('--local', 'Refresh local manifest state')
    .option('--remote', 'Refresh remote manifest state')
    .action(async (server: string | undefined, options: { all?: boolean; local?: boolean; remote?: boolean }) => {
      const showStatus = !options.all && !options.local && !options.remote;
      const manifests = await refreshStoredManifests(resolvedHomeDir, {
        all: showStatus || Boolean(options.all),
        local: Boolean(options.local),
        remote: Boolean(options.remote),
        server
      });

      if (showStatus) {
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

      if (program.opts<{ json?: boolean }>().json) {
        getGlobalOutput().result(true, {
          data: buildStatusJson(manifests)
        });
        return;
      }

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
            return failForNoInteractive();
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
            return failForNoInteractive();
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
    .command('restore <skill>')
    .description('Restore a skill from its latest pre-pull backup and mark manifests as conflict')
    .option('--server <server>', 'Only mark one tracked manifest as conflict')
    .option('--all-servers', 'Mark all tracked manifests as conflict (default)')
    .option('--dry-run', 'Preview restore without modifying files or manifests')
    .action(async (skill: string, options: { server?: string; allServers?: boolean; dryRun?: boolean }) => {
      setCommandName('restore');
      const output = getGlobalOutput();

      if (options.server && options.allServers) {
        return failWithOutputError('E_USAGE', 'Cannot specify both --server and --all-servers');
      }

      const backupPath = getPullBackupDir(resolvedHomeDir, skill);
      if (!(await pathExists(backupPath))) {
        return failWithOutputError(
          'E_BACKUP_NOT_FOUND',
          `No backup found for ${skill}`,
          'Backups are created when config.pull_backup is true (default) and SYNCSKILL_PULL_BACKUP is not 0.'
        );
      }

      const targetPath = await resolveRestoreTargetPath(resolvedHomeDir, skill);
      const preRestoreBackupPath = getRestorePreBackupDir(resolvedHomeDir, skill);
      const scopedServers = options.server ? [options.server] : await listTrackedServers(resolvedHomeDir);
      const updatedAt = new Date().toISOString();

      try {
        const manifestSummary = await markRestoreConflicts(
          resolvedHomeDir,
          skill,
          scopedServers,
          updatedAt,
          Boolean(options.dryRun)
        );

        if (options.dryRun) {
          const conflictTargets = scopedServers.length > 0 ? scopedServers.join(', ') : '(none)';
          output.info(`[dry-run] Would restore ${skill} from ${backupPath}; would mark conflict in: ${conflictTargets}`);
          output.result(true, {
            skill,
            restored_from: backupPath,
            restored_to: targetPath,
            pre_restore_backup: preRestoreBackupPath,
            ...manifestSummary
          });
          return;
        }

        await restoreSkillFromPullBackup({
          homeDir: resolvedHomeDir,
          skillName: skill,
          targetPath
        });

        output.info(`Restored ${skill} from ${backupPath}`);
        output.info(`Pre-restore backup saved at ${preRestoreBackupPath}`);
        if (manifestSummary.affected_servers.length > 0) {
          output.info(`Marked conflict in manifests: ${manifestSummary.affected_servers.map(({ server }) => server).join(', ')}`);
        }
        if (manifestSummary.skipped_servers.length > 0) {
          output.info(`Skipped manifests without skill entry: ${manifestSummary.skipped_servers.map(({ server }) => server).join(', ')}`);
        }
        output.info(`Run \`syncskill resolve ${skill}\` to choose final direction.`);
        output.result(true, {
          skill,
          restored_from: backupPath,
          restored_to: targetPath,
          pre_restore_backup: preRestoreBackupPath,
          ...manifestSummary
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failWithOutputError(
          'E_RESTORE_FAILED',
          `Failed to restore ${skill}: ${message}`,
          `Manual recovery: restore from ${preRestoreBackupPath} if it exists.`
        );
      }
    });

  program
    .command('push [server]')
    .description('Push local skill changes to one server or all configured servers')
    .option('--all', 'Push to all configured servers')
    .option('--dry-run', 'Preview changes without pushing')
    .option('--timeout <seconds>', 'Per-server SSH timeout in seconds', parseInteger)
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; timeout?: number; yes?: boolean }) => {
      try {
        const noInteractive = isNoInteractive(program);
        const targetServers = await prepareSyncTargetServers(resolvedHomeDir, server, options, 'push', noInteractive);
        if (!targetServers) return;

        const json = program.opts<{ json?: boolean }>().json === true;
        const results = await pushToServers(resolvedHomeDir, targetServers, {
          dryRun: options.dryRun,
          noRefresh: !program.opts<{ refresh: boolean }>().refresh,
          timeout: options.timeout,
          yes: options.yes,
          noInteractive,
          yesDestructive: isYesDestructiveEnabled(program),
          json
        });

        if (!json) {
          for (const result of results) {
            for (const line of formatSkillRows('push', result)) {
              console.log(line);
            }
          }
        }

        getGlobalOutput().result(true, summarizePushResults(results));

        if (shouldExitDirtySkip(results, {
          strict: isStrictMode(),
          dryRun: options.dryRun,
          countSkips: countPushSkips,
          hasSuccessfulTarget: hasSuccessfulPushTarget
        })) {
          process.exit(ExitCode.DIRTY_SKIP);
        }
      } catch (error) {
        handleSyncCommandError(error);
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
    .option('--on-remote-deletion <policy>', 'How to handle remote deletions: keep-local, delete, prompt', parseOnDeletion)
    .addOption(new Option('--on-deletion <policy>').hideHelp().argParser(parseOnDeletion))
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
        onRemoteDeletion?: 'keep-local' | 'delete' | 'prompt';
        onDeletion?: 'keep-local' | 'delete' | 'prompt';
      }
    ) => {
      try {
        const noInteractive = isNoInteractive(program);
        const targetServers = await prepareSyncTargetServers(resolvedHomeDir, server, options, 'pull', noInteractive);
        if (!targetServers) return;

        const results = await pullFromServers(resolvedHomeDir, targetServers, {
          dryRun: options.dryRun,
          timeout: options.timeout,
          pullBackup: options.pullBackup,
          yes: options.yes,
          noInteractive,
          crossServerPolicy: options.crossServerPolicy,
          onConflict: options.onConflict,
          onDeletion: options.onRemoteDeletion ?? options.onDeletion
        });

        if (!program.opts<{ json?: boolean }>().json) {
          for (const result of results) {
            for (const line of formatSkillRows('pull', result)) {
              console.log(line);
            }
          }
        }

        getGlobalOutput().result(true, summarizePullResults(results));

        if (shouldExitDirtySkip(results, {
          strict: isStrictMode(),
          dryRun: options.dryRun,
          countSkips: countPullSkips,
          hasSuccessfulTarget: hasSuccessfulPullTarget
        })) {
          process.exit(ExitCode.DIRTY_SKIP);
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
    .option('--on-remote-deletion <policy>', 'How to handle remote deletions: keep-local, delete, prompt', parseOnDeletion)
    .addOption(new Option('--on-deletion <policy>').hideHelp().argParser(parseOnDeletion))
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
        onRemoteDeletion?: 'keep-local' | 'delete' | 'prompt';
        onDeletion?: 'keep-local' | 'delete' | 'prompt';
      }
    ) => {
      try {
        const noInteractive = isNoInteractive(program);
        const globalOptions = program.opts<{ refresh: boolean }>();
        const json = program.opts<{ json?: boolean }>().json === true;
        const targetServers = await prepareSyncTargetServers(resolvedHomeDir, server, options, 'sync', noInteractive);
        if (!targetServers) return;

        const results = await syncServers(resolvedHomeDir, targetServers, {
          dryRun: options.dryRun,
          noRefresh: !globalOptions.refresh,
          timeout: options.timeout,
          pullBackup: options.pullBackup,
          yes: options.yes,
          noInteractive,
          yesDestructive: isYesDestructiveEnabled(program),
          json,
          crossServerPolicy: options.crossServerPolicy,
          onConflict: options.onConflict,
          onDeletion: options.onRemoteDeletion ?? options.onDeletion
        });

        if (!json) {
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

        if (!program.opts<{ json?: boolean }>().json && allConflicts.length > 0) {
          console.log('\nConflicts skipped:');
          for (const c of allConflicts) {
            console.log(`  ${c.skill} (${c.server})`);
          }
          console.log('\nRun `syncskill resolve <skill>` to resolve conflicts.');
        }

        getGlobalOutput().result(true, summarizeSyncResults(results));

        if (shouldExitDirtySkip(results, {
          strict: isStrictMode(),
          dryRun: options.dryRun,
          countSkips: countSyncSkips,
          hasSuccessfulTarget: hasSuccessfulSyncTarget
        })) {
          process.exit(ExitCode.DIRTY_SKIP);
        }
      } catch (error) {
        handleSyncCommandError(error);
      }
    });

  program
    .command('doctor')
    .description('Diagnose and repair config issues; duplicate underlying agent directories are warned, not auto-fixed')
    .option('--fix', 'Interactively fix issues')
    .option('--dry-run', 'Preview fixes without applying')
    .option('-y, --yes', 'Auto-fix all auto-fixable issues without prompting')
    .action(async (options: { fix?: boolean; dryRun?: boolean; yes?: boolean }) => {
      const { skillsDir } = getSyncPaths(resolvedHomeDir);

      let config: SyncSkillConfig;
      try {
        config = await loadConfig(resolvedHomeDir);
      } catch (error) {
        console.error('Failed to load config:', error instanceof Error ? error.message : error);
        process.exit(1);
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

      const allItems = [...report.errors, ...report.warnings];
      const autoFixableItems = allItems.filter((item) =>
        isRegistryDiagnostic(item.code)
        || item.code === DiagnosticCode.SKILL_NOT_FOUND
        || item.code === DiagnosticCode.SKILL_NAME_INVALID
        || item.code === DiagnosticCode.AGENT_NOT_CONFIGURED
        || item.code === DiagnosticCode.AGENT_PATH_INVALID
        || item.code === DiagnosticCode.SOURCE_PATH_INVALID
      );
      const manualItems = allItems.filter((item) => !autoFixableItems.includes(item));

      console.log(`Found ${autoFixableItems.length} auto-fixable issue${autoFixableItems.length !== 1 ? 's' : ''}.\n`);

      if (autoFixableItems.length === 0) {
        if (manualItems.length > 0) {
          console.log('Remaining manual issues:');
          for (const item of manualItems) {
            console.log(`⚠ ${item.path}`);
            console.log(`  ${item.message}`);
          }
          console.log('');
        }

        if (options.dryRun) {
          console.log('[dry-run] No auto-fixable issues would be applied.');
        } else {
          console.log('No auto-fixable issues were applied.');
        }
        return;
      }

      if (manualItems.length > 0) {
        console.log('Manual issues requiring user attention:');
        for (const item of manualItems) {
          console.log(`⚠ ${item.path}`);
          console.log(`  ${item.message}`);
        }
        console.log('');
      }


      let configChanged = false;
      let registryChanged = false;

      for (const item of autoFixableItems) {
        const shouldFix = options.yes || (await (async () => {
          if (isNoInteractive(program)) {
            return failForNoInteractive();
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
                config,
                { errors: [], warnings: [item], isHealthy: false, canProceed: true },
                { rebuildRegistry: true }
              );
              registryChanged = true;
            }
          } else {
            // Handle config repairs
            const repairOpts: RepairOptions = {
              removeInvalidSkillLinks: item.code === 'SKILL_NOT_FOUND' || item.code === 'SKILL_NAME_INVALID',
              removeInvalidAgentLinks: item.code === 'AGENT_NOT_CONFIGURED',
              removeInvalidAgents: item.code === 'AGENT_PATH_INVALID',
              removeInvalidSources: item.code === 'SOURCE_PATH_INVALID'
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
        } else {
          console.log('\nNo auto-fixable issues were applied.');
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
