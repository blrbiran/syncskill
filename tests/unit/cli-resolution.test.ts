import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { hasResolution, loadResolutions, resolveItem } from '../../src/cli/resolution.js';

describe('cli/resolution', () => {
  it('returns empty object for missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syncskill-resolution-'));
    const result = await loadResolutions(join(dir, 'missing.json'));
    expect(result).toEqual({});
  });

  it('loads resolutions from json file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syncskill-resolution-'));
    const filePath = join(dir, 'resolutions.json');
    await writeFile(filePath, JSON.stringify({ skill: { name: 'demo' } }), 'utf8');

    const result = await loadResolutions(filePath);
    expect(result).toEqual({ skill: { name: 'demo' } });
  });

  it('resolves items by kind', () => {
    const resolutions = { skill: { name: 'demo' } };
    expect(resolveItem(resolutions, 'skill')).toEqual({ name: 'demo' });
    expect(hasResolution(resolutions, 'skill')).toBe(true);
    expect(hasResolution(resolutions, 'agent')).toBe(false);
  });

  it('loads resolutions from stdin when path is dash', async () => {
    const stdin = process.stdin;
    const stream = Readable.from([JSON.stringify({ skill: { name: 'stdin-demo' } })]);
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });

    try {
      const result = await loadResolutions('-');
      expect(result).toEqual({ skill: { name: 'stdin-demo' } });
    } finally {
      Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    }
  });
});
