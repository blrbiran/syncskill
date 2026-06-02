import { describe, it, expect } from 'vitest';
import { createPlan, addAction, addUnresolved, serializePlan, parsePlan } from '../../src/cli/plan.js';

describe('cli/plan', () => {
  it('creates empty plan', () => {
    const plan = createPlan('install');
    expect(plan.version).toBe(1);
    expect(plan.command).toBe('install');
    expect(plan.actions).toEqual([]);
  });

  it('adds action with stable id', () => {
    const plan = createPlan('install');
    const updated = addAction(plan, { op: 'clone', url: 'https://...' });
    expect(updated.actions).toHaveLength(1);
    expect(updated.actions[0].id).toBe('a1');
  });

  it('serializes and parses plan', () => {
    const plan = createPlan('test');
    const json = serializePlan(plan);
    const parsed = parsePlan(json);
    expect(parsed.command).toBe('test');
  });

  it('adds unresolved item with default resolve phase', () => {
    const plan = createPlan('install');
    const updated = addUnresolved(plan, { kind: 'skill', name: 'demo' });
    expect(updated.unresolved).toHaveLength(1);
    expect(updated.unresolved[0].resolve_phase).toBe('plan');
  });

  it('normalizes missing ids and resolve phases when parsing', () => {
    const parsed = parsePlan(JSON.stringify({
      version: 1,
      command: 'install',
      generated_at: '2026-06-02T00:00:00.000Z',
      actions: [{ op: 'clone' }, { id: 'custom', op: 'link' }],
      unresolved: [{ kind: 'skill-selection' }, { kind: 'skill-selection', resolve_phase: 'execute' }],
      warnings: []
    }));

    expect(parsed.actions[0].id).toBe('a1');
    expect(parsed.actions[1].id).toBe('custom');
    expect(parsed.unresolved[0].resolve_phase).toBe('plan');
    expect(parsed.unresolved[1].resolve_phase).toBe('execute');
  });
});
