import { readFile } from 'node:fs/promises';
import type { Plan } from './plan.js';
import { parsePlan } from './plan.js';
import type { Resolutions } from './resolution.js';
import { loadResolutions } from './resolution.js';

async function readTextInput(path: string): Promise<string> {
  if (path !== '-') {
    return readFile(path, 'utf8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type PlanBuilder = () => Promise<Plan>;
export type PlanExecutor = (plan: Plan, resolutions: Resolutions) => Promise<void>;
export type ResolutionCollector = (plan: Plan) => Promise<Resolutions>;

export interface PlanExecuteOptions {
  plan?: boolean;
  apply?: string;
  resolutions?: string;
  yes?: boolean;
}

export interface PlanExecuteParams {
  buildPlan: PlanBuilder;
  executePlan: PlanExecutor;
  collectResolutions?: ResolutionCollector;
  options: PlanExecuteOptions;
}

export interface PlanExecuteResult {
  planOnly: boolean;
  plan?: Plan;
}

export async function withPlanExecute(params: PlanExecuteParams): Promise<PlanExecuteResult> {
  const { buildPlan, executePlan, collectResolutions, options } = params;

  let plan: Plan;

  if (options.apply) {
    const content = await readTextInput(options.apply);
    plan = parsePlan(content);
  } else {
    plan = await buildPlan();
  }

  if (options.plan) {
    return { planOnly: true, plan };
  }

  let resolutions: Resolutions = {};

  if (options.resolutions) {
    resolutions = await loadResolutions(options.resolutions);
  } else if (collectResolutions && plan.unresolved.length > 0 && !options.yes) {
    resolutions = await collectResolutions(plan);
  }

  await executePlan(plan, resolutions);

  return { planOnly: false, plan };
}
