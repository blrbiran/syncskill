import {
  type ManifestDirection,
  type ManifestSkillState,
  type ManifestStatus,
  type ServerManifest
} from './manifest.js';

export interface SkillDeltaClassification {
  direction: ManifestDirection;
  status: ManifestStatus;
}

export interface StatusRow {
  skill: string;
  server: string;
  direction: ManifestDirection;
  status: ManifestStatus;
  local_hash: string | null;
  remote_hash: string | null;
  recorded_hash: string | null;
}

export function classifySkillDelta(
  localHash: string | null,
  remoteHash: string | null,
  recordedHash: string | null
): SkillDeltaClassification {
  if (localHash === remoteHash) {
    return { direction: 'skip', status: 'in-sync' };
  }

  if (recordedHash === null) {
    if (localHash !== null && remoteHash === null) {
      return { direction: 'push', status: 'new' };
    }

    if (localHash === null && remoteHash !== null) {
      return { direction: 'pull', status: 'new' };
    }
  }

  if (localHash !== recordedHash && remoteHash === recordedHash) {
    return { direction: 'push', status: 'local-changed' };
  }

  if (remoteHash !== recordedHash && localHash === recordedHash) {
    return { direction: 'pull', status: 'remote-changed' };
  }

  if (localHash !== remoteHash) {
    return { direction: 'conflict', status: 'conflict' };
  }

  return { direction: 'skip', status: 'in-sync' };
}

export function reconcileManifest(manifest: ServerManifest): ServerManifest {
  const skills = Object.fromEntries(
    Object.entries(manifest.skills)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([skill, state]) => {
        const classification = classifySkillDelta(state.local_hash, state.remote_hash, state.recorded_hash);

        return [skill, { ...state, ...classification } satisfies ManifestSkillState];
      })
  );

  return {
    ...manifest,
    skills
  };
}

export function getStatusRows(manifest: ServerManifest): StatusRow[] {
  const reconciled = reconcileManifest(manifest);

  return Object.entries(reconciled.skills).map(([skill, state]) => ({
    skill,
    server: reconciled.server,
    direction: state.direction,
    status: state.status,
    local_hash: state.local_hash,
    remote_hash: state.remote_hash,
    recorded_hash: state.recorded_hash
  }));
}

export function getDiffRows(manifest: ServerManifest): StatusRow[] {
  return getStatusRows(manifest).filter((row) => row.direction !== 'skip');
}

export function applyResolution(
  manifest: ServerManifest,
  skill: string,
  take: 'local' | 'remote',
  updatedAt: string
): ServerManifest {
  const current = manifest.skills[skill];

  if (!current) {
    throw new Error(`Skill not found: ${skill}`);
  }

  const reconciled = reconcileManifest(manifest);
  const resolvedCurrent = reconciled.skills[skill];

  if (resolvedCurrent.direction !== 'conflict') {
    throw new Error(`Skill is not in conflict: ${skill}`);
  }

  const nextRecordedHash = take === 'local' ? resolvedCurrent.remote_hash : resolvedCurrent.local_hash;

  return reconcileManifest({
    ...reconciled,
    updated_at: updatedAt,
    skills: {
      ...reconciled.skills,
      [skill]: {
        ...resolvedCurrent,
        recorded_hash: nextRecordedHash
      }
    }
  });
}
