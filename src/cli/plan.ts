export interface PlanAction {
  op: string;
  [key: string]: unknown;
}

export interface UnresolvedItem {
  kind: string;
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
  return { ...plan, actions: [...plan.actions, action] };
}

export function addUnresolved(plan: Plan, item: UnresolvedItem): Plan {
  return { ...plan, unresolved: [...plan.unresolved, item] };
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
  const parsed = JSON.parse(content);
  if (parsed.version !== 1) {
    throw new Error(`Unsupported plan version: ${parsed.version}`);
  }
  return parsed as Plan;
}
