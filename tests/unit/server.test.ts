import { describe, expect, it } from 'vitest';

import { formatProbeLines, formatServerListLines, formatServerShowLines } from '../../src/server.js';

describe('server helpers', () => {
  it('formats server list lines in sorted order', () => {
    expect(formatServerListLines(['beta', 'alpha'])).toEqual(['alpha', 'beta']);
  });

  it('formats one server summary with configured connection details', () => {
    expect(
      formatServerShowLines({
        name: 'alpha',
        host: 'alpha.example.com',
        user: 'deploy',
        port: 2222,
        identity_file: '/Users/demo/.ssh/id_syncskill',
        remote_agents: {
          claude: '/home/deploy/.claude/skills'
        }
      })
    ).toEqual([
      'name\talpha',
      'host\talpha.example.com',
      'user\tdeploy',
      'port\t2222',
      'identity_file\t/Users/demo/.ssh/id_syncskill',
      'remote_agent\tclaude\t/home/deploy/.claude/skills'
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
