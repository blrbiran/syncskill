import { describe, expect, it } from 'vitest';

import {
  applyResolution,
  classifySkillDelta,
  getDiffRows,
  getStatusRows,
  reconcileManifest
} from '../../src/core/conflict.js';
import { createEmptyManifest, type ServerManifest } from '../../src/core/manifest.js';

describe('classifySkillDelta', () => {
  it('classifies a local-only change since the recorded hash as push', () => {
    expect(classifySkillDelta('local', 'base', 'base')).toEqual({
      direction: 'push',
      status: 'local-changed'
    });
  });

  it('classifies a remote-only change since the recorded hash as pull', () => {
    expect(classifySkillDelta('base', 'remote', 'base')).toEqual({
      direction: 'pull',
      status: 'remote-changed'
    });
  });

  it('classifies divergent local and remote changes as conflict', () => {
    expect(classifySkillDelta('local', 'remote', 'base')).toEqual({
      direction: 'conflict',
      status: 'conflict'
    });
  });

  it('classifies matching local and remote hashes as skip in-sync', () => {
    expect(classifySkillDelta('same', 'same', 'base')).toEqual({
      direction: 'skip',
      status: 'in-sync'
    });
  });

  it('classifies a new local-only skill as push new when there is no recorded hash', () => {
    expect(classifySkillDelta('local', null, null)).toEqual({
      direction: 'push',
      status: 'new'
    });
  });

  it('classifies a new remote-only skill as pull new when there is no recorded hash', () => {
    expect(classifySkillDelta(null, 'remote', null)).toEqual({
      direction: 'pull',
      status: 'new'
    });
  });
});

describe('reconcileManifest', () => {
  it('sorts skills deterministically and recomputes state for every skill', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'dev',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        zebra: {
          local_hash: 'base',
          remote_hash: 'remote',
          recorded_hash: 'base',
          direction: 'skip',
          status: 'in-sync'
        },
        alpha: {
          local_hash: 'local',
          remote_hash: 'base',
          recorded_hash: 'base',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    };

    const reconciled = reconcileManifest(manifest);

    expect(Object.keys(reconciled.skills)).toEqual(['alpha', 'zebra']);
    expect(reconciled.skills.alpha.direction).toBe('push');
    expect(reconciled.skills.alpha.status).toBe('local-changed');
    expect(reconciled.skills.zebra.direction).toBe('pull');
    expect(reconciled.skills.zebra.status).toBe('remote-changed');
  });
});

describe('status and diff rows', () => {
  it('recomputes rows from unreconciled manifest input with stale direction and status fields', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'prod',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        gamma: {
          local_hash: null,
          remote_hash: 'remote',
          recorded_hash: null,
          direction: 'push',
          status: 'local-changed'
        },
        alpha: {
          local_hash: 'same',
          remote_hash: 'same',
          recorded_hash: 'base',
          direction: 'conflict',
          status: 'conflict'
        },
        beta: {
          local_hash: 'local',
          remote_hash: 'base',
          recorded_hash: 'base',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    };

    expect(getStatusRows(manifest)).toEqual([
      {
        skill: 'alpha',
        server: 'prod',
        direction: 'skip',
        status: 'in-sync',
        local_hash: 'same',
        remote_hash: 'same',
        recorded_hash: 'base'
      },
      {
        skill: 'beta',
        server: 'prod',
        direction: 'push',
        status: 'local-changed',
        local_hash: 'local',
        remote_hash: 'base',
        recorded_hash: 'base'
      },
      {
        skill: 'gamma',
        server: 'prod',
        direction: 'pull',
        status: 'new',
        local_hash: null,
        remote_hash: 'remote',
        recorded_hash: null
      }
    ]);

    expect(getDiffRows(manifest)).toEqual([
      {
        skill: 'beta',
        server: 'prod',
        direction: 'push',
        status: 'local-changed',
        local_hash: 'local',
        remote_hash: 'base',
        recorded_hash: 'base'
      },
      {
        skill: 'gamma',
        server: 'prod',
        direction: 'pull',
        status: 'new',
        local_hash: null,
        remote_hash: 'remote',
        recorded_hash: null
      }
    ]);
  });

  it('returns the same rows for already reconciled manifest input', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'prod',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        alpha: {
          local_hash: 'same',
          remote_hash: 'same',
          recorded_hash: 'base',
          direction: 'conflict',
          status: 'conflict'
        },
        beta: {
          local_hash: 'local',
          remote_hash: 'base',
          recorded_hash: 'base',
          direction: 'skip',
          status: 'in-sync'
        }
      }
    };

    const reconciled = reconcileManifest(manifest);

    expect(getStatusRows(reconciled)).toEqual([
      {
        skill: 'alpha',
        server: 'prod',
        direction: 'skip',
        status: 'in-sync',
        local_hash: 'same',
        remote_hash: 'same',
        recorded_hash: 'base'
      },
      {
        skill: 'beta',
        server: 'prod',
        direction: 'push',
        status: 'local-changed',
        local_hash: 'local',
        remote_hash: 'base',
        recorded_hash: 'base'
      }
    ]);

    expect(getDiffRows(reconciled)).toEqual([
      {
        skill: 'beta',
        server: 'prod',
        direction: 'push',
        status: 'local-changed',
        local_hash: 'local',
        remote_hash: 'base',
        recorded_hash: 'base'
      }
    ]);
  });
});

describe('applyResolution', () => {
  it('throws when the skill is missing', () => {
    const manifest = createEmptyManifest('dev', '2026-05-01T00:00:00.000Z');

    expect(() => applyResolution(manifest, 'missing', 'local', '2026-05-01T01:00:00.000Z')).toThrow(
      'Skill not found: missing'
    );
  });

  it('throws when the skill is not currently in conflict', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'dev',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local',
          remote_hash: 'base',
          recorded_hash: 'base',
          direction: 'push',
          status: 'local-changed'
        }
      }
    };

    expect(() => applyResolution(manifest, 'welcome', 'local', '2026-05-01T01:00:00.000Z')).toThrow(
      'Skill is not in conflict: welcome'
    );
  });

  it('taking local sets recorded_hash to remote_hash and results in push local-changed', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'dev',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local',
          remote_hash: 'remote',
          recorded_hash: 'base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    };

    const resolved = applyResolution(manifest, 'welcome', 'local', '2026-05-01T01:00:00.000Z');

    expect(resolved.updated_at).toBe('2026-05-01T01:00:00.000Z');
    expect(resolved.skills.welcome).toEqual({
      local_hash: 'local',
      remote_hash: 'remote',
      recorded_hash: 'remote',
      direction: 'push',
      status: 'local-changed'
    });
  });

  it('taking remote sets recorded_hash to local_hash and results in pull remote-changed', () => {
    const manifest: ServerManifest = {
      version: 1,
      server: 'dev',
      updated_at: '2026-05-01T00:00:00.000Z',
      skills: {
        welcome: {
          local_hash: 'local',
          remote_hash: 'remote',
          recorded_hash: 'base',
          direction: 'conflict',
          status: 'conflict'
        }
      }
    };

    const resolved = applyResolution(manifest, 'welcome', 'remote', '2026-05-01T01:00:00.000Z');

    expect(resolved.updated_at).toBe('2026-05-01T01:00:00.000Z');
    expect(resolved.skills.welcome).toEqual({
      local_hash: 'local',
      remote_hash: 'remote',
      recorded_hash: 'local',
      direction: 'pull',
      status: 'remote-changed'
    });
  });
});
