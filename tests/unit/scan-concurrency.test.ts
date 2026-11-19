import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { useTempDirs } from '../helpers/temp-dir.js';

const fsState = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  function track<Args extends unknown[], Result>(
    fn: (...args: Args) => Promise<Result>
  ): (...args: Args) => Promise<Result> {
    return (...args: Args) => {
      fsState.inFlight += 1;
      fsState.calls += 1;
      fsState.maxInFlight = Math.max(fsState.maxInFlight, fsState.inFlight);

      return fn(...args).finally(() => {
        fsState.inFlight -= 1;
      });
    };
  }

  return {
    ...actual,
    readdir: track(actual.readdir) as typeof actual.readdir,
    stat: track(actual.stat) as typeof actual.stat,
  };
});

import { scanSkillsInDirectory } from '../../src/source.js';

const SCAN_CONCURRENCY_LIMIT = 16;

describe('scanSkillsInDirectory concurrency', () => {
  const tempDirs = useTempDirs();

  it('scans 82 skills with a bounded number of filesystem calls in flight', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'syncskill-scan-concurrency-'));
    tempDirs.push(baseDir);

    for (let index = 1; index <= 82; index += 1) {
      const skillDir = join(baseDir, `skill-${String(index).padStart(2, '0')}`);
      await mkdir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), `# Skill ${index}`);
    }

    fsState.inFlight = 0;
    fsState.maxInFlight = 0;
    fsState.calls = 0;

    const skills = await scanSkillsInDirectory(baseDir);

    expect(skills).toHaveLength(82);
    expect(fsState.calls).toBeGreaterThanOrEqual(82);
    // Serial scanning would never exceed one in-flight call.
    expect(fsState.maxInFlight).toBeGreaterThan(1);
    // Unbounded parallelism would put all 83 calls in flight at once.
    expect(fsState.maxInFlight).toBeLessThanOrEqual(SCAN_CONCURRENCY_LIMIT);
  });
});
