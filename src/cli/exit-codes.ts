// src/cli/exit-codes.ts

/**
 * Documented exit codes for syncskill CLI.
 * See spec §11.3 for semantics.
 */
export const ExitCode = {
  /** Command completed successfully */
  SUCCESS: 0,
  /** General runtime error (unclassified) */
  GENERAL_ERROR: 1,
  /** Usage error (unknown args, missing required params) */
  USAGE_ERROR: 2,
  /** Config error (doctor found errors, no --fix) */
  CONFIG_ERROR: 3,
  /** Needs input but can't get it (--no-interactive without -y) */
  NEEDS_INPUT: 4,
  /** Network/remote error (SSH, rsync, timeout) */
  NETWORK_ERROR: 5,
  /** Dirty/safety protection skipped operation */
  DIRTY_SKIP: 6,
  /** Conflict unresolved (sync plan has unresolved items) */
  CONFLICT_UNRESOLVED: 7,
  /** Remote inconsistent (receiver deploy failed, manifest corrupt) */
  REMOTE_INCONSISTENT: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Map error codes to exit codes.
 */
export function errorCodeToExitCode(errorCode: string): ExitCodeValue {
  if (errorCode.startsWith('E_USAGE') || errorCode === 'E_AGENT_NOT_CONFIGURED' ||
      errorCode === 'E_SKILL_NOT_FOUND' || errorCode === 'E_SOURCE_NOT_FOUND' ||
      errorCode === 'E_SERVER_NOT_FOUND' || errorCode === 'E_REMOTE_NOT_FOUND') {
    return ExitCode.USAGE_ERROR;
  }
  if (errorCode === 'E_NEEDS_INPUT') {
    return ExitCode.NEEDS_INPUT;
  }
  if (errorCode === 'E_NO_VALID_AGENTS' || errorCode === 'E_REGISTRY_CORRUPT' ||
      errorCode === 'E_CONFIG_NOT_FOUND' || errorCode === 'E_REMOTE_NOT_INITIALIZED' ||
      errorCode === 'E_BACKUP_NOT_FOUND') {
    return ExitCode.CONFIG_ERROR;
  }
  if (errorCode === 'E_NETWORK' || errorCode === 'E_TIMEOUT' || errorCode === 'E_TAKEOVER_FAILED') {
    return ExitCode.NETWORK_ERROR;
  }
  if (errorCode === 'E_SOURCE_DIRTY') {
    return ExitCode.DIRTY_SKIP;
  }
  if (errorCode === 'E_CONFLICT') {
    return ExitCode.CONFLICT_UNRESOLVED;
  }
  if (errorCode === 'E_RECEIVER_DEPLOY') {
    return ExitCode.REMOTE_INCONSISTENT;
  }
  return ExitCode.GENERAL_ERROR;
}
