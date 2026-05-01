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
    expect(readme).toContain('## Install from source');
    expect(readme).toContain('npm link');
    expect(readme).toContain('syncskill --help');
    expect(readme).toContain('node dist/index.js --help');
    expect(readme).toContain('docs/config-guide.md');
    expect(readme).toContain('docs/usage-guide.md');
    expect(readme).toContain('docs/design-guide.md');
    expect(readme).toContain('syncskill init');
    expect(readme).toContain('source add');
    expect(readme).toContain('push');
    expect(readme).toContain('pull');
    expect(readme).toContain('sync');
    expect(readme).toContain('server list');
    expect(readme).toContain('server probe');
    expect(readme).toContain('refresh --remote --status');
    expect(readme).toContain('without pulling remote skill contents into the local repository');
    expect(readme).toContain('Use `pull` when you want to copy remote skill contents into the local repository.');
    expect(readme).toContain('`host`, `user`, `port`, `identity_file`, and `remote_agents`');

    expect(configGuide).toContain('# Configuration Guide');
    expect(configGuide).toContain('version');
    expect(configGuide).toContain('conflict_resolution');
    expect(configGuide).toContain('agents');
    expect(configGuide).toContain('links');
    expect(configGuide).toContain('servers');
    expect(configGuide).toContain('sources');
    expect(configGuide).toContain('servers:');
    expect(configGuide).toContain('server show <name>');
    expect(configGuide).toContain('server probe <name>');
    expect(configGuide).toContain('refresh --remote <server>');
    expect(configGuide).toContain('receiver availability');
    expect(configGuide).toContain('remote_agents');
    expect(configGuide).toContain('host`, optional `user`, optional `port`, optional `identity_file`');
    expect(configGuide).toContain('scans the configured `remote_agents` roots');
    expect(configGuide).toContain('npm link');

    expect(usageGuide).toContain('# Usage Guide');
    expect(usageGuide).toContain('syncskill init');
    expect(usageGuide).toContain('syncskill status');
    expect(usageGuide).toContain('syncskill diff alpha');
    expect(usageGuide).toContain('syncskill source update');
    expect(usageGuide).toContain('syncskill source update vendor-docs');
    expect(usageGuide).toContain('Run `syncskill source update` with no name to update every configured source, or pass a source name to update just one.');
    expect(usageGuide).toContain('syncskill refresh --status alpha');
    expect(usageGuide).toContain('refresh stored local manifest state before reviewing again');
    expect(usageGuide).not.toContain('Remote refresh remains future work');
    expect(usageGuide).toContain('syncskill server list');
    expect(usageGuide).toContain('syncskill server show alpha');
    expect(usageGuide).toContain('syncskill server probe alpha');
    expect(usageGuide).toContain('syncskill refresh --remote --status alpha');
    expect(usageGuide).toContain('without pulling skill contents into the local repository');
    expect(usageGuide).toContain('Run `syncskill pull alpha` when you want to materialize remote skill contents locally.');
    expect(usageGuide).toContain('npm link');
    expect(usageGuide).toContain('syncskill sync --all');
    expect(usageGuide).toContain('node dist/index.js --help');

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
