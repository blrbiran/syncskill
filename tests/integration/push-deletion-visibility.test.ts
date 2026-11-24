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

  // Tester #456: `listRemoteSkills` caught every error and returned `[]`, so an unreachable remote looked exactly
  // like an empty one and both surfaces below reported "nothing to delete" with exit 0.
  const failingListingRuntime = (message: string) => {
    const runtime = createRuntime([]);
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (file, args, options) => {
      if (file === 'ssh' && args.includes('ls')) throw new Error(message);
      return exec(file, args, options);
    };
    return runtime;
  };

  it('a dry run fails loudly when the remote listing is unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = failingListingRuntime('ssh exited with code 255: Connection reset by peer');
    // mutation: restore `catch { return [] }` -> this resolves with deleted_skills [] instead of rejecting, red
    await expect(pushToServers(home, ['alpha'], { runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' }))
      .rejects.toThrow('E_REMOTE_TRANSPORT');
    expect(runtime.deletes).toHaveLength(0);
  });

  it('an authorised destructive push deletes nothing when it cannot list the remote', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = failingListingRuntime('spawn ssh ENOENT');
    // mutation: restore `catch { return [] }` -> this resolves with no error and never deletes, red
    await expect(pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' }))
      .rejects.toThrow('E_REMOTE_TRANSPORT');
    expect(runtime.deletes).toHaveLength(0);
  });

  // Tester #456 follow-up: the listing ran after the uploads, so a failed listing aborted with skill content already
  // pushed (and no manifest written) -- while CHANGELOG said push lists the remote "before any write".
  it('a push whose remote listing fails uploads nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = failingListingRuntime('ssh exited with code 255: Connection reset by peer');
    const rsyncs: string[] = [];
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (file, args, options) => {
      if (file === 'rsync') rsyncs.push(args.join(' '));
      return exec(file, args, options);
    };
    await expect(pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' }))
      .rejects.toThrow('E_REMOTE_TRANSPORT');
    // mutation: list the remote after the upload loop again -> keepme was rsynced before the failure, red
    expect(rsyncs.filter((a) => a.includes('keepme'))).toEqual([]);
  });

  // Tester #472 (reshaped, human 2026-11-24 「同意你的建议」): a skill the include list names but this machine does not
  // have -- a fresh machine, or a wrong --sync-dir -- counted as an orphan and was deleted remotely under
  // --yes-destructive. Only a skill this machine synced before (the manifest recorded it) and then deleted locally is a
  // local deletion to carry; anything else included is kept and named in warnings.
  it('an included skill this machine never had is kept remotely and named, not deleted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme', 'elsewhere']), home);
    await localSkill(home, 'keepme');
    const runtime = createRuntime(['keepme', 'elsewhere']);
    const [result] = await pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' });
    // mutation: treat an included skill with no local content as an orphan again -> 'elsewhere' is rm -rf'd, red
    expect(runtime.deletes).toEqual([]);
    expect(result.deleted_skills).toEqual([]);
    expect(result.warnings).toContain('included-not-local:elsewhere');
  });

  it('an included skill this machine synced and then deleted is still deleted remotely', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme', 'dropped']), home);
    await localSkill(home, 'keepme');
    await localSkill(home, 'dropped');
    await pushToServers(home, ['alpha'], { runtime: createRuntime(['keepme', 'dropped']), yes: true, yesDestructive: true, now: '2026-05-01T00:00:00.000Z' });
    const { rm } = await import('node:fs/promises');
    await rm(join(home, '.syncskill', 'skills', 'dropped'), { recursive: true, force: true });
    const runtime = createRuntime(['keepme', 'dropped']);
    const [result] = await pushToServers(home, ['alpha'], { runtime, yes: true, yesDestructive: true, now: '2026-05-02T00:00:00.000Z' });
    // mutation: never delete an included skill -> the local deletion is not carried, red
    expect(result.deleted_skills).toEqual(['dropped']);
    expect(runtime.deletes).toHaveLength(1);
  });

  it('an absent remote skills directory is still an empty list, not an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = failingListingRuntime("ssh exited with code 2: ls: cannot access '/home/u/.syncskill/skills': No such file or directory");
    // mutation: treat every failure as an error -> this rejects, red (a first push must not be blocked)
    const [result] = await pushToServers(home, ['alpha'], { runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    expect(result.deleted_skills ?? []).toEqual([]);
    expect(runtime.deletes).toHaveLength(0);
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
