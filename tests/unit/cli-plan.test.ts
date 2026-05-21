import { describe, it, expect } from 'vitest';
import { createPlan, addAction, addUnresolved, serializePlan, parsePlan } from '../../src/cli/plan.js';

describe('cli/plan', () => {
  it('creates empty plan', () => {
    const plan = createPlan('install');
    expect(plan.version).toBe(1);
    expect(plan.command).toBe('install');
    expect(plan.actions).toEqual([]);
  });

  it('adds action', () => {
    const plan = createPlan('install');
    const updated = addAction(plan, { op: 'clone', url: 'https://...' });
    expect(updated.actions).toHaveLength(1);
  });

  it('serializes and parses plan', () => {
    const plan = createPlan('test');
    const json = serializePlan(plan);
    const parsed = parsePlan(json);
    expect(parsed.command).toBe('test');
  });

  it('adds unresolved item', () => {
    const plan = createPlan('install');
    const updated = addUnresolved(plan, { kind: 'skill', name: 'demo' });
    expect(updated.unresolved).toHaveLength(1);
  });
});
