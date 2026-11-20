import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('remote receiver root', () => {
  it('reads and writes under the directory it was deployed into (issue 422 review)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-receiver-home-'));
    tempDirs.push(home);
    // A space in the root is the case the transport quoting exists for.
    const root = join(home, 'My Skills');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'sync_receiver.mjs'), await readFile(join(ROOT, 'src/receiver/sync_receiver.mjs')));

    const manifest = {
      version: 1,
      server: 'remote-test',
      updated_at: '2026-11-20T00:00:00.000Z',
      skills: {}
    };
    const result = spawnSync(process.execPath, [join(root, 'sync_receiver.mjs'), 'write-manifest'], {
      input: JSON.stringify(manifest),
      env: { ...process.env, HOME: home },
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toMatchObject({ server: 'remote-test' });
    await expect(readFile(join(home, '.syncskill', 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honours an explicit SYNCSKILL_ROOT even when it differs from the script directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-receiver-home-'));
    tempDirs.push(home);
    const scriptDir = join(home, 'deployed');
    const dataDir = join(home, 'data with space');
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, 'sync_receiver.mjs'), await readFile(join(ROOT, 'src/receiver/sync_receiver.mjs')));

    const result = spawnSync(process.execPath, [join(scriptDir, 'sync_receiver.mjs'), 'write-manifest'], {
      input: JSON.stringify({ version: 1, server: 'explicit-root', updated_at: '2026-11-20T00:00:00.000Z', skills: {} }),
      env: { ...process.env, HOME: home, SYNCSKILL_ROOT: dataDir },
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(dataDir, 'manifest.json'), 'utf8'))).toMatchObject({ server: 'explicit-root' });
    await expect(readFile(join(scriptDir, 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});