import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('test tier layout', () => {
  it('package scripts and tier directories expose unit, integration, and end2end suites', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:unit']).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:integration']).toBe('vitest run tests/integration');
    expect(packageJson.scripts['test:end2end']).toBe('vitest run tests/end2end');

    await expect(readFile(join(rootDir, 'tests', 'unit', 'README.md'), 'utf8')).resolves.toContain('default required pass gate');
    await expect(readFile(join(rootDir, 'tests', 'integration', 'README.md'), 'utf8')).resolves.toContain(
      'not part of the default mandatory pass gate'
    );
    await expect(readFile(join(rootDir, 'tests', 'end2end', 'README.md'), 'utf8')).resolves.toContain('realistic user paths');
  });
});
