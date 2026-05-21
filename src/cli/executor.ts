import type { Plan, PlanAction } from './plan.js';
import type { Resolutions } from './resolution.js';

export type ActionHandler = (
  action: PlanAction,
  resolutions: Resolutions,
  context: ExecutionContext
) => Promise<void>;

export interface ExecutionContext {
  homeDir: string;
  dryRun: boolean;
  json: boolean;
}

export interface Executor {
  execute(plan: Plan, resolutions: Resolutions, context?: Partial<ExecutionContext>): Promise<void>;
}

export function createExecutor(handlers: Record<string, ActionHandler>): Executor {
  return {
    async execute(plan, resolutions, contextOverrides = {}) {
      const context: ExecutionContext = {
        homeDir: process.env.HOME ?? '',
        dryRun: false,
        json: false,
        ...contextOverrides
      };

      for (const action of plan.actions) {
        const handler = handlers[action.op];
        if (!handler) {
          throw new Error(`Unknown action op: ${action.op}`);
        }
        await handler(action, resolutions, context);
      }
    }
  };
}
