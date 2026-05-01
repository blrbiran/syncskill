import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('package metadata', () => {
  it('exposes a public-facing description, bin, and tiered scripts', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      private?: boolean;
      description?: string;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.description).toBe('Multi-device AI Agent Skill sync tool');
    expect(packageJson.bin?.syncskill).toBe('dist/index.js');
    expect(packageJson.scripts?.build).toBe('tsc -p tsconfig.build.json');
    expect(packageJson.scripts?.test).toBe('vitest run tests/unit');
    expect(packageJson.scripts?.['test:unit']).toBe('vitest run tests/unit');
    expect(packageJson.scripts?.['test:integration']).toBe('vitest run tests/integration');
    expect(packageJson.scripts?.['test:end2end']).toBe('vitest run tests/end2end');
    expect(packageJson.scripts?.['test:watch']).toBe('vitest');
  });
});
