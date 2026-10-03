import { describe, expect, it } from 'vitest';
import { buildLock, normalizeSkillList } from '../../src/inject.js';

describe('inject lock assembly', () => {
  it('sorts and de-duplicates a requested skill list', () => {
    expect(normalizeSkillList(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('builds a v1 lock sorted by skill name, keeping null sources and an omitted branch', () => {
    const lock = buildLock(null, [
      { name: 'z', source: { name: 'src', type: 'local', url: '/x' }, resolved_commit: null, content_md5: 'm2' },
      { name: 'a', source: null, resolved_commit: null, content_md5: 'm1' }
    ], '2026-10-03T00:00:00.000Z');
    expect(lock).toEqual({
      schema: 'syncskill-lock-v1',
      created_at: '2026-10-03T00:00:00.000Z',
      profile: null,
      skills: [
        { name: 'a', source: null, resolved_commit: null, content_md5: 'm1' },
        { name: 'z', source: { name: 'src', type: 'local', url: '/x' }, resolved_commit: null, content_md5: 'm2' }
      ]
    });
    expect('branch' in lock.skills[1]!.source!).toBe(false);
  });
});
