import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { saveConfig } from '../../src/config/config.js';
import { pushToServers } from '../../src/core/sync_engine.js';
import type { TransportRuntime } from '../../src/core/transport.js';

/**
 * Tester #449: `push` DELETES remote skill directories (`ssh … rm -rf`), and that fact was invisible on every read-only
 * surface. `--dry-run` printed `(no changes)` because the dry-run branch returns before the cleanup code computes
 * orphans at all; `PushResult` had no field for what was deleted (while `PullResult` has `deleted_skills`); and nothing
 * warned in advance. The four checks below pin what a person and a script can now see without authorising a deletion.
 */
function createRuntime(remoteSkills: string[]): TransportRuntime & { deletes: string[] } {
  const deletes: string[] = [];
  return {
    deletes,
    async exec(file, args) {
      if (file === 'ssh' && args.at(-1) === 'manifest') return { stdout: '', stderr: '' };
      // listRemoteSkills runs `ssh … ls <remote skills dir>`; its last argument names that directory.
      if (file === 'ssh' && args.includes('ls')) return { stdout: remoteSkills.join('\n'), stderr: '' };
      // deleteRemoteSkills sends `rm -rf <path>...` as separate argv words.
      if (file === 'ssh' && args.includes('rm') && args.includes('-rf')) {
        deletes.push(args.join(' '));
        return { stdout: '', stderr: '' };
      }
      if (file === 'rsync') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  };
}

/** A local skill on disk, so the manifest knows it and it is not itself an orphan. */
async function localSkill(home: string, name: string): Promise<void> {
  const dir = join(home, '.syncskill', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
}

const config = (include: string[] | undefined) => ({
  version: 1 as const, conflict_resolution: 'manual' as const, agents: {},
  links: { keepme: ['claude'] },
  servers: { alpha: { host: 'alpha.example.com', remote_agents: {}, ...(include === undefined ? {} : { skills: { include } }) } },
  sources: {},
});

describe('push discloses the remote deletions it would make (#449)', () => {
  const tempDirs = useTempDirs();
  afterEach(() => { /* tempDirs cleans up */ });

  it('a dry run lists the orphans it would delete instead of (no changes)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = createRuntime(['keepme', 'stale-a']);
    const [result] = await pushToServers(home, ['alpha'], { runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    // mutation: leave the dry-run branch returning before orphan computation -> deleted_skills absent, red
    expect(result.deleted_skills ?? []).toContain('stale-a');
    expect(runtime.deletes).toHaveLength(0);
  });

  it('an authorised delete reports exactly what it removed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = createRuntime(['keepme', 'stale-a']);
    const [result] = await pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' });
    // mutation: drop deleted_skills from PushResult -> the caller cannot tell what was removed, red
    expect(result.deleted_skills).toEqual(['stale-a']);
    expect(runtime.deletes).toHaveLength(1);
  });

  it('an empty include is not a licence to delete every remote skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    // `include: []` is what a hand-edited config or an editor round-trip can produce (the UI unsets instead).
    await saveConfig(config([]), home);
    const runtime = createRuntime(['keepme', 'other']);
    const [result] = await pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' });
    // mutation: pushSetOf returns the empty Set -> included() is false for every skill, every remote skill is an orphan, red
    expect(runtime.deletes).toHaveLength(0);
    expect(result.deleted_skills ?? []).toEqual([]);
    expect(result.warnings ?? []).toContain('no-skills-configured');
  });
});
