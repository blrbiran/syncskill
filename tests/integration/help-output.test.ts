import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

const execAsync = promisify(execFile);

describe('help output', () => {
  it('describes the shipped commands in install-facing language', () => {
    const help = createProgram('/tmp').helpInformation();

    expect(help).toContain('Multi-device AI Agent Skill sync tool');
    expect(help).toContain('init');
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

  it('should show --json, --no-interactive, and --strict in root help', async () => {
    const { stdout } = await execAsync('node', ['dist/index.js', '--help'], {
      cwd: '/Users/biran/code/skills/syncskill'
    });

    expect(stdout).toContain('--json');
    expect(stdout).toContain('--no-interactive');
    expect(stdout).toContain('--strict');
  });

  it('source list has ls alias', () => {
    const program = createProgram('/tmp');
    const sourceCmd = program.commands.find(c => c.name() === 'source');
    const listCmd = sourceCmd?.commands.find(c => c.name() === 'list');

    expect(listCmd?.aliases()).toContain('ls');
  });

  it('remote list has ls alias', () => {
    const program = createProgram('/tmp');
    const remoteCmd = program.commands.find(c => c.name() === 'remote');
    const listCmd = remoteCmd?.commands.find(c => c.name() === 'list');

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

  it('should show subcommands: edit, set, add, remove, clear, build, list', async () => {
    const { stdout } = await execAsync('node', ['dist/index.js', 'link', '--help'], {
      cwd: '/Users/biran/code/skills/syncskill'
    });

    expect(stdout).toContain('edit');
    expect(stdout).toContain('set');
    expect(stdout).toContain('add');
    expect(stdout).toContain('remove');
    expect(stdout).toContain('clear');
    expect(stdout).toContain('build');
    expect(stdout).not.toContain('apply');
    expect(stdout).toContain('list');
  });

  it('rejects removed link apply alias', async () => {
    await expect(
      execAsync('node', ['dist/index.js', 'link', 'apply'], {
        cwd: '/Users/biran/code/skills/syncskill'
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("too many arguments for 'link'")
    });
  });

  it('describes update-flow commands and options clearly', () => {
    const program = createProgram('/tmp');
    const sourceCmd = program.commands.find(c => c.name() === 'source');
    const pushCmd = program.commands.find(c => c.name() === 'push');
    const pullCmd = program.commands.find(c => c.name() === 'pull');
    const syncCmd = program.commands.find(c => c.name() === 'sync');
    const scanCmd = program.commands.find(c => c.name() === 'scan');
    const doctorCmd = program.commands.find(c => c.name() === 'doctor');
    const installCmd = program.commands.find(c => c.name() === 'install');
    const refreshCmd = program.commands.find(c => c.name() === 'refresh');

    expect(sourceCmd?.description()).toBe('Manage external skill sources');
    expect(sourceCmd?.commands.find(c => c.name() === 'add')).toBeUndefined();
    expect(sourceCmd?.commands.find(c => c.name() === 'update')).toBeUndefined();
    expect(sourceCmd?.commands.find(c => c.name() === 'restore')).toBeUndefined();
    expect(scanCmd?.options.map(o => o.long)).toContain('--migrate-unmanaged');
    expect(scanCmd?.options.map(o => o.long)).not.toContain('--migrate');
    expect(refreshCmd?.description()).toBe('Refresh manifest state (no flags: local + remote, then show status)');
    expect(refreshCmd?.options.map(o => o.long)).not.toContain('--status');
    expect(doctorCmd?.description()).toBe('Diagnose and repair config issues');
    expect(installCmd?.options.find(o => o.long === '--path')?.description).toBe('Repo-relative subdirectory within source containing skills');
    expect(installCmd?.options.find(o => o.long === '--skill-subdir')?.description).toBe('Alias for --path');
    expect(pushCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
    expect(pullCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
    expect(syncCmd?.options.find(o => o.long === '--timeout')?.description).toBe('Per-server SSH timeout in seconds');
  });
});
