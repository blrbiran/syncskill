import { describe, expect, it } from 'vitest';
import { normalizeSourceState } from '../../src/source.js';

const sha = 'a'.repeat(40);

describe('source state resolved_commit', () => {
  it('keeps a 40-hex lowercase commit', () => {
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: sha }).resolved_commit).toBe(sha);
  });

  it('reads a missing or malformed commit as null', () => {
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't' }).resolved_commit).toBeNull();
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: 'A'.repeat(40) }).resolved_commit).toBeNull();
    expect(normalizeSourceState({ materialized_skills: [], updated_at: 't', resolved_commit: 'abc' }).resolved_commit).toBeNull();
  });
});
