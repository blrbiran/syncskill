import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Issue 403: the transport loads the remote receiver through `new URL('../receiver/...',
// import.meta.url)`, so the compiled CLI needs those files at `dist/receiver/`. The build used to copy
// only `skills/`, and every push/pull/sync failed with ENOENT before opening a connection.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: { build: string } };

describe('the built package carries the remote receiver', () => {
  it('the sources the transport loads exist', () => {
    expect(existsSync(join(ROOT, 'src/receiver/sync_receiver.mjs'))).toBe(true);
    expect(existsSync(join(ROOT, 'src/receiver/bootstrap_remote.sh'))).toBe(true);
  });

  it('npm run build copies src/receiver into dist', () => {
    expect(pkg.scripts.build).toContain('src/receiver');
  });

  it.skipIf(!existsSync(join(ROOT, 'dist/index.js')))('an existing dist has the receiver too', () => {
    expect(existsSync(join(ROOT, 'dist/receiver/sync_receiver.mjs'))).toBe(true);
    expect(existsSync(join(ROOT, 'dist/receiver/bootstrap_remote.sh'))).toBe(true);
  });
});