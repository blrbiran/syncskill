import { describe, expect, it } from 'vitest';
import { createDefaultConfig, validateConfig, PROFILE_NAME_PATTERN } from '../../src/config/config.js';

const base = { version: 1, agents: {}, links: {} };

describe('config profiles', () => {
  it('keeps profiles through validation, sorted and de-duplicated', () => {
    const config = validateConfig({ ...base, profiles: { review: ['b', 'a', 'b'], empty: [] } });
    expect(config.profiles).toEqual({ review: ['a', 'b'], empty: [] });
  });

  it('drops non-string members and non-array values', () => {
    const config = validateConfig({ ...base, profiles: { mixed: ['a', 3, null], broken: 'x' } });
    expect(config.profiles).toEqual({ mixed: ['a'], broken: [] });
  });

  it('defaults to an empty object when missing or not an object', () => {
    expect(validateConfig(base).profiles).toEqual({});
    expect(validateConfig({ ...base, profiles: ['x'] }).profiles).toEqual({});
    expect(createDefaultConfig().profiles).toEqual({});
  });

  it('names follow the safe skill name rule', () => {
    expect(PROFILE_NAME_PATTERN.test('review_1-a')).toBe(true);
    expect(PROFILE_NAME_PATTERN.test('.hidden')).toBe(false);
    expect(PROFILE_NAME_PATTERN.test('a/b')).toBe(false);
  });
});
