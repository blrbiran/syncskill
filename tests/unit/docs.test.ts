import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ship-readiness docs', () => {
  it('top-level docs exist and link the expected entrypoints', async () => {
    const [readme, configGuide, usageGuide, designGuide] = await Promise.all([
      readFile(join(rootDir, 'README.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'config-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'usage-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'design-guide.md'), 'utf8')
    ]);

    expect(readme).toContain('# syncskill');
    expect(readme).toContain('## Quick start');
    expect(readme).toContain('docs/config-guide.md');
    expect(readme).toContain('docs/usage-guide.md');
    expect(readme).toContain('docs/design-guide.md');
    expect(readme).toContain('syncskill init');
    expect(readme).toContain('source add');
    expect(readme).toContain('push');
    expect(readme).toContain('pull');
    expect(readme).toContain('sync');

    expect(configGuide).toContain('# Configuration Guide');
    expect(configGuide).toContain('version');
    expect(configGuide).toContain('conflict_resolution');
    expect(configGuide).toContain('agents');
    expect(configGuide).toContain('links');
    expect(configGuide).toContain('servers');
    expect(configGuide).toContain('sources');
    expect(configGuide).toContain('servers:');

    expect(usageGuide).toContain('# Usage Guide');
    expect(usageGuide).toContain('syncskill init');
    expect(usageGuide).toContain('syncskill status');
    expect(usageGuide).toContain('syncskill diff alpha');
    expect(usageGuide).toContain('syncskill source update');
    expect(usageGuide).toContain('syncskill source update vendor-docs');
    expect(usageGuide).toContain('syncskill sync --all');

    expect(designGuide).toContain('# Design Guide');
    expect(designGuide).toContain('src/index.ts');
    expect(designGuide).toContain('src/config.ts');
    expect(designGuide).toContain('src/repo.ts');
    expect(designGuide).toContain('src/manifest.ts');
    expect(designGuide).toContain('src/conflict.ts');
    expect(designGuide).toContain('src/source.ts');
    expect(designGuide).toContain('src/transport.ts');
    expect(designGuide).toContain('src/sync_engine.ts');
  });
});
