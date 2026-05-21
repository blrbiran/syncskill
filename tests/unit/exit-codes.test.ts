// tests/unit/exit-codes.test.ts
import { describe, it, expect } from 'vitest';
import { ExitCode, errorCodeToExitCode } from '../../src/cli/exit-codes.js';

describe('exit-codes', () => {
  it('defines all required exit codes', () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.USAGE_ERROR).toBe(2);
    expect(ExitCode.CONFIG_ERROR).toBe(3);
    expect(ExitCode.NEEDS_INPUT).toBe(4);
    expect(ExitCode.NETWORK_ERROR).toBe(5);
    expect(ExitCode.DIRTY_SKIP).toBe(6);
    expect(ExitCode.CONFLICT_UNRESOLVED).toBe(7);
    expect(ExitCode.REMOTE_INCONSISTENT).toBe(8);
  });

  describe('errorCodeToExitCode', () => {
    it('maps E_NEEDS_INPUT to NEEDS_INPUT', () => {
      expect(errorCodeToExitCode('E_NEEDS_INPUT')).toBe(ExitCode.NEEDS_INPUT);
    });

    it('maps E_NETWORK to NETWORK_ERROR', () => {
      expect(errorCodeToExitCode('E_NETWORK')).toBe(ExitCode.NETWORK_ERROR);
    });

    it('maps E_TIMEOUT to NETWORK_ERROR', () => {
      expect(errorCodeToExitCode('E_TIMEOUT')).toBe(ExitCode.NETWORK_ERROR);
    });

    it('maps E_CONFLICT to CONFLICT_UNRESOLVED', () => {
      expect(errorCodeToExitCode('E_CONFLICT')).toBe(ExitCode.CONFLICT_UNRESOLVED);
    });

    it('maps E_SOURCE_DIRTY to DIRTY_SKIP', () => {
      expect(errorCodeToExitCode('E_SOURCE_DIRTY')).toBe(ExitCode.DIRTY_SKIP);
    });

    it('maps E_USAGE_* prefix to USAGE_ERROR', () => {
      expect(errorCodeToExitCode('E_USAGE_INVALID')).toBe(ExitCode.USAGE_ERROR);
      expect(errorCodeToExitCode('E_USAGE_MISSING_ARG')).toBe(ExitCode.USAGE_ERROR);
    });

    it('maps E_SKILL_NOT_FOUND to USAGE_ERROR', () => {
      expect(errorCodeToExitCode('E_SKILL_NOT_FOUND')).toBe(ExitCode.USAGE_ERROR);
    });

    it('maps E_REGISTRY_CORRUPT to CONFIG_ERROR', () => {
      expect(errorCodeToExitCode('E_REGISTRY_CORRUPT')).toBe(ExitCode.CONFIG_ERROR);
    });

    it('maps E_RECEIVER_DEPLOY to REMOTE_INCONSISTENT', () => {
      expect(errorCodeToExitCode('E_RECEIVER_DEPLOY')).toBe(ExitCode.REMOTE_INCONSISTENT);
    });

    it('maps unknown codes to GENERAL_ERROR', () => {
      expect(errorCodeToExitCode('E_UNKNOWN')).toBe(ExitCode.GENERAL_ERROR);
      expect(errorCodeToExitCode('SOMETHING_ELSE')).toBe(ExitCode.GENERAL_ERROR);
    });
  });
});
