import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('sync timeout CLI help', () => {
  it('push command has --timeout option', () => {
    const program = createProgram('/tmp');
    const pushCmd = program.commands.find(c => c.name() === 'push');
    const options = pushCmd?.options.map(o => o.long);

    expect(options).toContain('--timeout');
  });

  it('pull command has --timeout option', () => {
    const program = createProgram('/tmp');
    const pullCmd = program.commands.find(c => c.name() === 'pull');
    const options = pullCmd?.options.map(o => o.long);

    expect(options).toContain('--timeout');
  });

  it('sync command has --timeout option', () => {
    const program = createProgram('/tmp');
    const syncCmd = program.commands.find(c => c.name() === 'sync');
    const options = syncCmd?.options.map(o => o.long);

    expect(options).toContain('--timeout');
  });
});
