// tests/unit/cli-output.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Output, createOutput } from '../../src/cli/output.js';
import { ExitCode } from '../../src/cli/exit-codes.js';

describe('cli/output', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('JSON mode', () => {
    it('emits progress as JSONL', () => {
      const output = createOutput({ json: true, noColor: false });
      output.progress('refresh', 'Refreshing manifests');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        JSON.stringify({ type: 'progress', phase: 'refresh', message: 'Refreshing manifests' })
      );
    });

    it('emits error as JSONL to stdout', () => {
      const output = createOutput({ json: true, noColor: false });
      output.error('E_NETWORK', 'Connection failed');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('"type":"error"')
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('emits change events with all fields', () => {
      const output = createOutput({ json: true, noColor: false });
      output.change('push', 'skill', 'my-skill', { before: 'abc', after: 'def' });

      const call = consoleLogSpy.mock.calls[0][0];
      const event = JSON.parse(call);
      expect(event).toEqual({
        type: 'change',
        op: 'push',
        entity: 'skill',
        name: 'my-skill',
        before: 'abc',
        after: 'def',
      });
    });

    it('emits result event', () => {
      const output = createOutput({ json: true, noColor: false });
      output.setCommand('push');
      output.result(true, { pushed: 3, skipped: 0 });

      const call = consoleLogSpy.mock.calls[0][0];
      const event = JSON.parse(call);
      expect(event).toEqual({
        type: 'result',
        command: 'push',
        ok: true,
        summary: { pushed: 3, skipped: 0 },
      });
    });
  });

  describe('Text mode', () => {
    it('emits progress as plain text', () => {
      const output = createOutput({ json: false, noColor: false });
      output.progress('refresh', 'Refreshing manifests');

      expect(consoleLogSpy).toHaveBeenCalledWith('Refreshing manifests');
    });

    it('emits error to stderr', () => {
      const output = createOutput({ json: false, noColor: false });
      output.error('E_NETWORK', 'Connection failed');

      expect(consoleErrorSpy).toHaveBeenCalledWith('✗ Connection failed');
    });

    it('emits warning to stderr with hint', () => {
      const output = createOutput({ json: false, noColor: false });
      output.warning('W_DIRTY', 'Source is dirty', { hint: 'Use --force' });

      expect(consoleErrorSpy).toHaveBeenCalledWith('⚠ Source is dirty');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  Hint: Use --force');
    });

    it('formats change events with symbols', () => {
      const output = createOutput({ json: false, noColor: false });
      output.change('push', 'skill', 'my-skill');

      expect(consoleLogSpy).toHaveBeenCalledWith('↑ my-skill');
    });

    it('formats link changes with target', () => {
      const output = createOutput({ json: false, noColor: false });
      output.change('link', 'skill', 'my-skill', { target: 'claude' });

      expect(consoleLogSpy).toHaveBeenCalledWith('→ my-skill → claude');
    });
  });

  describe('error returns exit code', () => {
    it('returns NEEDS_INPUT for E_NEEDS_INPUT', () => {
      const output = createOutput({ json: true, noColor: false });
      const exitCode = output.error('E_NEEDS_INPUT', 'Interactive input required');
      expect(exitCode).toBe(ExitCode.NEEDS_INPUT);
    });

    it('returns NETWORK_ERROR for E_NETWORK', () => {
      const output = createOutput({ json: true, noColor: false });
      const exitCode = output.error('E_NETWORK', 'SSH failed');
      expect(exitCode).toBe(ExitCode.NETWORK_ERROR);
    });
  });

  describe('getEvents', () => {
    it('returns all emitted events', () => {
      const output = createOutput({ json: true, noColor: false });
      output.progress('init', 'Starting');
      output.info('Ready');
      output.result(true, {});

      const events = output.getEvents();
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('progress');
      expect(events[1].type).toBe('info');
      expect(events[2].type).toBe('result');
    });
  });
});
