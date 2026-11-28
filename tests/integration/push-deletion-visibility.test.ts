import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { saveConfig } from '../../src/config/config.js';
import { saveServerManifest, type ManifestSkillState } from '../../src/core/manifest.js';
import { pullFromServer, pushToServers } from '../../src/core/sync_engine.js';
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

/** A prior push's record of what the remote held: the only remote state a #555 dry run may read. */
async function cachedRemote(home: string, names: string[]): Promise<void> {
  const state = (): ManifestSkillState => ({ local_hash: 'r', remote_hash: 'r', recorded_hash: 'r', direction: 'skip', status: 'in-sync' });
  await saveServerManifest(home, {
    version: 1, server: 'alpha', updated_at: '2026-01-01T00:00:00Z',
    skills: Object.fromEntries(names.map((name) => [name, state()])),
  });
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
    // Tester #555 (session 1cdb9811): a dry run reads the cached remote state, not the remote itself.
    await cachedRemote(home, ['keepme', 'stale-a']);
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

  it('a dry run never lists the remote, so an unavailable listing cannot fail it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const runtime = failingListingRuntime('ssh exited with code 255: Connection reset by peer');
    // Tester #555 (session 1cdb9811): the dry run plans from cache and sends no SSH, so this listing
    // failure is never reached; the authorised push below still fails loudly on it.
    const [result] = await pushToServers(home, ['alpha'], { runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    expect(result.deleted_skills ?? []).toEqual([]);
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
    // Ruling (tester #477, session 5d3d0c09): warnings are {code, detail} now (code split from prose); same code, same fact.
    expect(result.warnings).toContainEqual({ code: 'included-not-local', detail: 'elsewhere' });
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

  // Tester #471 (human 2026-11-24 「同意你的建议」): --dry-run ran prepareManifest -> deployReceiver before its branch:
  // mkdir -p on the remote, the bootstrap, the receiver upload and a receiver_config.json overwrite (with the default
  // payload, dropping the backup links). A dry run now only reads: the installed receiver's manifest and the listing.
  const writes = (calls: string[][]) => calls.filter((a) => a.some((w) => /\bmkdir\b|cat >/.test(w)) || (a.includes('sh') && a.includes('-s')));
  function recordingRuntime(remoteSkills: string[], receiverPresent = true) {
    const runtime = createRuntime(remoteSkills);
    const calls: string[][] = [];
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (file, args, options) => {
      if (file === 'ssh') calls.push(args);
      if (!receiverPresent && file === 'ssh' && args.includes('manifest')) throw new Error("ssh exited with code 1: Error: Cannot find module '/home/u/.syncskill/receiver.mjs'");
      return exec(file, args, options);
    };
    return { runtime, calls };
  }

  it('a dry-run push and pull write nothing on the remote', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    // Tester #555 (session 1cdb9811): remote state comes from the cache; no SSH is sent at all.
    await cachedRemote(home, ['keepme', 'stale-a']);
    const push = recordingRuntime(['keepme', 'stale-a']);
    const [result] = await pushToServers(home, ['alpha'], { runtime: push.runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    // mutation: deploy the receiver in a dry run again -> mkdir/bootstrap/cat > calls, red
    expect(writes(push.calls)).toEqual([]);
    expect(push.calls).toEqual([]);
    expect(result.deleted_skills).toEqual(['stale-a']);
    const pull = recordingRuntime(['keepme']);
    await pullFromServer(home, 'alpha', { runtime: pull.runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    expect(writes(pull.calls)).toEqual([]);
    expect(pull.calls).toEqual([]);
  });

  it('a dry run against a remote with no receiver installs none and says the plan is unknown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'syncskill-del-'));
    tempDirs.push(home);
    await saveConfig(config(['keepme']), home);
    await localSkill(home, 'keepme');
    const { runtime, calls } = recordingRuntime([], false);
    const [result] = await pushToServers(home, ['alpha'], { runtime, dryRun: true, now: '2026-05-01T00:00:00.000Z' });
    expect(writes(calls)).toEqual([]);
    // Tester #555 (session 1cdb9811): the dry run no longer probes the receiver at all, so the plan
    // cannot silently claim the remote is empty; it says instead that no receiver backup constrains it.
    // Ruling (tester #477, session 5d3d0c09): warnings are {code, detail} now (code split from prose).
    expect(result.warnings).toContainEqual({
      code: 'receiver-backup-missing',
      detail: 'This dry-run is not constrained by the receiver link matrix; a first push may push fewer skills.',
    });
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
    // Ruling (tester #477, session 5d3d0c09): warnings are {code, detail} now (code split from prose); same code, same fact.
    expect((result.warnings ?? []).map((w) => w.code)).toContain('no-skills-configured');
  });
});
