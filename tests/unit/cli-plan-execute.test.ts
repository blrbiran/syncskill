import { describe, it, expect, vi } from 'vitest';
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
});
