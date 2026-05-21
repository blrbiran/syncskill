import { describe, it, expect, vi } from 'vitest';
import { createExecutor } from '../../src/cli/executor.js';
import { createPlan, addAction } from '../../src/cli/plan.js';

describe('cli/executor', () => {
  it('executes handlers in order with default context', async () => {
    const calls: string[] = [];
    const handler = vi.fn(async (action, resolutions, context) => {
      calls.push(action.op);
      expect(resolutions).toEqual({ skill: { name: 'demo' } });
      expect(context.dryRun).toBe(false);
      expect(context.json).toBe(false);
      expect(typeof context.homeDir).toBe('string');
    });

    const executor = createExecutor({
      clone: handler,
      link: handler,
    });

    const plan = addAction(addAction(createPlan('install'), { op: 'clone' }), { op: 'link' });

    await executor.execute(plan, { skill: { name: 'demo' } });

    expect(calls).toEqual(['clone', 'link']);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('applies context overrides', async () => {
    const handler = vi.fn(async (_action, _resolutions, context) => {
      expect(context).toEqual({
        homeDir: '/tmp/home',
        dryRun: true,
        json: true,
      });
    });

    const executor = createExecutor({ clone: handler });
    const plan = addAction(createPlan('install'), { op: 'clone' });

    await executor.execute(plan, {}, {
      homeDir: '/tmp/home',
      dryRun: true,
      json: true,
    });
  });

  it('throws on unknown action op', async () => {
    const executor = createExecutor({});
    const plan = addAction(createPlan('install'), { op: 'unknown' });

    await expect(executor.execute(plan, {})).rejects.toThrow('Unknown action op: unknown');
  });
});
