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

  // #426 follow-up: `shx cp -r src/receiver dist/receiver` nests (dist/receiver/receiver/) when dist/receiver already
  // exists, so every rebuild after the first left the deployed receiver stale. The build must clear the target first.
  it('npm run build clears dist/receiver before copying, so a rebuild is not a nested copy', () => {
    const build = pkg.scripts.build;
    const rmAt = build.indexOf('rm -rf dist/receiver');
    const cpAt = build.indexOf('cp -r src/receiver dist/receiver');
    expect(rmAt).toBeGreaterThanOrEqual(0);
    // mutation: drop `rm -rf dist/receiver` -> red
    expect(cpAt).toBeGreaterThan(rmAt);
  });

  it.skipIf(!existsSync(join(ROOT, 'dist/index.js')))('an existing dist has the receiver too, not nested under itself', () => {
    expect(existsSync(join(ROOT, 'dist/receiver/sync_receiver.mjs'))).toBe(true);
    expect(existsSync(join(ROOT, 'dist/receiver/bootstrap_remote.sh'))).toBe(true);
    // A nested copy from a second build never exists when the build clears its target first.
    expect(existsSync(join(ROOT, 'dist/receiver/receiver'))).toBe(false);
  });
});