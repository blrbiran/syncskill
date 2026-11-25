import { access, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfiguredServer, getSyncPaths, loadConfig, type ConfiguredServer, type ConflictResolution } from '../config/config.js';
import type { SyncSkillConfig } from '../config/types.js';
import { buildSkillsRegistry } from '../source.js';
import { applyResolution, reconcileManifest } from './conflict.js';
import {
  createEmptyManifest,
  applyRemoteSnapshot,
  buildLocalSkillHashes,
  collectRemoteHistoryEntries,
  finalizePulledSkills,
  finalizePushedSkills,
  loadManifestHistory,
  loadServerManifest,
  saveManifestHistory,
  saveServerManifest,
  type ManifestHistoryEntry,
  type ManifestSkillState,
  type ServerManifest
} from './manifest.js';
import { confirm, select } from '@inquirer/prompts';
import {
  applyRemoteLinks,
  createTransportRuntime,
  deleteRemoteSkills,
  deployReceiver,
  fetchRemoteManifest,
  isTransportFailure,
  listRemoteSkills,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
  withTimeout,
  type ReceiverConfigPayload,
  type TransportRuntime
} from './transport.js';
import { buildReceiverConfigPayload, loadReceiverBackupIfExists, mergeConfiguredLinksIntoReceiverBackup, saveReceiverBackup } from './server.js';
import { backupSkillBeforePull } from '../utils/backup.js';

export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
  noRefresh?: boolean;
  yes?: boolean;
  noInteractive?: boolean;
  yesDestructive?: boolean;
  json?: boolean;
  timeout?: number;
  pullBackup?: boolean;
  onConflict?: 'keep-local' | 'keep-remote' | 'skip' | 'abort';
  onDeletion?: 'keep-local' | 'delete' | 'prompt';
  crossServerPolicy?: string;
  skipPullSkillsByServer?: Record<string, string[]>;
  preferLocalSkillsByServer?: Record<string, string[]>;
}

type ResolvedCrossServerPolicy = 'first-wins' | 'last-wins' | 'abort' | 'prompt' | { type: 'server'; server: string };

interface CrossServerConflict {
  skill: string;
  servers: string[];
}

function createSyncEngineError(code: 'E_CONFLICT' | 'E_SERVER_NOT_FOUND' | 'E_REMOTE_NOT_FOUND' | 'E_NEEDS_INPUT' | 'E_USAGE', message: string): Error {
  return new Error(`${code}: ${message}`);
}

/**
 * Issue 406: `--timeout <seconds>` bounds one server's remote phase. The subprocess is not killed
 * (withTimeout's documented semantics): the CLI reports and releases, and ssh/rsync finish or die on
 * their own.
 */
async function withServerTimeout<T>(
  serverName: string,
  options: SyncEngineOptions,
  work: () => Promise<T>
): Promise<T> {
  const seconds = options.timeout;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return work();
  }
  return withTimeout(work(), seconds * 1000, `sync with ${serverName}`);
}

async function collectLocalFileList(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string, prefix: string = ''): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

export interface PushResult {
  server: string;
  pushed_skills: string[];
  skipped_skills: string[];
  conflicted_skills: string[];
  manifest: ServerManifest;
  /**
   * Tester #449: the remote skills this push deleted (or, under --dry-run, WOULD delete). `pull` already reported its
   * counterpart; without this a `--json` consumer could not tell that a push removed anything.
   */
  deleted_skills?: string[];
  /** Tester #449: reasons a person should read before trusting the plan (`no-skills-configured`, ...). Tester #477: a
   * stable `code` and its prose `detail` are separate fields, so a script matches the code and a person reads the detail. */
  warnings?: PushWarning[];
}

export interface PushWarning {
  code: 'no-skills-configured' | 'included-not-local' | 'remote-state-unknown';
  detail: string;
}

/**
 * Tester #449: the three states of `servers.<name>.skills.include` — `unset` (fall back to the link matrix), `empty`
 * (the person configured "no skills" — NOT a licence to delete every remote skill), `list`.
 */
export type IncludeState = { kind: 'unset' } | { kind: 'empty' } | { kind: 'list'; skills: Set<string> };

export interface PullBackupRecord {
  skill: string;
  server: string;
  backup_path: string;
  size_bytes: number;
}

export interface PullResult {
  server: string;
  pulled_skills: string[];
  deleted_skills?: string[];
  skipped_skills: string[];
  conflicted_skills: string[];
  backups?: PullBackupRecord[];
  manifest: ServerManifest;
}

export interface SyncStepResult {
  server: string;
  direction: 'pull' | 'push';
  skills: string[];
  conflicted_skills: string[];
}

export interface SyncResult {
  server: string;
  pull: PullResult;
  push: PushResult;
}

function resolveSingleServerConflictPolicy(
  configuredPolicy: ConflictResolution,
  override?: SyncEngineOptions['onConflict']
): ConflictResolution {
  if (override === 'keep-local') {
    return 'keep-local';
  }

  if (override === 'keep-remote') {
    return 'keep-remote';
  }

  if (override === 'skip' || override === 'abort') {
    return 'manual';
  }

  return configuredPolicy;
}

function resolvePullBackupEnabled(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: SyncEngineOptions
): boolean {
  if (typeof options.pullBackup === 'boolean') {
    return options.pullBackup;
  }

  if (process.env.SYNCSKILL_PULL_BACKUP === '0') {
    return false;
  }

  if (process.env.SYNCSKILL_PULL_BACKUP === '1') {
    return true;
  }

  if (typeof config.pull_backup === 'boolean') {
    return config.pull_backup;
  }

  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getDirectorySize(path: string): Promise<number> {
  const entry = await stat(path);
  if (entry.isFile()) {
    return entry.size;
  }

  if (!entry.isDirectory()) {
    return 0;
  }

  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;

  for (const child of entries) {
    if (!child.isFile() && !child.isDirectory()) {
      continue;
    }

    total += await getDirectorySize(join(path, child.name));
  }

  return total;
}

async function backupPullTargets(
  homeDir: string,
  serverName: string,
  skills: string[],
  registry: Awaited<ReturnType<typeof buildSkillsRegistry>>
): Promise<PullBackupRecord[]> {
  const backups: PullBackupRecord[] = [];

  for (const skill of uniqueSorted(skills)) {
    const entry = registry.skills[skill];
    const targetPath = entry?.path ?? join(getSkillsDir(homeDir), skill);

    if (!(await pathExists(targetPath))) {
      continue;
    }

    const backupPath = await backupSkillBeforePull({
      homeDir,
      skillName: skill,
      skillPath: targetPath
    });

    backups.push({
      skill,
      server: serverName,
      backup_path: backupPath,
      size_bytes: await getDirectorySize(backupPath)
    });
  }

  return backups;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function mergeSkillMaps(
  left?: Record<string, string[]>,
  right?: Record<string, string[]>
): Record<string, string[]> | undefined {
  const merged = new Map<string, string[]>();

  for (const [server, skills] of Object.entries(left ?? {})) {
    merged.set(server, [...skills]);
  }

  for (const [server, skills] of Object.entries(right ?? {})) {
    merged.set(server, uniqueSorted([...(merged.get(server) ?? []), ...skills]));
  }

  return merged.size > 0 ? Object.fromEntries(merged) : undefined;
}

function resolvePreferredLocalSkills(
  manifest: ServerManifest,
  skills: string[],
  updatedAt: string
): ServerManifest {
  let current = reconcileManifest(manifest);

  for (const skill of uniqueSorted(skills)) {
    if (!current.skills[skill] || current.skills[skill]?.direction !== 'conflict') {
      continue;
    }

    current = applyResolution(current, skill, 'local', updatedAt);
  }

  return current;
}

function parseCrossServerPolicy(
  config: Awaited<ReturnType<typeof loadConfig>>,
  policy: string | undefined,
  yes: boolean | undefined
): ResolvedCrossServerPolicy {
  if (!policy || policy.length === 0) {
    return yes ? 'abort' : 'prompt';
  }

  if (policy === 'first-wins' || policy === 'last-wins' || policy === 'abort' || policy === 'prompt') {
    return policy;
  }

  if (!policy.startsWith('server:')) {
    throw createSyncEngineError('E_REMOTE_NOT_FOUND', `Remote not found: ${policy}. Use server:${policy}`);
  }

  const server = policy.slice('server:'.length);
  if (!server || !(server in config.servers)) {
    throw createSyncEngineError('E_REMOTE_NOT_FOUND', `Remote not found: ${server}`);
  }

  return { type: 'server', server };
}

function detectCrossServerConflicts(
  manifests: Array<{ server: string; manifest: ServerManifest }>,
  targetServers: string[]
): CrossServerConflict[] {
  const bySkill = new Map<string, Array<{ server: string; hash: string }>>();

  for (const { server, manifest } of manifests) {
    for (const [skill, state] of Object.entries(manifest.skills)) {
      if (typeof state.remote_hash !== 'string') {
        continue;
      }

      const entries = bySkill.get(skill) ?? [];
      entries.push({ server, hash: state.remote_hash });
      bySkill.set(skill, entries);
    }
  }

  return [...bySkill.entries()]
    .map(([skill, entries]) => {
      const distinctHashes = new Set(entries.map((entry) => entry.hash));
      if (entries.length < 2 || distinctHashes.size < 2) {
        return null;
      }

      return {
        skill,
        servers: targetServers.filter((server) => entries.some((entry) => entry.server === server))
      } satisfies CrossServerConflict;
    })
    .filter((value): value is CrossServerConflict => value !== null)
    .sort((left, right) => left.skill.localeCompare(right.skill));
}

async function chooseConflictWinner(
  conflict: CrossServerConflict,
  policy: ResolvedCrossServerPolicy,
  options: SyncEngineOptions
): Promise<string> {
  if (policy === 'abort') {
    throw createSyncEngineError(
      'E_CONFLICT',
      `Cross-server conflict for skill ${conflict.skill}: ${conflict.servers.join(', ')}`
    );
  }

  if (policy === 'first-wins') {
    return conflict.servers[0] as string;
  }

  if (policy === 'last-wins') {
    return conflict.servers[conflict.servers.length - 1] as string;
  }

  if (typeof policy === 'object') {
    if (!conflict.servers.includes(policy.server)) {
      throw createSyncEngineError(
        'E_CONFLICT',
        `Cross-server conflict for skill ${conflict.skill} does not include selected server ${policy.server}`
      );
    }

    return policy.server;
  }

  if (options.noInteractive) {
    throw createSyncEngineError('E_NEEDS_INPUT', `Cross-server conflict for skill ${conflict.skill} requires a winner`);
  }

  try {
    return await select({
      message: `Choose which server wins for skill "${conflict.skill}"`,
      choices: [
        ...conflict.servers.map((server) => ({ name: server, value: server })),
        { name: 'Abort', value: '__abort__' }
      ]
    }).then((value) => {
      if (value === '__abort__') {
        throw createSyncEngineError(
          'E_CONFLICT',
          `Cross-server conflict for skill ${conflict.skill}: ${conflict.servers.join(', ')}`
        );
      }

      return value;
    });
  } catch (error) {
    if (error instanceof Error && /^E_(CONFLICT|NEEDS_INPUT):/.test(error.message)) {
      throw error;
    }

    throw createSyncEngineError('E_NEEDS_INPUT', `Cross-server conflict for skill ${conflict.skill} requires a winner`);
  }
}

async function planCrossServerResolution(
  homeDir: string,
  targetServers: string[],
  options: SyncEngineOptions
): Promise<{
  skipPullSkillsByServer?: Record<string, string[]>;
  preferLocalSkillsByServer?: Record<string, string[]>;
}> {
  if (targetServers.length < 2) {
    return {};
  }

  const config = await loadConfig(homeDir);
  const policy = parseCrossServerPolicy(config, options.crossServerPolicy, options.yes);
  const runtime = options.runtime ?? createTransportRuntime();
  const manifests: Array<{ server: string; manifest: ServerManifest }> = [];

  for (const serverName of targetServers) {
    const server = getConfiguredServer(config, serverName);
    const updated = await prepareManifest(homeDir, server, runtime, options.now);
    manifests.push({ server: serverName, manifest: updated.manifest });
  }

  const conflicts = detectCrossServerConflicts(manifests, targetServers);
  if (conflicts.length === 0) {
    return {};
  }
  const skipPullSkillsByServer = new Map<string, string[]>();
  const preferLocalSkillsByServer = new Map<string, string[]>();

  for (const conflict of conflicts) {
    const winner = await chooseConflictWinner(conflict, policy, options);

    for (const server of conflict.servers) {
      if (server === winner) {
        continue;
      }

      skipPullSkillsByServer.set(server, uniqueSorted([...(skipPullSkillsByServer.get(server) ?? []), conflict.skill]));
      preferLocalSkillsByServer.set(server, uniqueSorted([...(preferLocalSkillsByServer.get(server) ?? []), conflict.skill]));
    }
  }

  return {
    skipPullSkillsByServer: skipPullSkillsByServer.size > 0 ? Object.fromEntries(skipPullSkillsByServer) : undefined,
    preferLocalSkillsByServer: preferLocalSkillsByServer.size > 0 ? Object.fromEntries(preferLocalSkillsByServer) : undefined,
  };
}

export async function pushToServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<PushResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const results: PushResult[] = [];
  for (const serverName of targetServers) {
    results.push(await withServerTimeout(serverName, options, () => pushToServer(homeDir, serverName, options, config)));
  }
  return results;
}

async function pushToServer(
  homeDir: string,
  serverName: string,
  options: SyncEngineOptions,
  config: SyncSkillConfig
): Promise<PushResult> {
  const runtime = options.runtime ?? createTransportRuntime();
  const configuredConflictPolicy = resolveSingleServerConflictPolicy(config.conflict_resolution, options.onConflict);

  {
    const server = getConfiguredServer(config, serverName);
    const includeState = includeStateOf(config, serverName);
    const pushSet = includeState.kind === 'list' ? includeState.skills : includeState.kind === 'unset' ? null : new Set<string>();
    const included = (skill: string): boolean => pushSet === null || pushSet.has(skill);
    const includeWarnings: PushWarning[] = includeState.kind === 'empty'
      ? [{ code: 'no-skills-configured', detail: 'this server\'s skills.include is empty; nothing is carried to it (and that alone deletes nothing)' }]
      : includeState.kind === 'unset'
        ? [{ code: 'no-skills-configured', detail: 'skills.include is not set and no links are configured; nothing is carried to this server and nothing is removed from it' }]
        : [];
    let receiverBackup = await loadReceiverBackupIfExists(homeDir, serverName);
    if (receiverBackup) {
      const mergedBackup = mergeConfiguredLinksIntoReceiverBackup(
        receiverBackup,
        config.links,
        getIncludedServerSkills(config, serverName),
        options.now ?? new Date().toISOString()
      );
      if (mergedBackup !== receiverBackup) {
        // Tester #474: a dry run uses the merged links in memory and writes nothing locally.
        if (options.dryRun !== true) await saveReceiverBackup(homeDir, mergedBackup);
        receiverBackup = mergedBackup;
      }
    }
    const receiverConfig = buildReceiverConfigPayload(server, receiverBackup);
    const updated = await prepareManifest(homeDir, server, runtime, options.now, options.dryRun === true);
    if (updated.remoteUnknown) includeWarnings.push({ code: 'remote-state-unknown', detail: `no syncskill receiver on ${serverName}; a dry run does not install one` });
    let manifest = applyConflictPolicy(updated.manifest, configuredConflictPolicy, updated.updatedAt);

    const preferredLocalSkills = options.preferLocalSkillsByServer?.[serverName] ?? [];
    if (preferredLocalSkills.length > 0) {
      manifest = resolvePreferredLocalSkills(manifest, preferredLocalSkills, updated.updatedAt);
    }

    const conflictedSkills = listSkillsByDirection(manifest, 'conflict').filter(included);
    const pushedSkills = listSkillsByDirection(manifest, 'push').filter(included);
    const pullSkills = listSkillsByDirection(manifest, 'pull').filter(included);

    if (options.onConflict === 'abort' && conflictedSkills.length > 0) {
      throw createSyncEngineError('E_CONFLICT', `Content conflict on ${serverName}: ${conflictedSkills.join(', ')}`);
    }

    // Print warnings for skills that have remote changes (tester #477: not into --json's stdout)
    if (options.json !== true) {
      for (const skill of pullSkills) {
        console.log(`  Skipping ${skill}: remote has changes. Use \`syncskill pull\` to update local.`);
      }
    }

    // Safety net: verify remote skills exist when --no-refresh is used
    let finalPushedSkills = pushedSkills;
    let remoteSkillListForCleanup: string[] | null = null;
    if (options.noRefresh) {
      const remoteSkillList = await listRemoteSkills(server, runtime);
      remoteSkillListForCleanup = remoteSkillList;
      const remoteSkillSet = new Set(remoteSkillList);

      // Find skills marked as skip but missing remotely
      const skipSkills = listSkillsByDirection(manifest, 'skip').filter(included);
      const missingRemotely = skipSkills.filter(skill =>
        manifest.skills[skill]?.local_hash !== null && !remoteSkillSet.has(skill)
      );

      if (missingRemotely.length > 0) {
        if (options.json !== true) console.log(`  Safety net: ${missingRemotely.length} skill(s) missing remotely, forcing push`);
        // Force these to push by treating them as new local-only skills
        for (const skill of missingRemotely) {
          if (manifest.skills[skill]) {
            // Set remote_hash and recorded_hash to null to force push direction on reconciliation
            // This makes reconcileManifest see it as a new local-only skill (push, status: new)
            manifest.skills[skill].remote_hash = null;
            manifest.skills[skill].recorded_hash = null;
          }
        }
        // Re-compute pushed skills list after safety net (reconcileManifest will now see local-only)
        finalPushedSkills = listSkillsByDirection(manifest, 'push').filter(included);
      }
    }

    // Dry-run mode: show what would happen without executing
    if (options.dryRun) {
      // Tester #449: the cleanup below deletes remote skills, and this branch used to return before it ran, so a plan
      // that would remove half the remote skills printed `(no changes)`. The orphan set is computed here the same way.
      const wouldDelete = orphansForCleanup(remoteSkillListForCleanup ?? await listRemoteSkills(server, runtime), manifest, included, includeState, includeWarnings);
      // Tester #477: the plan is the result. The human lines below and the --json summary are both rendered from it, so
      // they cannot disagree: planned pushes (content), and ONE deletion set -- skills deleted locally (manifest) and
      // remote skills no longer in local config (orphans), deduplicated.
      const manifestDeletions = finalPushedSkills.filter((skill) => isLocalDeletion(manifest.skills[skill]));
      const plan: PushResult = {
        server: serverName,
        pushed_skills: finalPushedSkills.filter((skill) => !manifestDeletions.includes(skill)),
        skipped_skills: uniqueSorted([
          ...pullSkills,
          ...(options.onConflict === 'skip' ? conflictedSkills : [])
        ]),
        conflicted_skills: conflictedSkills,
        manifest,
        deleted_skills: uniqueSorted([...manifestDeletions, ...wouldDelete]),
        ...(includeWarnings.length === 0 ? {} : { warnings: includeWarnings })
      };
      if (options.json !== true) {
        for (const line of formatPushPlan(plan)) console.log(line);
      }
      return plan;
    }

    // Cleanup's view of the remote, read before any upload (tester #456 follow-up): a listing that fails aborts the
    // push with nothing written, as CHANGELOG says, instead of after the skills were already sent.
    const remoteSkillsForCleanup = remoteSkillListForCleanup ?? await listRemoteSkills(server, runtime);

    for (const skill of finalPushedSkills) {
      await pushSkillDirectory(server, join(getSkillsDir(homeDir), skill), skill, runtime);
    }

    // Local skills this server is included for and that still have content (issue 404: a skill
    // removed from the link matrix / include is cleaned up remotely, not carried along).
    const localSkillSet = new Set(
      Object.keys(manifest.skills).filter(skill => manifest.skills[skill]?.local_hash !== null && included(skill))
    );

    // Remote skills not in local config. Tester #449: an explicitly empty include authorises no deletion -- it says the
    // server carries no skills, not that whatever is on it should be destroyed.
    const orphanSkills = orphansForCleanup(remoteSkillsForCleanup, manifest, included, includeState, includeWarnings);
    let deletedSkills: string[] = [];

    if (orphanSkills.length > 0 && !options.dryRun) {
      if (options.json !== true) {
        console.log(`\nRemote skills to remove (no longer in local config):`);
        for (const skill of orphanSkills) {
          console.log(`  - ${skill}`);
        }
      }

      cleanupEnsureAllowed(updated.previousManifest, serverName, orphanSkills, options);
      if (options.json !== true) cleanupRiskWarning(updated.previousManifest, serverName, orphanSkills);

      let shouldDelete = cleanupShouldDelete(options);
      if (!shouldDelete && cleanupShouldPrompt(options)) {
        const prompt = cleanupPromptConfig(updated.previousManifest, serverName, orphanSkills);
        try {
          shouldDelete = await confirm(prompt);
        } catch {
          shouldDelete = false;
        }
      } else if (cleanupShouldSkipPrompt(options)) {
        shouldDelete = false;
      }

      if (shouldDelete) {
        await deleteRemoteSkills(server, orphanSkills, runtime);
        deletedSkills = [...orphanSkills];
        if (options.json !== true) console.log(`  Removed ${orphanSkills.length} remote skill(s)`);
      } else {
        if (options.json !== true) console.log(cleanupSkippedMessage(updated.previousManifest, serverName, orphanSkills));
      }
    }

    const finalizedManifest = finalizeDeletedSkills(finalizePushedSkills(manifest, finalPushedSkills, updated.updatedAt), finalPushedSkills, updated.updatedAt);
    await pushManifest(server, finalizedManifest, runtime);
    await applyRemoteLinks(server, runtime, receiverConfig);
    await persistManifestState(homeDir, updated.previousManifest, finalizedManifest, updated.updatedAt);

    return {
      server: server.name,
      pushed_skills: finalPushedSkills,
      deleted_skills: deletedSkills,
      ...(includeWarnings.length === 0 ? {} : { warnings: includeWarnings }),
      skipped_skills: uniqueSorted([
        ...pullSkills,
        ...(options.onConflict === 'skip' ? conflictedSkills : [])
      ]),
      conflicted_skills: conflictedSkills,
      manifest: finalizedManifest
    };
  }
}

export async function pullFromServer(homeDir: string, serverName: string, options: SyncEngineOptions = {}): Promise<PullResult> {
  return withServerTimeout(serverName, options, () => pullFromServerWork(homeDir, serverName, options));
}

async function pullFromServerWork(homeDir: string, serverName: string, options: SyncEngineOptions = {}): Promise<PullResult> {
  const config = await loadConfig(homeDir);
  const server = getConfiguredServer(config, serverName);
  const runtime = options.runtime ?? createTransportRuntime();
  const updated = await prepareManifest(homeDir, server, runtime, options.now, options.dryRun === true);
  if (updated.remoteUnknown && options.json !== true) console.log(`  warning: remote-state-unknown: no syncskill receiver on ${serverName}; a dry run does not install one`);
  let manifest = applyConflictPolicy(
    updated.manifest,
    resolveSingleServerConflictPolicy(config.conflict_resolution, options.onConflict),
    updated.updatedAt
  );

  const preferredLocalSkills = options.preferLocalSkillsByServer?.[serverName] ?? [];
  if (preferredLocalSkills.length > 0) {
    manifest = resolvePreferredLocalSkills(manifest, preferredLocalSkills, updated.updatedAt);
  }

  const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
  if (options.onConflict === 'abort' && conflictedSkills.length > 0) {
    throw createSyncEngineError('E_CONFLICT', `Content conflict on ${serverName}: ${conflictedSkills.join(', ')}`);
  }

  const skippedCrossServerSkills = new Set(options.skipPullSkillsByServer?.[serverName] ?? []);
  const skippedConflictSkills = options.onConflict === 'skip' ? conflictedSkills : [];
  const reportedConflicts = options.onConflict === 'skip' ? [] : conflictedSkills;
  const pulledSkillsForExecution = listSkillsByDirection(manifest, 'pull').filter(
    (skill) => !skippedCrossServerSkills.has(skill) && !skippedConflictSkills.includes(skill)
  );
  const remoteDeletionCandidates = pulledSkillsForExecution.filter((skill) => isRemoteDeletionState(manifest.skills[skill]));
  const pulledContentSkills = pulledSkillsForExecution.filter((skill) => !remoteDeletionCandidates.includes(skill));
  const { deleteSkills: deletedSkillsForExecution, keepLocalSkills: keptLocalDeletionSkills } = await resolvePullDeletionActions(
    serverName,
    remoteDeletionCandidates,
    options
  );
  const skippedResultSkills = uniqueSorted([
    ...[...skippedCrossServerSkills],
    ...skippedConflictSkills
  ]);

  if (options.dryRun) {
    if (options.json !== true) {
      console.log(`\n[dry-run] pull from ${serverName}:\n`);

      let totalAdded = 0;
      let totalModified = 0;
      let totalDeleted = 0;

      for (const skill of pulledContentSkills) {
        const state = manifest.skills[skill];
        const isNew = state.remote_hash && !state.local_hash;

        if (isNew) {
          console.log(`  + ${skill} (new)`);
          totalAdded++;
        } else {
          console.log(`  ~ ${skill} (modified)`);
          totalModified++;
        }
      }

      for (const skill of deletedSkillsForExecution) {
        console.log(`  - ${skill} (deleted)`);
        totalDeleted++;
      }

      for (const skill of keptLocalDeletionSkills) {
        console.log(`  = ${skill} (kept local)`);
      }

      for (const skill of reportedConflicts) {
        console.log(`  ! ${skill} (conflict)`);
      }

      if (
        pulledContentSkills.length === 0 &&
        deletedSkillsForExecution.length === 0 &&
        keptLocalDeletionSkills.length === 0 &&
        reportedConflicts.length === 0
      ) {
        console.log('  (no changes)');
      } else {
        const parts: string[] = [];
        if (totalAdded > 0) parts.push(`${totalAdded} added`);
        if (totalModified > 0) parts.push(`${totalModified} modified`);
        if (totalDeleted > 0) parts.push(`${totalDeleted} deleted`);
        if (keptLocalDeletionSkills.length > 0) parts.push(`${keptLocalDeletionSkills.length} kept local`);
        if (reportedConflicts.length > 0) parts.push(`${reportedConflicts.length} conflict(s)`);

        const skillCount =
          pulledContentSkills.length + deletedSkillsForExecution.length + keptLocalDeletionSkills.length + reportedConflicts.length;
        console.log(`\nSummary: ${skillCount} skill(s), ${parts.join(', ')}`);
      }
    }

    return {
      server: serverName,
      pulled_skills: [],
      deleted_skills: [],
      skipped_skills: uniqueSorted([
        ...keptLocalDeletionSkills,
        ...skippedResultSkills
      ]),
      conflicted_skills: reportedConflicts,
      backups: [],
      manifest
    };
  }

  const registry = await buildSkillsRegistry(homeDir);
  const backups = resolvePullBackupEnabled(config, options)
    ? await backupPullTargets(homeDir, serverName, [...pulledContentSkills, ...deletedSkillsForExecution], registry)
    : [];

  for (const skill of pulledContentSkills) {
    const entry = registry.skills[skill];
    const targetPath = entry?.path ?? join(getSkillsDir(homeDir), skill);
    await pullSkillDirectory(server, skill, targetPath, runtime);
  }

  for (const skill of deletedSkillsForExecution) {
    const entry = registry.skills[skill];
    const targetPath = entry?.path ?? join(getSkillsDir(homeDir), skill);
    await rm(targetPath, { recursive: true, force: true });
  }

  const localHashes = pulledContentSkills.length === 0 && deletedSkillsForExecution.length === 0 ? {} : await buildLocalSkillHashes(homeDir);
  const refreshedManifest = reconcileManifest({
    ...manifest,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => [
        skill,
        pulledContentSkills.includes(skill)
          ? {
              ...state,
              local_hash: localHashes[skill] ?? state.local_hash
            }
          : deletedSkillsForExecution.includes(skill)
            ? {
                ...state,
                local_hash: localHashes[skill] ?? null
              }
            : state
      ])
    )
  });
  let finalizedManifest = finalizePulledSkills(refreshedManifest, pulledContentSkills, updated.updatedAt);
  finalizedManifest = detachKeptLocalDeletionSkills(finalizedManifest, keptLocalDeletionSkills, updated.updatedAt);
  finalizedManifest = finalizePulledDeletionSkills(finalizedManifest, deletedSkillsForExecution, updated.updatedAt);

  await persistManifestState(homeDir, updated.previousManifest, finalizedManifest, updated.updatedAt);

  return {
    server: server.name,
    pulled_skills: pulledContentSkills,
    deleted_skills: deletedSkillsForExecution,
    skipped_skills: uniqueSorted([
      ...keptLocalDeletionSkills,
      ...skippedResultSkills
    ]),
    conflicted_skills: reportedConflicts,
    backups,
    manifest: finalizedManifest
  };
}

export async function pullFromServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<PullResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const planned = await planCrossServerResolution(homeDir, targetServers, options);
  const resolvedOptions: SyncEngineOptions = {
    ...options,
    skipPullSkillsByServer: mergeSkillMaps(options.skipPullSkillsByServer, planned.skipPullSkillsByServer),
    preferLocalSkillsByServer: mergeSkillMaps(options.preferLocalSkillsByServer, planned.preferLocalSkillsByServer)
  };
  const results: PullResult[] = [];

  for (const serverName of targetServers) {
    results.push(await pullFromServer(homeDir, serverName, resolvedOptions));
  }

  return results;
}

export async function syncServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<SyncResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const planned = await planCrossServerResolution(homeDir, targetServers, options);
  const resolvedOptions: SyncEngineOptions = {
    ...options,
    skipPullSkillsByServer: mergeSkillMaps(options.skipPullSkillsByServer, planned.skipPullSkillsByServer),
    preferLocalSkillsByServer: mergeSkillMaps(options.preferLocalSkillsByServer, planned.preferLocalSkillsByServer)
  };
  const pulls: PullResult[] = [];

  for (const serverName of targetServers) {
    pulls.push(await pullFromServer(homeDir, serverName, resolvedOptions));
  }

  const pushes = await pushToServers(homeDir, targetServers, resolvedOptions);

  return targetServers.map((serverName) => {
    const pull = pulls.find((result) => result.server === serverName);
    const push = pushes.find((result) => result.server === serverName);

    if (!pull || !push) {
      throw new Error(`Missing sync result for server: ${serverName}`);
    }

    return {
      server: serverName,
      pull,
      push
    };
  });
}

export async function syncServer(homeDir: string, serverName: string, options: SyncEngineOptions = {}): Promise<SyncResult> {
  const [result] = await syncServers(homeDir, [serverName], options);
  return result;
}

async function prepareManifest(
  homeDir: string,
  server: ConfiguredServer,
  runtime: TransportRuntime,
  now?: string,
  readOnly = false
): Promise<{ previousManifest: ServerManifest; manifest: ServerManifest; updatedAt: string; remoteUnknown: boolean }> {
  const updatedAt = now ?? new Date().toISOString();
  const previousManifest = await loadServerManifest(homeDir, server.name);
  const localHashes = await buildLocalSkillHashes(homeDir, !readOnly);
  const { manifest: remoteManifest, unknown: remoteUnknown } = await fetchRemoteState(server, runtime, readOnly);
  const nextManifest = reconcileManifest({
    ...applyRemoteSnapshot(
      {
        ...previousManifest,
        updated_at: updatedAt,
        skills: Object.fromEntries(
          [...new Set([...Object.keys(previousManifest.skills), ...Object.keys(localHashes), ...Object.keys(remoteManifest.skills)])]
            .sort()
            .map((skill) => [
              skill,
              {
                ...(previousManifest.skills[skill] ?? {
                  local_hash: null,
                  remote_hash: null,
                  recorded_hash: null,
                  direction: 'skip' as const,
                  status: 'in-sync' as const
                }),
                local_hash: localHashes[skill] ?? null
              }
            ])
        )
      },
      Object.fromEntries(Object.entries(remoteManifest.skills).map(([skill, state]) => [skill, state.remote_hash]).filter((entry): entry is [string, string] => entry[1] !== null)),
      updatedAt
    )
  });

  return {
    previousManifest,
    manifest: nextManifest,
    updatedAt,
    remoteUnknown
  };
}

async function fetchRemoteState(server: ConfiguredServer, runtime: TransportRuntime, readOnly = false): Promise<{ manifest: ServerManifest; unknown: boolean }> {
  if (!readOnly) {
    await deployReceiver(server, runtime);
    return { manifest: await fetchRemoteManifest(server, runtime), unknown: false };
  }
  // Tester #471: a dry run only reads -- the installed receiver's manifest. No mkdir, no bootstrap, no receiver upload
  // and no receiver_config.json write. A transport failure still fails; a remote with no (working) receiver has no
  // state to read, and the plan says so instead of installing one.
  try {
    return { manifest: await fetchRemoteManifest(server, runtime), unknown: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTransportFailure(error)) {
      throw new Error(`E_REMOTE_TRANSPORT: cannot reach ${server.name} to read its manifest: ${message}`);
    }
    return { manifest: createEmptyManifest(server.name), unknown: true };
  }
}

function applyConflictPolicy(
  manifest: ServerManifest,
  policy: ConflictResolution,
  updatedAt: string
): ServerManifest {
  if (policy === 'keep-local') {
    return resolveConflicts(manifest, 'local', updatedAt);
  }

  if (policy === 'keep-remote') {
    return resolveConflicts(manifest, 'remote', updatedAt);
  }

  return reconcileManifest(manifest);
}

function resolveConflicts(manifest: ServerManifest, take: 'local' | 'remote', updatedAt: string): ServerManifest {
  let current = reconcileManifest(manifest);

  for (const skill of listSkillsByDirection(current, 'conflict')) {
    current = applyResolution(current, skill, take, updatedAt);
  }

  return current;
}

function resolveDeletionPolicy(policy: SyncEngineOptions['onDeletion']): 'keep-local' | 'delete' | 'prompt' {
  return policy ?? 'keep-local';
}

function requiresDestructiveApproval(options: SyncEngineOptions): boolean {
  return options.yes === true || options.noInteractive === true || options.json === true;
}

function listNoBaselineRemoteSkills(previousManifest: ServerManifest, orphanSkills: string[]): string[] {
  return orphanSkills.filter((skill) => previousManifest.skills[skill]?.recorded_hash == null);
}

function formatNoBaselineWarning(serverName: string, skills: string[]): string {
  return `W_NO_BASELINE_RISK: ${serverName} remote-only skills would be deleted without a baseline: ${skills.join(', ')}`;
}

function cleanupEnsureAllowed(
  previousManifest: ServerManifest,
  serverName: string,
  orphanSkills: string[],
  options: SyncEngineOptions
): void {
  const riskySkills = listNoBaselineRemoteSkills(previousManifest, orphanSkills);
  if (riskySkills.length === 0) {
    return;
  }

  if (requiresDestructiveApproval(options) && options.yesDestructive !== true) {
    throw createSyncEngineError(
      'E_USAGE',
      `Push to ${serverName} would delete remote skills without a baseline: ${riskySkills.join(', ')}`
    );
  }
}

function cleanupRiskWarning(previousManifest: ServerManifest, serverName: string, orphanSkills: string[]): void {
  const riskySkills = listNoBaselineRemoteSkills(previousManifest, orphanSkills);
  if (riskySkills.length > 0) {
    console.log(formatNoBaselineWarning(serverName, riskySkills));
  }
}

function cleanupPromptConfig(
  previousManifest: ServerManifest,
  serverName: string,
  orphanSkills: string[]
): { message: string; default: boolean } {
  const riskySkills = listNoBaselineRemoteSkills(previousManifest, orphanSkills);
  if (riskySkills.length === 0) {
    return {
      message: `Remove ${orphanSkills.length} remote skill(s)?`,
      default: false
    };
  }

  return {
    message: `No baseline exists for ${riskySkills.join(', ')} on ${serverName}. Remove ${orphanSkills.length} remote skill(s)?`,
    default: false
  };
}

function cleanupSkippedMessage(_previousManifest: ServerManifest, _serverName: string, _orphanSkills: string[]): string {
  return '  Skipped remote cleanup';
}

function cleanupShouldDelete(options: SyncEngineOptions): boolean {
  return options.yes === true && options.yesDestructive === true;
}

function cleanupShouldSkipPrompt(options: SyncEngineOptions): boolean {
  return options.yes === false || (requiresDestructiveApproval(options) && !cleanupShouldDelete(options));
}

function cleanupShouldPrompt(options: SyncEngineOptions): boolean {
  return options.yes !== true && options.yes !== false && options.noInteractive !== true && options.json !== true;
}

function cleanupUsageHint(): string {
  return 'Re-run with --yes-destructive to allow remote cleanup';
}

function isRemoteDeletionState(state: ManifestSkillState | undefined): boolean {
  return state !== undefined && state.remote_hash === null && state.recorded_hash !== null && state.local_hash === state.recorded_hash;
}

async function resolvePullDeletionActions(
  serverName: string,
  deletionCandidates: string[],
  options: SyncEngineOptions
): Promise<{ deleteSkills: string[]; keepLocalSkills: string[] }> {
  if (deletionCandidates.length === 0) {
    return { deleteSkills: [], keepLocalSkills: [] };
  }

  const policy = resolveDeletionPolicy(options.onDeletion);
  if (policy === 'delete') {
    return { deleteSkills: deletionCandidates, keepLocalSkills: [] };
  }

  if (policy === 'keep-local') {
    return { deleteSkills: [], keepLocalSkills: deletionCandidates };
  }

  if (options.noInteractive) {
    throw createSyncEngineError('E_NEEDS_INPUT', `Remote deletion on ${serverName} requires a decision`);
  }

  const deleteSkills: string[] = [];
  const keepLocalSkills: string[] = [];

  for (const skill of deletionCandidates) {
    let shouldDelete = false;

    try {
      shouldDelete = await confirm({
        message: `Delete local skill "${skill}" removed from ${serverName}?`,
        default: false
      });
    } catch {
      shouldDelete = false;
    }

    if (shouldDelete) {
      deleteSkills.push(skill);
    } else {
      keepLocalSkills.push(skill);
    }
  }

  return { deleteSkills, keepLocalSkills };
}

function detachKeptLocalDeletionSkills(manifest: ServerManifest, skills: string[], updatedAt: string): ServerManifest {
  if (skills.length === 0) {
    return manifest;
  }

  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: { ...manifest.skills }
  });
}

function finalizePulledDeletionSkills(manifest: ServerManifest, skills: string[], updatedAt: string): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill)) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            local_hash: null,
            remote_hash: null,
            recorded_hash: null
          }
        ];
      })
    )
  });
}

function listSkillsByDirection(manifest: ServerManifest, direction: 'push' | 'pull' | 'skip' | 'conflict'): string[] {
  return Object.entries(reconcileManifest(manifest).skills)
    .filter(([, state]) => state.direction === direction)
    .map(([skill]) => skill)
    .sort();
}

async function persistManifestState(
  homeDir: string,
  previousManifest: ServerManifest,
  nextManifest: ServerManifest,
  updatedAt: string
): Promise<void> {
  const history = await loadManifestHistory(homeDir);
  history.entries.push(...collectRemoteHistoryEntries(previousManifest, nextManifest, updatedAt), ...collectRecordedHistoryEntries(previousManifest, nextManifest, updatedAt));
  await saveServerManifest(homeDir, nextManifest);
  await saveManifestHistory(homeDir, history);
}

function collectRecordedHistoryEntries(
  previous: ServerManifest,
  next: ServerManifest,
  updatedAt: string
): ManifestHistoryEntry[] {
  const skills = [...new Set([...Object.keys(previous.skills), ...Object.keys(next.skills)])].sort();

  return skills.flatMap((skill) => {
    const before = previous.skills[skill]?.recorded_hash ?? null;
    const after = next.skills[skill]?.recorded_hash ?? null;

    if (before === after) {
      return [];
    }

    return [
      {
        skill,
        server: next.server,
        old_hash: before,
        new_hash: after,
        direction: 'remote',
        updated_at: updatedAt
      }
    ];
  });
}

function resolveTargetServers(
  config: Awaited<ReturnType<typeof loadConfig>>,
  servers?: string[]
): string[] {
  return servers === undefined || servers.length === 0 ? Object.keys(config.servers) : [...new Set(servers)];
}

function getIncludedServerSkills(config: SyncSkillConfig, serverName: string): string[] {
  const serverRecord = config.servers[serverName] as Record<string, unknown> | undefined;
  const serverSkills = serverRecord?.skills as { include?: string[] } | undefined;
  const included = Array.isArray(serverSkills?.include)
    ? serverSkills.include.filter((skill): skill is string => typeof skill === 'string')
    : Object.keys(config.links);
  return [...new Set(included)].sort();
}

/**
 * Issue 404: the skills a server is served. An explicit `servers.<name>.skills.include` wins; without
 * one the link matrix (`config.links` keys) is the set. A config that declares neither names no subset at all: the
 * push carries every local skill, but nothing is authorised to remove anything from the remote (tester #480 --
 * "absent" is not "empty"). `null` means no limit.
 */
/** Tester #449: the remote skills a push would remove -- ONE computation for the dry run and the real cleanup. */
function orphansForCleanup(remoteSkills: string[], manifest: ServerManifest, included: (skill: string) => boolean, includeState: IncludeState, warnings: PushWarning[] = []): string[] {
  // Tester #480: `unset` means "no subset was ever named", so it authorises nothing remotely -- it must not read as
  // "delete everything", which was the legacy behaviour and destroyed a remote that never had a local counterpart.
  if (includeState.kind === 'empty' || includeState.kind === 'unset') return [];
  const localSkillSet = new Set(
    Object.keys(manifest.skills).filter((skill) => manifest.skills[skill]?.local_hash !== null && included(skill))
  );
  return remoteSkills.filter((skill) => {
    if (localSkillSet.has(skill)) return false;
    // Tester #472: a skill the include list names that this machine has no content for is deleted only when the manifest recorded it as
    // synced (a local deletion to carry); on a fresh machine or a wrong --sync-dir it is kept and named.
    if (includeState.kind === 'list' && included(skill) && !manifest.skills[skill]?.recorded_hash) {
      if (!warnings.some((w) => w.code === 'included-not-local' && w.detail === skill)) warnings.push({ code: 'included-not-local', detail: skill });
      return false;
    }
    return true;
  });
}

function includeStateOf(config: SyncSkillConfig, serverName: string): IncludeState {
  const serverRecord = config.servers[serverName] as Record<string, unknown> | undefined;
  const serverSkills = serverRecord?.skills as { include?: unknown } | undefined;
  if (Array.isArray(serverSkills?.include)) {
    const skills = new Set(serverSkills.include.filter((skill): skill is string => typeof skill === 'string'));
    // Tester #449: an explicitly empty include means "this server carries no skills", which is not the same statement as
    // "delete whatever is there". Reachable only by hand-editing the config (the UI unsets instead), and it used to
    // authorise `ssh rm -rf` of every remote skill.
    return skills.size === 0 ? { kind: 'empty' } : { kind: 'list', skills };
  }
  const linkNames = Object.keys(config.links);
  return linkNames.length > 0 ? { kind: 'list', skills: new Set(linkNames) } : { kind: 'unset' };
}

function pushSetOf(config: SyncSkillConfig, serverName: string): Set<string> | null {
  const state = includeStateOf(config, serverName);
  return state.kind === 'list' ? state.skills : state.kind === 'unset' ? null : new Set();
}

function getSkillsDir(homeDir: string): string {
  return getSyncPaths(homeDir).skillsDir;
}

function finalizeDeletedSkills(manifest: ServerManifest, skills: string[], updatedAt: string): ServerManifest {
  return reconcileManifest({
    ...manifest,
    updated_at: updatedAt,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => {
        if (!skills.includes(skill) || state.local_hash !== null || state.recorded_hash !== null) {
          return [skill, state];
        }

        return [
          skill,
          {
            ...state,
            remote_hash: null,
            recorded_hash: null
          }
        ];
      })
    )
  });
}

function isLocalDeletion(state: ServerManifest['skills'][string] | undefined): boolean {
  return state !== undefined && state.local_hash === null && state.remote_hash !== null;
}

/** One warning, one line, in both the dry-run plan and a real push's output (tester #477). */
export function formatPushWarning(warning: PushWarning): string {
  return `  warning: ${warning.code}: ${warning.detail}`;
}

/** Tester #477: the dry-run plan a person reads, rendered only from the result --json reports. */
export function formatPushPlan(result: PushResult): string[] {
  const lines = ['', `[dry-run] push to ${result.server}:`, ''];
  let added = 0;
  let modified = 0;
  for (const skill of result.pushed_skills) {
    const state = result.manifest.skills[skill];
    if (state?.local_hash && !state.remote_hash) {
      lines.push(`  + ${skill} (new)`);
      added++;
    } else {
      lines.push(`  ~ ${skill} (modified)`);
      modified++;
    }
  }
  const deleted = result.deleted_skills ?? [];
  for (const skill of deleted) lines.push(`  - ${skill} (deleted)`);
  for (const skill of result.conflicted_skills) lines.push(`  ! ${skill} (conflict)`);
  for (const warning of result.warnings ?? []) lines.push(formatPushWarning(warning));

  const total = result.pushed_skills.length + deleted.length + result.conflicted_skills.length;
  if (total === 0) {
    lines.push('  (no changes)');
    return lines;
  }
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (modified > 0) parts.push(`${modified} modified`);
  if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
  if (result.conflicted_skills.length > 0) parts.push(`${result.conflicted_skills.length} conflict(s)`);
  lines.push('', `Summary: ${total} skill(s), ${parts.join(', ')}`);
  return lines;
}
