import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('CLI introspection', () => {
  it('program has expected visible global flags', () => {
    const program = createProgram('/tmp/test');
    const optionFlags = program.options.map(o => o.flags);

    expect(optionFlags).toContain('--json');
    expect(optionFlags).toContain('--no-interactive');
    expect(optionFlags).toContain('--sync-dir <path>');
    expect(optionFlags).toContain('--config <path>');
    expect(optionFlags).not.toContain('--strict');
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

    expect(data.version).toBeDefined();
    expect(data.global_flags.map((option: { name: string }) => option.name)).toContain('--json');
    expect(data.global_flags.map((option: { name: string }) => option.name)).toContain('--apply');

    const installCommand = data.commands.find((command: { name: string }) => command.name === 'install');
    expect(installCommand).toMatchObject({
      aliases: ['i'],
      audience: 'both',
      prefer: null,
      plan_schema: expect.any(Object),
      resolutions_schema: expect.any(Object),
      result_schema: expect.any(Object)
    });
    expect(installCommand.args).toEqual([{ name: 'url-or-path', required: false }]);
    expect(installCommand.flags.map((flag: { name: string }) => flag.name)).toContain('--name');

    const linkBuild = data.commands.find((command: { name: string }) => command.name === 'link build');
    expect(linkBuild).toMatchObject({
      audience: 'agent',
      prefer: null,
      plan_schema: null,
      resolutions_schema: null,
      result_schema: expect.any(Object)
    });

    const linkEdit = data.commands.find((command: { name: string }) => command.name === 'link edit');
    expect(linkEdit).toMatchObject({
      audience: 'human',
      prefer: 'link set'
    });
  });

  it('returns a single command entry for command-scoped json help', () => {
    const program = createProgram('/tmp/test');
    const installCommand = program.commands.find((command) => command.name() === 'install');
    expect(installCommand).toBeDefined();

    installCommand!.parent!.opts = () => ({ json: true });
    const helpInfo = installCommand!.helpInformation();
    const data = JSON.parse(helpInfo);

    expect(data.name).toBe('install');
    expect(data.args).toEqual([{ name: 'url-or-path', required: false }]);
    expect(data.flags.map((flag: { name: string }) => flag.name)).toContain('--name');
    expect(data.plan_schema).toEqual(expect.any(Object));
    expect(data.resolutions_schema).toEqual(expect.any(Object));
  });
});
