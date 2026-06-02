export interface PlanAction {
  id?: string;
  op: string;
  [key: string]: unknown;
}

export interface UnresolvedItem {
  kind: string;
  resolve_phase?: 'plan' | 'execute';
  [key: string]: unknown;
}

export interface Plan {
  version: 1;
  command: string;
  generated_at: string;
  actions: PlanAction[];
  unresolved: UnresolvedItem[];
  warnings: string[];
}

function normalizeAction(action: PlanAction, index: number): PlanAction {
  return {
    ...action,
    id: typeof action.id === 'string' && action.id.length > 0 ? action.id : `a${index + 1}`
  };
}

function normalizeUnresolved(item: UnresolvedItem): UnresolvedItem {
  return {
    ...item,
    resolve_phase: item.resolve_phase === 'execute' ? 'execute' : 'plan'
  };
}

export function createPlan(command: string): Plan {
  return {
    version: 1,
    command,
    generated_at: new Date().toISOString(),
    actions: [],
    unresolved: [],
    warnings: []
  };
}

export function addAction(plan: Plan, action: PlanAction): Plan {
  return { ...plan, actions: [...plan.actions, normalizeAction(action, plan.actions.length)] };
}

export function addUnresolved(plan: Plan, item: UnresolvedItem): Plan {
  return { ...plan, unresolved: [...plan.unresolved, normalizeUnresolved(item)] };
}

export function addWarning(plan: Plan, warning: string): Plan {
  return { ...plan, warnings: [...plan.warnings, warning] };
}

export function hasUnresolved(plan: Plan): boolean {
  return plan.unresolved.length > 0;
}

export function serializePlan(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export function parsePlan(content: string): Plan {
  const parsed = JSON.parse(content) as Plan;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported plan version: ${parsed.version}`);
  }
  return {
    ...parsed,
    actions: parsed.actions.map((action, index) => normalizeAction(action, index)),
    unresolved: parsed.unresolved.map((item) => normalizeUnresolved(item))
  };
}
