import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InjectError, injectSkills } from '../../src/inject.js';

describe('injectSkills guards', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inject-guards-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const cases: Array<[string[], string]> = [
    [['../x'], 'E_USAGE_SKILL_NAME'],
    [['a/b'], 'E_USAGE_SKILL_NAME'],
    [['.hidden'], 'E_USAGE_SKILL_NAME'],
    [[''], 'E_USAGE_SKILL_NAME'],
    [[], 'E_USAGE_INJECT_SELECTION']
  ];

  it.each(cases)('rejects %j with %s and leaves the target absent', async (skills, code) => {
    const target = join(root, 'target');
    const error = await injectSkills(join(root, 'home'), { skills, profile: null, target }).catch((e) => e);
    expect(error).toBeInstanceOf(InjectError);
    expect((error as InjectError).code).toBe(code);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
