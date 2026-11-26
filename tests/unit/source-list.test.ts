import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { listSourcesWithDetails } from '../../src/source.js';

/**
 * Tester #511: `source list` read only `.sources/<name>/state.json`'s `materialized_skills`, which local sources never
 * write (they are not materialized), so every source reported `skills: []` while doctor's live scan knew their skills.
 * The list is the union of the recorded state and the live directory, and an unreadable source says so.
 */
describe('source list (#511)', () => {
  const tempDirs = useTempDirs();

  async function home(sources: Record<string, unknown>) {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-list-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {},
      sources
    }));
    return homeDir;
  }

  async function sourceWith(root: string, names: string[]) {
    await mkdir(root, { recursive: true });
    for (const name of names) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'SKILL.md'), `# ${name}`);
    }
  }

  it('lists a local source that was never updated from its live directory', async () => {
    const homeDir = await home({});
    const root = join(homeDir, 'sources', 'br');
    await sourceWith(root, ['br-a', 'br-b']);
    await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {},
      sources: { br: { type: 'local', path: root } }
    }));

    // mutation: read only the source state (the old implementation) -> skills [], red
    const entry = (await listSourcesWithDetails(homeDir)).find((source) => source.name === 'br')!;
    expect(entry.skills).toEqual(['br-a', 'br-b']);
    expect(entry.unreadable).toBeUndefined();
  });

  it('separates ignored skills and marks an unreadable source instead of a silent empty list', async () => {
    const homeDir = await home({});
    const root = join(homeDir, 'sources', 'br');
    await sourceWith(root, ['br-a', 'template']);
    await writeFile(join(homeDir, '.syncskill', 'config.json'), JSON.stringify({
      version: 1, conflict_resolution: 'manual', agents: {}, links: {}, servers: {},
      sources: { br: { type: 'local', path: root, ignore: ['template'] }, gone: { type: 'local', path: join(homeDir, 'missing') } }
    }));

    const list = await listSourcesWithDetails(homeDir);
    const br = list.find((source) => source.name === 'br')!;
    const gone = list.find((source) => source.name === 'gone')!;
    expect(br.skills).toEqual(['br-a']);
    expect(br.ignored).toEqual(['template']);
    expect(gone.skills).toEqual([]);
    expect(gone.unreadable).toBe(true);
  });
});