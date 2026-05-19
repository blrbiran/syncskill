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

  it('includes dashboard-oriented wording for the root command', () => {
    const help = createProgram('/tmp').helpInformation();

    expect(help).toContain('No args: show local dashboard summary');
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

  it('link command does not expose a --list flag', () => {
    const program = createProgram('/tmp');
    const linkCmd = program.commands.find(c => c.name() === 'link');
    const options = linkCmd?.options.map(o => o.long);

    expect(options).not.toContain('--list');
  });

  it('describes update-flow commands and options clearly', () => {
    const program = createProgram('/tmp');
    const sourceCmd = program.commands.find(c => c.name() === 'source');
    const sourceUpdateCmd = sourceCmd?.commands.find(c => c.name() === 'update');
    const sourceRestoreCmd = sourceCmd?.commands.find(c => c.name() === 'restore');
    const pushCmd = program.commands.find(c => c.name() === 'push');
    const pullCmd = program.commands.find(c => c.name() === 'pull');
    const syncCmd = program.commands.find(c => c.name() === 'sync');

    expect(sourceCmd?.description()).toBe('Manage external skill sources and source recovery');
    expect(sourceUpdateCmd?.description()).toBe('Update one source or all configured sources, with preview support for dirty-source handling');
    expect(sourceUpdateCmd?.options.find(o => o.long === '--dry-run')?.description).toBe('Preview update actions, including dirty-source decisions, without making changes');
    expect(sourceRestoreCmd?.description()).toBe('Restore a source from the most recent force-update backup');
    expect(pushCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
    expect(pullCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
    expect(syncCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
  });
});
