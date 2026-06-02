import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ship-readiness docs', () => {
  it('top-level docs exist and link the expected entrypoints', async () => {
    const [readme, docsReadme, configGuide, usageGuide, designGuide, skillDoc] = await Promise.all([
      readFile(join(rootDir, 'README.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'README.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'config-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'usage-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'design-guide.md'), 'utf8'),
      readFile(join(rootDir, 'skills', 'syncskill', 'SKILL.md'), 'utf8')
    ]);

    expect(readme).toContain('# syncskill');
    expect(readme).toContain('## Install from source');
    expect(readme).toContain('npm link');
    expect(readme).toContain('syncskill --help');
    expect(readme).toContain('node dist/index.js --help');
    expect(readme).toContain('docs/config-guide.md');
    expect(readme).toContain('docs/usage-guide.md');
    expect(readme).toContain('docs/design-guide.md');
    expect(readme).toContain('syncskill init');
    expect(readme).toContain('push');
    expect(readme).toContain('pull');
    expect(readme).toContain('sync');
    expect(readme).toContain('server list');
    expect(readme).toContain('refresh --remote <server>');
    expect(readme).toContain('--json');
    expect(readme).toContain('--no-interactive');
    expect(readme).toContain('link set');
    expect(readme).toContain('link build');
    expect(readme).toContain('syncskill install <url-or-path> [--path <dir>]');
    expect(readme).toContain('repo-relative skills subdirectory inside the source checkout');

    expect(docsReadme).toContain('syncskill link build');
    expect(docsReadme).toContain('remove stale symlinks');

    expect(configGuide).toContain('# Configuration Guide');
    expect(configGuide).toContain('version');
    expect(configGuide).toContain('conflict_resolution');
    expect(configGuide).toContain('agents');
    expect(configGuide).toContain('links');
    expect(configGuide).toContain('servers');
    expect(configGuide).toContain('sources');
    expect(configGuide).toContain('config.json');
    expect(configGuide).toContain('server show <name>');
    expect(configGuide).toContain('refresh --remote <server>');
    expect(configGuide).toContain('remote_agents');
    expect(configGuide).toContain('npm link');

    expect(usageGuide).toContain('# Usage Guide');
    expect(usageGuide).toContain('syncskill init');
    expect(usageGuide).toContain('syncskill status');
    expect(usageGuide).toContain('syncskill diff alpha');
    expect(usageGuide).toContain('syncskill refresh alpha');
    expect(usageGuide).toContain('syncskill server list');
    expect(usageGuide).toContain('syncskill server show alpha');
    expect(usageGuide).toContain('syncskill refresh --remote alpha');
    expect(usageGuide).toContain('npm link');
    expect(usageGuide).toContain('syncskill sync --all');
    expect(usageGuide).toContain('node dist/index.js --help');
    expect(usageGuide).toContain('--json');
    expect(usageGuide).toContain('--no-interactive');
    expect(usageGuide).toContain('link set');
    expect(usageGuide).toContain('link build');
    expect(usageGuide).toContain('Repo-relative subdirectory within the source checkout containing skills');

    expect(skillDoc).toContain('repo-relative subdirectory containing skills');

    expect(designGuide).toContain('# Design Guide');
    expect(designGuide).toContain('src/index.ts');
    expect(designGuide).toContain('src/config/config.ts');
    expect(designGuide).toContain('src/repo.ts');
    expect(designGuide).toContain('src/core/manifest.ts');
    expect(designGuide).toContain('src/core/conflict.ts');
    expect(designGuide).toContain('src/source.ts');
    expect(designGuide).toContain('src/core/transport.ts');
    expect(designGuide).toContain('src/core/sync_engine.ts');
  });
});
