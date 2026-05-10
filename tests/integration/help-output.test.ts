import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('help output', () => {
  it('describes the shipped commands in install-facing language', () => {
    const help = createProgram('/tmp').helpInformation();

    expect(help).toContain('Multi-device AI Agent Skill sync tool');
    expect(help).toContain('init');
    expect(help).toContain('server');
    expect(help).toContain('source');
    expect(help).toContain('push');
    expect(help).toContain('sync');
    expect(help).toContain('link');
    expect(help).toContain('unlink');
    expect(help).toContain('remote');
  });
});
