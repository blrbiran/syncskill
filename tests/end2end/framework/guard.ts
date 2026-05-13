// tests/end2end/framework/guard.ts
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Error thrown when E2E test attempts to access protected paths.
 */
export class E2EGuardError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly reason: string
  ) {
    super(
      `E2E Guard: Attempted to access protected path.\n` +
        `  Path: ${attemptedPath}\n` +
        `  Reason: ${reason}\n` +
        `  This is a bug in the E2E test framework or test case.`
    );
    this.name = 'E2EGuardError';
  }
}

const REAL_HOME = homedir();

/**
 * Paths that E2E tests must NEVER touch.
 */
const PROTECTED_PATHS = [
  REAL_HOME,
  `${REAL_HOME}/.syncskill`,
  `${REAL_HOME}/.claude`,
  `${REAL_HOME}/.agents`,
  `${REAL_HOME}/.cursor`,
  `${REAL_HOME}/.windsurf`,
  `${REAL_HOME}/.codex`,
  `${REAL_HOME}/.gemini`,
  `${REAL_HOME}/.kiro`,
  `${REAL_HOME}/.augment`,
  `${REAL_HOME}/.config/agents`,
  `${REAL_HOME}/.cline`,
  `${REAL_HOME}/.config/opencode`,
  `${REAL_HOME}/.qwen`,
  `${REAL_HOME}/.openclaw`,
  `${REAL_HOME}/.hermes`,
  `${REAL_HOME}/.qoder`,
  `${REAL_HOME}/.aone_copilot`,
];

/**
 * Check if a path is safe to access (not in protected paths).
 * Throws E2EGuardError if the path is protected.
 */
export function assertPathSafe(path: string): void {
  const resolved = resolve(path);

  for (const protected_ of PROTECTED_PATHS) {
    if (resolved === protected_ || resolved.startsWith(protected_ + '/')) {
      throw new E2EGuardError(resolved, `Path is within protected directory: ${protected_}`);
    }
  }
}

/**
 * Check if a path is within an allowed temp directory.
 */
export function isInAllowedTempDir(path: string, allowedTempDir: string): boolean {
  const resolved = resolve(path);
  const allowedResolved = resolve(allowedTempDir);
  return resolved === allowedResolved || resolved.startsWith(allowedResolved + '/');
}

/**
 * Get the list of protected paths (for diagnostics).
 */
export function getProtectedPaths(): readonly string[] {
  return PROTECTED_PATHS;
}
