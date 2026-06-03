import { describe, expect, it } from 'vitest';

import { formatProbeLines, formatServerListLines, formatServerShowLines } from '../../src/core/server.js';

describe('server helpers', () => {
  it('formats server list lines in sorted order', () => {
    expect(formatServerListLines(['beta', 'alpha'])).toEqual(['alpha', 'beta']);
  });

  it('formats one receiver backup summary', () => {
    expect(
      formatServerShowLines({
        version: 1,
        server: 'alpha',
        updated_at: '2026-06-03T09:01:00.000Z',
        remote_agents: {
          claude: '/home/deploy/.claude/skills'
        },
        links: {
          welcome: ['claude'],
          archived: []
        }
      })
    ).toEqual([
      'version\t1',
      'server\talpha',
      'updated_at\t2026-06-03T09:01:00.000Z',
      'remote_agent\tclaude\t/home/deploy/.claude/skills',
      'link\tarchived\t',
      'link\twelcome\tclaude'
    ]);
  });

  it('formats probe results as tab-separated status rows', () => {
    expect(
      formatProbeLines([
        { check: 'transport', ok: true, detail: 'ssh ok' },
        { check: 'receiver', ok: true, detail: 'receiver ok' },
        { check: 'remote_agent:claude', ok: false, detail: 'missing: /srv/skills' }
      ])
    ).toEqual([
      'transport\tok\tssh ok',
      'receiver\tok\treceiver ok',
      'remote_agent:claude\tfail\tmissing: /srv/skills'
    ]);
  });
});
