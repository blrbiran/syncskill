import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('CLI introspection', () => {
  it('program has global flags', () => {
    const program = createProgram('/tmp/test');
    const optionFlags = program.options.map(o => o.flags);

    expect(optionFlags).toContain('--json');
    expect(optionFlags).toContain('--no-interactive');
    expect(optionFlags).toContain('--sync-dir <path>');
    expect(optionFlags).toContain('--config <path>');
  });

  it('program has expected commands', () => {
    const program = createProgram('/tmp/test');
    const commandNames = program.commands.map(c => c.name());

    expect(commandNames).toContain('init');
    expect(commandNames).toContain('install');
    expect(commandNames).toContain('link');
    expect(commandNames).toContain('source');
    expect(commandNames).toContain('push');
    expect(commandNames).toContain('pull');
    expect(commandNames).toContain('sync');
    expect(commandNames).toContain('restore');
  });

  it('returns text help by default', () => {
    const program = createProgram('/tmp/test');
    const helpInfo = program.helpInformation();

    expect(typeof helpInfo).toBe('string');
    expect(helpInfo).toContain('syncskill');
  });

  it('builds structured introspection data from the program model', () => {
    const program = createProgram('/tmp/test');
    program.opts = () => ({ json: true });
    const helpInfo = program.helpInformation();
    const data = JSON.parse(helpInfo);

    expect(data.name).toBe('syncskill');
    expect(data.globalOptions.map((option: { flags: string }) => option.flags)).toContain('--json');
    expect(data.globalOptions.map((option: { flags: string }) => option.flags)).toContain('--apply <path|->');
    expect(data.commands.map((command: { name: string }) => command.name)).toContain('install');

    const linkCommand = data.commands.find((command: { name: string }) => command.name === 'link');
    expect(linkCommand.audience).toBe('both');

    const linkBuild = linkCommand.commands.find((command: { name: string }) => command.name === 'build');
    expect(linkBuild.audience).toBe('agent');
    expect(linkBuild.prefer).toBeNull();

    const linkEdit = linkCommand.commands.find((command: { name: string }) => command.name === 'edit');
    expect(linkEdit.audience).toBe('human');
    expect(linkEdit.prefer).toBe('link set');
  });
});
