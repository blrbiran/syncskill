import { describe, expect, it } from 'vitest';

import { directionOf } from '../../src/core/sync_engine.js';
import type { SyncSkillConfig } from '../../src/config/types.js';

/**
 * Tester #490: `servers.<name>.directions` used to be read by nothing; a skill pinned `pull` was pushed like any other,
 * a silent reversal of the direction the config asked for. Absent directions keep the old behaviour (both ways).
 */
const config = (directions: unknown): SyncSkillConfig => ({
  version: 1, conflict_resolution: 'manual', agents: {}, links: {}, profiles: {},
  servers: { delta: { host: 'h', remote_agents: {}, ...(directions === undefined ? {} : { directions }) } },
  sources: {}, private_agents: []
});

describe('server directions (#490)', () => {
  it('defaults to both, a declared default applies to every skill, and a skill overrides it', () => {
    // mutation: treat absent directions as push-only (or ignore the section) -> the first or second assertion is red
    expect(directionOf(config(undefined), 'delta')('welcome')).toBe('both');
    const pinned = directionOf(config({ default: 'pull', welcome: 'push' }), 'delta');
    expect(pinned('welcome')).toBe('push');
    expect(pinned('other')).toBe('pull');
  });
});