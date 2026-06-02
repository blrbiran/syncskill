import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { withPlanExecute } from '../../src/cli/plan-execute.js';

describe('cli/plan-execute', () => {
  it('builds and executes plan in normal mode', async () => {
    const buildPlan = vi.fn().mockResolvedValue({
      version: 1,
      command: 'test',
      generated_at: new Date().toISOString(),
      actions: [{ op: 'test-action' }],
      unresolved: [],
      warnings: []
    });
    const executePlan = vi.fn().mockResolvedValue(undefined);

    await withPlanExecute({
      buildPlan,
      executePlan,
      options: {}
    });

    expect(buildPlan).toHaveBeenCalled();
    expect(executePlan).toHaveBeenCalled();
  });

  it('returns plan without executing in plan mode', async () => {
    const buildPlan = vi.fn().mockResolvedValue({
      version: 1,
      command: 'test',
      generated_at: new Date().toISOString(),
      actions: [],
      unresolved: [],
      warnings: []
    });
    const executePlan = vi.fn();

    const result = await withPlanExecute({
      buildPlan,
      executePlan,
      options: { plan: true }
    });

    expect(buildPlan).toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
    expect(result.planOnly).toBe(true);
  });

  it('loads plan from stdin when apply path is dash', async () => {
    const stdin = process.stdin;
    const stream = Readable.from([
      JSON.stringify({
        version: 1,
        command: 'test',
        generated_at: '2026-06-02T00:00:00.000Z',
        actions: [{ op: 'clone' }],
        unresolved: [],
        warnings: []
      })
    ]);
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });

    const buildPlan = vi.fn();
    const executePlan = vi.fn().mockResolvedValue(undefined);

    try {
      await withPlanExecute({
        buildPlan,
        executePlan,
        options: { apply: '-' }
      });
    } finally {
      Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    }

    expect(buildPlan).not.toHaveBeenCalled();
    expect(executePlan).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [expect.objectContaining({ op: 'clone', id: 'a1' })] }),
      {}
    );
  });
});
