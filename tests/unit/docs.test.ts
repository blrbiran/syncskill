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
    expect(readme).toContain('remote list');
    expect(readme).toContain('refresh --remote <server>');
    expect(readme).toContain('--json');
    expect(readme).toContain('--no-interactive');
    expect(readme).toContain('--yes-destructive');
    expect(readme).toContain('Show install help with no target');
    expect(readme).toContain('--remote-repo');
    expect(readme).toContain('optional `remote_repo`');
    expect(readme).toContain('SYNCSKILL_STRICT=1');
    expect(readme).toContain('SYNCSKILL_PULL_BACKUP');
    expect(readme).toContain('--on-remote-deletion');
    expect(readme).toContain('link set');
    expect(readme).toContain('link build');
    expect(readme).toContain('syncskill install <url-or-path> [--path <dir>] [--type <type>]');
    expect(readme).toContain('repo-relative skills subdirectory inside the source checkout');
    expect(readme).toContain('`--skill-subdir` is an alias for `--path`');
    expect(readme).toContain('Repeated installs from the same git or HTTP source reuse the existing source entry');
    expect(readme).toContain('syncskill restore <skill>');
    expect(readme).toContain('latest pre-pull backup');
    expect(readme).toContain('pre-restore snapshot');

    expect(docsReadme).toContain('syncskill link build');
    expect(docsReadme).toContain('remove stale symlinks');
    expect(docsReadme).toContain('Remote Lifecycle Workflow');
    expect(docsReadme).toContain('receivers/<server>.json');
    expect(docsReadme).toContain('syncskill install` with no target shows help');
    expect(docsReadme).toContain('already-installed reporting');
    expect(docsReadme).toContain('--on-remote-deletion');
    expect(docsReadme).toContain('SYNCSKILL_PULL_BACKUP');
    expect(docsReadme).toContain('restore <skill>');
    expect(docsReadme).toContain('pre-restore');

    expect(configGuide).toContain('# Configuration Guide');
    expect(configGuide).toContain('version');
    expect(configGuide).toContain('conflict_resolution');
    expect(configGuide).toContain('agents');
    expect(configGuide).toContain('links');
    expect(configGuide).toContain('servers');
    expect(configGuide).toContain('sources');
    expect(configGuide).toContain('config.json');
    expect(configGuide).toContain('receivers/');
    expect(configGuide).toContain('remote show <name>');
    expect(configGuide).toContain('refresh --remote <server>');
    expect(configGuide).toContain('remote_agents');
    expect(configGuide).toContain('remote_repo');
    expect(configGuide).toContain('http_baselines');
    expect(configGuide).not.toContain('"ignored": {');
    expect(configGuide).toContain('config.sources[*].ignore[]');
    expect(configGuide).toContain('`config.sources[*].path` stores the relative source-root subdirectory currently managed for that source.');
    expect(configGuide).toContain('SYNCSKILL_STRICT');
    expect(configGuide).toContain('SYNCSKILL_PULL_BACKUP');
    expect(configGuide).toContain('relative subdirectory within the local source root pointed to by `url`');
    expect(configGuide).toContain('"url": "~/dev/skills"');
    expect(configGuide).not.toContain('"path": "/Users/alice/dev/skills"');
    expect(configGuide).toContain('npm link');
    expect(configGuide).toContain('pre-restore');
    expect(configGuide).toContain('forced_conflict');

    expect(usageGuide).toContain('# Usage Guide');
    expect(usageGuide).toContain('syncskill init');
    expect(usageGuide).toContain('syncskill status');
    expect(usageGuide).toContain('syncskill diff alpha');
    expect(usageGuide).toContain('syncskill refresh alpha');
    expect(usageGuide).toContain('syncskill remote list');
    expect(usageGuide).toContain('syncskill remote show alpha');
    expect(usageGuide).toContain('syncskill refresh --remote alpha');
    expect(usageGuide).not.toContain('refresh --status');
    expect(usageGuide).not.toContain('refresh --remote --status');
    expect(usageGuide).toContain('npm link');
    expect(usageGuide).toContain('syncskill sync --all');
    expect(usageGuide).toContain('node dist/index.js --help');
    expect(usageGuide).toContain('--json');
    expect(usageGuide).toContain('--no-interactive');
    expect(usageGuide).toContain('--yes-destructive');
    expect(usageGuide).toContain('optional `remote_repo`');
    expect(usageGuide).toContain('syncskill install` with no target shows help');
    expect(usageGuide).toContain('SYNCSKILL_STRICT');
    expect(usageGuide).toContain('SYNCSKILL_PULL_BACKUP');
    expect(usageGuide).toContain('--on-remote-deletion');
    expect(usageGuide).toContain('link set');
    expect(usageGuide).toContain('link build');
    expect(usageGuide).toContain('Repo-relative subdirectory within the source checkout containing skills');
    expect(usageGuide).toContain('Repeated installs from the same git or HTTP source reuse the existing source entry');
    expect(usageGuide).toContain('If the requested skills are already present, syncskill reports them as already installed instead of treating the install as a silent no-op.');
    expect(usageGuide).toContain('--type <type>');
    expect(usageGuide).toContain('syncskill restore welcome');
    expect(usageGuide).toContain('pre-restore');

    expect(skillDoc).toContain('repo-relative subdirectory containing skills');
    expect(skillDoc).toContain('install <url-or-path> [--name] [--path <dir>] [--branch] [--type <type>] [-y]');
    expect(skillDoc).toContain('Show install help with no target');
    expect(skillDoc).toContain('--type');
    expect(skillDoc).toContain('--remote-repo');
    expect(skillDoc).toContain('--yes-destructive');
    expect(skillDoc).toContain('--on-remote-deletion');
    expect(skillDoc).toContain('SYNCSKILL_STRICT=1');
    expect(skillDoc).toContain('SYNCSKILL_PULL_BACKUP');
    expect(skillDoc).toContain('restore <skill> [--server <server>|--all-servers|--dry-run]');
    expect(skillDoc).toContain('If requested skills already exist locally, syncskill reports them as already installed.');

    expect(designGuide).toContain('# Design Guide');
    expect(designGuide).toContain('src/index.ts');
    expect(designGuide).toContain('src/config/config.ts');
    expect(designGuide).toContain('src/repo.ts');
    expect(designGuide).toContain('src/core/manifest.ts');
    expect(designGuide).toContain('src/core/conflict.ts');
    expect(designGuide).toContain('receivers/<server>.json');
    expect(designGuide).toContain('http_baselines');
    expect(designGuide).toContain('src/source.ts');
    expect(designGuide).toContain('Repeated installs from the same source widen or reuse the recorded source path instead of creating duplicate source entries.');
    expect(designGuide).toContain('src/core/transport.ts');
    expect(designGuide).toContain('src/core/sync_engine.ts');
    expect(designGuide).toContain('SYNCSKILL_STRICT');
    expect(designGuide).toContain('SYNCSKILL_PULL_BACKUP');
    expect(designGuide).toContain('pre-restore');
    expect(designGuide).toContain('forced_conflict');
  });
});
