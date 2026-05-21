// tests/unit/cli-types.test.ts
import { describe, it, expect } from 'vitest';
import type { OutputEvent, ProgressEvent, ErrorEvent, ResultEvent, ChangeEvent } from '../../src/cli/types.js';

describe('cli/types', () => {
  it('event types are correctly defined', () => {
    // Type-level test - if this compiles, types are correct
    const progressEvent: OutputEvent = {
      type: 'progress',
      phase: 'refresh',
      message: 'Refreshing manifests'
    };

    const errorEvent: OutputEvent = {
      type: 'error',
      code: 'E_NETWORK',
      message: 'Connection failed'
    };

    const resultEvent: OutputEvent = {
      type: 'result',
      command: 'push',
      ok: true,
      summary: { pushed: 3, skipped: 0 }
    };

    expect(progressEvent.type).toBe('progress');
    expect(errorEvent.type).toBe('error');
    expect(resultEvent.type).toBe('result');
  });

  it('ChangeEvent supports all operations', () => {
    const ops: ChangeEvent['op'][] = ['add', 'modify', 'delete', 'link', 'unlink', 'push', 'pull', 'resolve', 'restore', 'stash', 'backup'];
    const entities: ChangeEvent['entity'][] = ['skill', 'source', 'agent', 'server', 'link', 'manifest', 'registry'];

    for (const op of ops) {
      for (const entity of entities) {
        const event: ChangeEvent = { type: 'change', op, entity, name: 'test' };
        expect(event.type).toBe('change');
      }
    }
  });

  it('ProgressEvent supports optional pct field', () => {
    const withPct: ProgressEvent = { type: 'progress', phase: 'sync', message: 'Syncing', pct: 50 };
    const withoutPct: ProgressEvent = { type: 'progress', phase: 'sync', message: 'Syncing' };

    expect(withPct.pct).toBe(50);
    expect(withoutPct.pct).toBeUndefined();
  });
});
