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

  it('source list has ls alias', () => {
    const program = createProgram('/tmp');
    const sourceCmd = program.commands.find(c => c.name() === 'source');
    const listCmd = sourceCmd?.commands.find(c => c.name() === 'list');

    expect(listCmd?.aliases()).toContain('ls');
  });

  it('server list has ls alias', () => {
    const program = createProgram('/tmp');
    const serverCmd = program.commands.find(c => c.name() === 'server');
    const listCmd = serverCmd?.commands.find(c => c.name() === 'list');

    expect(listCmd?.aliases()).toContain('ls');
  });

  it('scan has --dry-run option', () => {
    const program = createProgram('/tmp');
    const scanCmd = program.commands.find(c => c.name() === 'scan');
    const options = scanCmd?.options.map(o => o.long);

    expect(options).toContain('--dry-run');
  });
});
