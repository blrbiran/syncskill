import { describe, expect, it } from 'vitest';

import {
  type DiagnosticItem,
  type DiagnosticReport,
  DiagnosticCode
} from '../../src/config-doctor.js';

describe('DiagnosticCode', () => {
  it('exports all expected diagnostic codes', () => {
    expect(DiagnosticCode.NO_VALID_AGENTS).toBe('NO_VALID_AGENTS');
    expect(DiagnosticCode.AGENT_PATH_INVALID).toBe('AGENT_PATH_INVALID');
    expect(DiagnosticCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
    expect(DiagnosticCode.AGENT_NOT_CONFIGURED).toBe('AGENT_NOT_CONFIGURED');
    expect(DiagnosticCode.SOURCE_PATH_INVALID).toBe('SOURCE_PATH_INVALID');
  });
});
