import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadUpdateHistory,
  saveUpdateHistory,
  recordGitOverwrite,
  recordHttpOverwrite,
  clearSourceHistory,
  getSourceHistory,
  type UpdateHistory,
  type GitUpdateRecord,
  type HttpUpdateRecord
} from '../../src/core/update-history.js';
import { getSyncPaths } from '../../src/config/config.js';

describe('update-history', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = join(tmpdir(), `update-history-test-${Date.now()}`);
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns empty history when file does not exist', async () => {
    const history = await loadUpdateHistory(homeDir);
    expect(history).toEqual({});
  });

  it('saves and loads update history', async () => {
    const history: UpdateHistory = {
      'git-source': {
        type: 'git',
        before_commit: 'abc123',
        after_commit: 'def456',
        stash_commit: '789abc',
        timestamp: '2026-05-15T12:00:00.000Z'
      },
      'http-source': {
        type: 'http',
        backup_path: '/tmp/backups/http-source',
        dirty_skills: ['skill-a', 'skill-b'],
        timestamp: '2026-05-15T12:05:00.000Z'
      }
    };

    await saveUpdateHistory(homeDir, history);

    expect(await loadUpdateHistory(homeDir)).toEqual(history);
  });

  it('creates update-history.json inside ~/.syncskill', async () => {
    const history: UpdateHistory = {
      source: {
        type: 'http',
        backup_path: '/tmp/backups/source',
        dirty_skills: ['skill-a'],
        timestamp: '2026-05-15T12:10:00.000Z'
      }
    };

    await saveUpdateHistory(homeDir, history);

    const historyPath = join(getSyncPaths(homeDir).syncDir, 'update-history.json');
    const content = await readFile(historyPath, 'utf8');
    expect(JSON.parse(content)).toEqual(history);
  });

  it('records a git overwrite for a source', async () => {
    const record: GitUpdateRecord = {
      type: 'git',
      before_commit: 'abc123',
      after_commit: 'def456',
      stash_commit: '789abc',
      timestamp: '2026-05-15T12:15:00.000Z'
    };

    await recordGitOverwrite(homeDir, 'git-source', record);

    const history = await loadUpdateHistory(homeDir);
    expect(history).toEqual({ 'git-source': record });
  });

  it('records an http overwrite for a source', async () => {
    const record: HttpUpdateRecord = {
      type: 'http',
      backup_path: '/tmp/backups/http-source',
      dirty_skills: ['skill-a', 'skill-b'],
      timestamp: '2026-05-15T12:20:00.000Z'
    };

    await recordHttpOverwrite(homeDir, 'http-source', record);

    const history = await loadUpdateHistory(homeDir);
    expect(history).toEqual({ 'http-source': record });
  });

  it('replaces previous history for the same source', async () => {
    const firstRecord: GitUpdateRecord = {
      type: 'git',
      before_commit: 'old-before',
      after_commit: 'old-after',
      stash_commit: 'old-stash',
      timestamp: '2026-05-15T12:25:00.000Z'
    };
    const secondRecord: HttpUpdateRecord = {
      type: 'http',
      backup_path: '/tmp/backups/replaced-source',
      dirty_skills: ['skill-new'],
      timestamp: '2026-05-15T12:30:00.000Z'
    };

    await recordGitOverwrite(homeDir, 'replaced-source', firstRecord);
    await recordHttpOverwrite(homeDir, 'replaced-source', secondRecord);

    expect(await getSourceHistory(homeDir, 'replaced-source')).toEqual(secondRecord);
  });

  it('clears history for a source only', async () => {
    await recordGitOverwrite(homeDir, 'git-source', {
      type: 'git',
      before_commit: 'abc123',
      after_commit: 'def456',
      stash_commit: '789abc',
      timestamp: '2026-05-15T12:35:00.000Z'
    });
    await recordHttpOverwrite(homeDir, 'http-source', {
      type: 'http',
      backup_path: '/tmp/backups/http-source',
      dirty_skills: ['skill-a'],
      timestamp: '2026-05-15T12:40:00.000Z'
    });

    await clearSourceHistory(homeDir, 'git-source');

    expect(await getSourceHistory(homeDir, 'git-source')).toBeNull();
    expect(await getSourceHistory(homeDir, 'http-source')).toEqual({
      type: 'http',
      backup_path: '/tmp/backups/http-source',
      dirty_skills: ['skill-a'],
      timestamp: '2026-05-15T12:40:00.000Z'
    });
  });

  it('returns null when source history does not exist', async () => {
    expect(await getSourceHistory(homeDir, 'missing-source')).toBeNull();
  });

  it('does not fail when clearing missing source history', async () => {
    await clearSourceHistory(homeDir, 'missing-source');
    expect(await loadUpdateHistory(homeDir)).toEqual({});
  });
});
