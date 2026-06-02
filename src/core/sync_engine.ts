import { access, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getConfiguredServer, loadConfig, type ConfiguredServer, type ConflictResolution } from '../config/config.js';
import { loadSkillsRegistry } from './skills-registry.js';
import { applyResolution, reconcileManifest } from './conflict.js';
import {
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
  createTransportRuntime,
  deleteRemoteSkills,
  deployReceiver,
  fetchRemoteManifest,
  listRemoteSkills,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
  type TransportRuntime
} from './transport.js';
import { backupSkillBeforePull } from '../utils/backup.js';

export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
  noRefresh?: boolean;
  yes?: boolean;
  noInteractive?: boolean;
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

function createSyncEngineError(code: 'E_CONFLICT' | 'E_SERVER_NOT_FOUND' | 'E_NEEDS_INPUT', message: string): Error {
  return new Error(`${code}: ${message}`);
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
}

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
  registry: Awaited<ReturnType<typeof loadSkillsRegistry>>
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
    throw createSyncEngineError('E_SERVER_NOT_FOUND', `Server not found: ${policy}. Use server:${policy}`);
  }

  const server = policy.slice('server:'.length);
  if (!server || !(server in config.servers)) {
    throw createSyncEngineError('E_SERVER_NOT_FOUND', `Server not found: ${server}`);
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
  const runtime = options.runtime ?? createTransportRuntime();
  const results: PushResult[] = [];
  const configuredConflictPolicy = resolveSingleServerConflictPolicy(config.conflict_resolution, options.onConflict);

  for (const serverName of targetServers) {
    const server = getConfiguredServer(config, serverName);
    const updated = await prepareManifest(homeDir, server, runtime, options.now);
    let manifest = applyConflictPolicy(updated.manifest, configuredConflictPolicy, updated.updatedAt);

    const preferredLocalSkills = options.preferLocalSkillsByServer?.[serverName] ?? [];
    if (preferredLocalSkills.length > 0) {
      manifest = resolvePreferredLocalSkills(manifest, preferredLocalSkills, updated.updatedAt);
    }

    const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
    const pushedSkills = listSkillsByDirection(manifest, 'push');
    const pullSkills = listSkillsByDirection(manifest, 'pull');

    if (options.onConflict === 'abort' && conflictedSkills.length > 0) {
      throw createSyncEngineError('E_CONFLICT', `Content conflict on ${serverName}: ${conflictedSkills.join(', ')}`);
    }

    // Print warnings for skills that have remote changes
    for (const skill of pullSkills) {
      console.log(`  Skipping ${skill}: remote has changes. Use \`syncskill pull\` to update local.`);
    }

    // Safety net: verify remote skills exist when --no-refresh is used
    let finalPushedSkills = pushedSkills;
    let remoteSkillListForCleanup: string[] | null = null;
    if (options.noRefresh) {
      const remoteSkillList = await listRemoteSkills(server, runtime);
      remoteSkillListForCleanup = remoteSkillList;
      const remoteSkillSet = new Set(remoteSkillList);

      // Find skills marked as skip but missing remotely
      const skipSkills = listSkillsByDirection(manifest, 'skip');
      const missingRemotely = skipSkills.filter(skill =>
        manifest.skills[skill]?.local_hash !== null && !remoteSkillSet.has(skill)
      );

      if (missingRemotely.length > 0) {
        console.log(`  Safety net: ${missingRemotely.length} skill(s) missing remotely, forcing push`);
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
        finalPushedSkills = listSkillsByDirection(manifest, 'push');
      }
    }

    // Dry-run mode: show what would happen without executing
    if (options.dryRun) {
      console.log(`\n[dry-run] push to ${serverName}:\n`);

      let totalAdded = 0;
      let totalModified = 0;
      let totalDeleted = 0;

      for (const skill of finalPushedSkills) {
        const state = manifest.skills[skill];
        const isNew = state.local_hash && !state.remote_hash;
        const isDelete = !state.local_hash && state.remote_hash;

        if (isNew) {
          console.log(`  + ${skill} (new)`);
          totalAdded++;
        } else if (isDelete) {
          console.log(`  - ${skill} (deleted)`);
          totalDeleted++;
        } else {
          console.log(`  ~ ${skill} (modified)`);
          totalModified++;
        }
      }

      for (const skill of conflictedSkills) {
        console.log(`  ! ${skill} (conflict)`);
      }

      if (finalPushedSkills.length === 0 && conflictedSkills.length === 0) {
        console.log('  (no changes)');
      } else {
        // Summary line
        const parts: string[] = [];
        if (totalAdded > 0) parts.push(`${totalAdded} added`);
        if (totalModified > 0) parts.push(`${totalModified} modified`);
        if (totalDeleted > 0) parts.push(`${totalDeleted} deleted`);
        if (conflictedSkills.length > 0) parts.push(`${conflictedSkills.length} conflict(s)`);

        const skillCount = finalPushedSkills.length + conflictedSkills.length;
        console.log(`\nSummary: ${skillCount} skill(s), ${parts.join(', ')}`);
      }

      // Skip actual push, return result with empty pushed_skills
      results.push({
        server: serverName,
        pushed_skills: [],
        skipped_skills: uniqueSorted(pullSkills),
        conflicted_skills: conflictedSkills,
        manifest
      });
      continue;
    }

    for (const skill of finalPushedSkills) {
      await pushSkillDirectory(server, join(getSkillsDir(homeDir), skill), skill, runtime);
    }

    // Cleanup: remove remote skills not in current local config
    const remoteSkillsForCleanup = remoteSkillListForCleanup ?? await listRemoteSkills(server, runtime);

    // Local skills that have content (not deleted)
    const localSkillSet = new Set(
      Object.keys(manifest.skills).filter(skill => manifest.skills[skill]?.local_hash !== null)
    );

    // Remote skills not in local config
    const orphanSkills = remoteSkillsForCleanup.filter(skill => !localSkillSet.has(skill));

    if (orphanSkills.length > 0 && !options.dryRun) {
      console.log(`\nRemote skills to remove (no longer in local config):`);
      for (const skill of orphanSkills) {
        console.log(`  - ${skill}`);
      }

      let shouldDelete = false;
      if (options.yes === true) {
        // --yes flag: auto-confirm deletion
        shouldDelete = true;
      } else if (options.yes === false) {
        // Explicit yes=false: skip without prompting (for tests/scripts)
        shouldDelete = false;
      } else {
        // undefined: prompt interactively
        try {
          shouldDelete = await confirm({
            message: `Remove ${orphanSkills.length} remote skill(s)?`,
            default: false
          });
        } catch {
          // User cancelled or non-interactive
          shouldDelete = false;
        }
      }

      if (shouldDelete) {
        await deleteRemoteSkills(server, orphanSkills, runtime);
        console.log(`  Removed ${orphanSkills.length} remote skill(s)`);
      } else {
        console.log(`  Skipped remote cleanup`);
      }
    }

    const finalizedManifest = finalizeDeletedSkills(finalizePushedSkills(manifest, finalPushedSkills, updated.updatedAt), finalPushedSkills, updated.updatedAt);
    await pushManifest(server, finalizedManifest, runtime);
    await persistManifestState(homeDir, updated.previousManifest, finalizedManifest, updated.updatedAt);

    results.push({
      server: server.name,
      pushed_skills: finalPushedSkills,
      skipped_skills: uniqueSorted(pullSkills),
      conflicted_skills: conflictedSkills,
      manifest: finalizedManifest
    });
  }

  return results;
}

export async function pullFromServer(homeDir: string, serverName: string, options: SyncEngineOptions = {}): Promise<PullResult> {
  const config = await loadConfig(homeDir);
  const server = getConfiguredServer(config, serverName);
  const runtime = options.runtime ?? createTransportRuntime();
  const updated = await prepareManifest(homeDir, server, runtime, options.now);
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

  const registry = await loadSkillsRegistry(homeDir);
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
  now?: string
): Promise<{ previousManifest: ServerManifest; manifest: ServerManifest; updatedAt: string }> {
  const updatedAt = now ?? new Date().toISOString();
  const previousManifest = await loadServerManifest(homeDir, server.name);
  const localHashes = await buildLocalSkillHashes(homeDir);
  const remoteManifest = await fetchRemoteState(server, runtime);
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
    updatedAt
  };
}

async function fetchRemoteState(server: ConfiguredServer, runtime: TransportRuntime): Promise<ServerManifest> {
  await deployReceiver(server, runtime);
  return fetchRemoteManifest(server, runtime);
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

function getSkillsDir(homeDir: string): string {
  return join(homeDir, '.syncskill', 'skills');
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
