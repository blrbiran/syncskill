import { join } from 'node:path';

import { getConfiguredServer, loadConfig, type ConfiguredServer, type ConflictResolution } from './config.js';
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
  type ServerManifest
} from './manifest.js';
import {
  createTransportRuntime,
  deployReceiver,
  fetchRemoteManifest,
  pullSkillDirectory,
  pushManifest,
  pushSkillDirectory,
  type TransportRuntime
} from './transport.js';

export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
}

export interface PushResult {
  server: string;
  pushed_skills: string[];
  skipped_skills: string[];
  conflicted_skills: string[];
  manifest: ServerManifest;
}

export interface PullResult {
  server: string;
  pulled_skills: string[];
  skipped_skills: string[];
  conflicted_skills: string[];
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

export async function pushToServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<PushResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const runtime = options.runtime ?? createTransportRuntime();
  const results: PushResult[] = [];

  for (const serverName of targetServers) {
    const server = getConfiguredServer(config, serverName);
    const updated = await prepareManifest(homeDir, server, runtime, options.now);
    const manifest = applyConflictPolicy(updated.manifest, config.conflict_resolution, updated.updatedAt);
    const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
    const pushedSkills = listSkillsByDirection(manifest, 'push');

    // Dry-run mode: show what would happen without executing
    if (options.dryRun) {
      console.log(`\n[dry-run] push to ${serverName}:\n`);

      for (const skill of pushedSkills) {
        const state = manifest.skills[skill];
        // + for new (local exists, no remote), - for delete (no local, remote exists), ~ for update
        const action = state.local_hash && !state.remote_hash ? '+' :
                       !state.local_hash && state.remote_hash ? '-' : '~';
        console.log(`  ${action} ${skill}`);
      }

      for (const skill of conflictedSkills) {
        console.log(`  ! ${skill} (conflict)`);
      }

      if (pushedSkills.length === 0 && conflictedSkills.length === 0) {
        console.log('  (no changes)');
      }

      // Skip actual push, return result with empty pushed_skills
      results.push({
        server: serverName,
        pushed_skills: [],
        skipped_skills: [...pushedSkills, ...listSkillsByDirection(manifest, 'skip')],
        conflicted_skills: conflictedSkills,
        manifest
      });
      continue;
    }

    for (const skill of pushedSkills) {
      await pushSkillDirectory(server, join(getSkillsDir(homeDir), skill), skill, runtime);
    }

    const finalizedManifest = finalizeDeletedSkills(finalizePushedSkills(manifest, pushedSkills, updated.updatedAt), pushedSkills, updated.updatedAt);
    await pushManifest(server, finalizedManifest, runtime);
    await persistManifestState(homeDir, updated.previousManifest, finalizedManifest, updated.updatedAt);

    results.push({
      server: server.name,
      pushed_skills: pushedSkills,
      skipped_skills: listSkillsByDirection(finalizedManifest, 'skip'),
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
  const manifest = applyConflictPolicy(updated.manifest, config.conflict_resolution, updated.updatedAt);
  const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
  const pulledSkills = listSkillsByDirection(manifest, 'pull');

  // Dry-run mode: show what would happen without executing
  if (options.dryRun) {
    console.log(`\n[dry-run] pull from ${serverName}:\n`);

    for (const skill of pulledSkills) {
      const state = manifest.skills[skill];
      // + for new (remote exists, no local), - for delete (no remote, local exists), ~ for update
      const action = state.remote_hash && !state.local_hash ? '+' :
                     !state.remote_hash && state.local_hash ? '-' : '~';
      console.log(`  ${action} ${skill}`);
    }

    for (const skill of conflictedSkills) {
      console.log(`  ! ${skill} (conflict)`);
    }

    if (pulledSkills.length === 0 && conflictedSkills.length === 0) {
      console.log('  (no changes)');
    }

    // Skip actual pull, return result with empty pulled_skills
    return {
      server: serverName,
      pulled_skills: [],
      skipped_skills: [...pulledSkills, ...listSkillsByDirection(manifest, 'skip')],
      conflicted_skills: conflictedSkills,
      manifest
    };
  }

  for (const skill of pulledSkills) {
    await pullSkillDirectory(server, skill, join(getSkillsDir(homeDir), skill), runtime);
  }

  const localHashes = pulledSkills.length === 0 ? {} : await buildLocalSkillHashes(homeDir);
  const refreshedManifest = reconcileManifest({
    ...manifest,
    skills: Object.fromEntries(
      Object.entries(manifest.skills).map(([skill, state]) => [
        skill,
        pulledSkills.includes(skill)
          ? {
              ...state,
              local_hash: localHashes[skill] ?? state.local_hash
            }
          : state
      ])
    )
  });
  const finalizedManifest = finalizePulledSkills(refreshedManifest, pulledSkills, updated.updatedAt);

  await persistManifestState(homeDir, updated.previousManifest, finalizedManifest, updated.updatedAt);

  return {
    server: server.name,
    pulled_skills: pulledSkills,
    skipped_skills: listSkillsByDirection(finalizedManifest, 'skip'),
    conflicted_skills: conflictedSkills,
    manifest: finalizedManifest
  };
}

export async function pullFromServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<PullResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const results: PullResult[] = [];

  for (const serverName of targetServers) {
    results.push(await pullFromServer(homeDir, serverName, options));
  }

  return results;
}

export async function syncServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<SyncResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const pulls: PullResult[] = [];

  for (const serverName of targetServers) {
    pulls.push(await pullFromServer(homeDir, serverName, options));
  }

  const pushes = await pushToServers(homeDir, targetServers, options);

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
  const targetServers = servers === undefined || servers.length === 0 ? Object.keys(config.servers) : [...new Set(servers)];
  return targetServers.sort();
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
