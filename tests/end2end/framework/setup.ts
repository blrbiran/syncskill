// tests/end2end/framework/setup.ts
import { afterEach, beforeAll } from 'vitest';
import { cleanupStaleTempDirs } from './cleanup.js';
import type { E2EContext } from './context.js';

// Global setup: cleanup stale temp directories from previous runs
beforeAll(async () => {
  await cleanupStaleTempDirs();
});

// Auto-dump diagnostics on test failure
afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    const e2eCtx = (context.task as unknown as { __e2eContext?: E2EContext }).__e2eContext;
    if (e2eCtx) {
      e2eCtx.dumpDiagnostics();
    }
  }
});
