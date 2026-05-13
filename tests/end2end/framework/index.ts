// tests/end2end/framework/index.ts

// Core
export { E2EGuardError, assertPathSafe, isInAllowedTempDir, getProtectedPaths } from './guard.js';
export { TEMP_PREFIX, cleanupStaleTempDirs, createManagedTempDir, removeTempDir } from './cleanup.js';
export { execCommand, runSyncskill, isVerbose, getProjectRoot, type RunResult, type RunOptions } from './runner.js';
export { E2EContext } from './context.js';
export { E2EScenario } from './scenario.js';
export { e2eTest, type E2ETestOptions } from './e2e-test.js';

// Fixtures
export * from './fixtures/index.js';
