import { describe, expect, it } from 'vitest';

import { isSkillDirty } from '../../src/source/dirty.js';

describe('source/dirty', () => {
  it('returns clean when no baseline hash exists', () => {
    expect(isSkillDirty('abc123', null)).toEqual({
      dirty: false,
      currentHash: 'abc123',
      baselineHash: null
    });
  });

  it('returns clean when hashes match', () => {
    expect(isSkillDirty('abc123', 'abc123')).toEqual({
      dirty: false,
      currentHash: 'abc123',
      baselineHash: 'abc123'
    });
  });

  it('returns dirty when hashes differ', () => {
    expect(isSkillDirty('abc123', 'def456')).toEqual({
      dirty: true,
      currentHash: 'abc123',
      baselineHash: 'def456'
    });
  });
});
