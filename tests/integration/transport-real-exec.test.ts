import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';
import { saveConfig, type ConfiguredServer } from '../../src/config/config.js';
import { pushToServers } from '../../src/core/sync_engine.js';
import { createTransportRuntime, deployReceiver, listRemoteSkills } from '../../src/core/transport.js';

/**
 * Tester #456 (residual): the earlier criteria threw hand-written `ssh exited with code 255: …` text, which only the
 * stdin (spawn) path produces. `ls`, `mkdir` and `manifest` go through `execFile`, whose error reads
 * `Command failed: ssh …` with the exit status in `error.code` -- so the message-only classifier never saw a
 * transport failure there. These tests run the real runtime against a fake `ssh` on PATH (no network, no real ssh):
 * each ssh subcommand fails the way the FAKE_SSH_* variable says.
 */
const FAKE_SSH = `#!/bin/sh
case "$*" in
  *" ls "*) mode="$FAKE_SSH_LS" ;;
  *mkdir*) mode="$FAKE_SSH_MKDIR" ;;
  *" manifest") mode="$FAKE_SSH_MANIFEST" ;;
  *) mode=ok ;;
esac
case "$mode" in
  identity) echo "Warning: Identity file /tmp/gone.pem not accessible: No such file or directory." >&2; exit 255 ;;
  dns) echo "ssh: Could not resolve hostname no.such.host.invalid: nodename nor servname provided, or not known" >&2; exit 255 ;;
  hostkey) echo "Host key verification failed." >&2; exit 255 ;;
  reset) echo "Connection reset by peer" >&2; exit 255 ;;
  absent-bsd) echo "ls: /home/u/.syncskill/skills: No such file or directory" >&2; exit 1 ;;
  absent-gnu) echo "ls: cannot access '/home/u/.syncskill/skills': No such file or directory" >&2; exit 2 ;;
  other-dir) echo "ls: /home/u/elsewhere: No such file or directory" >&2; exit 2 ;;
  denied) echo "mkdir: cannot create directory '/srv/x': Permission denied" >&2; exit 1 ;;
  nomodule) echo "Error: Cannot find module '/home/u/.syncskill/sync_receiver.mjs'" >&2; exit 1 ;;
  listing) printf 'keepme\\nstale-a\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`;

const server = { name: 'lab', host: 'lab.example.invalid', remote_agents: {} } as ConfiguredServer;

describe('transport failures in the real execFile error shape (#456)', () => {
  const tempDirs = useTempDirs();
  const savedEnv = { ...process.env };
  let binDir = '';

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'syncskill-fakessh-'));
    tempDirs.push(binDir);
    await writeFile(join(binDir, 'ssh'), FAKE_SSH, 'utf8');
    await chmod(join(binDir, 'ssh'), 0o755);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
  });

  afterEach(() => {
    for (const key of ['PATH', 'FAKE_SSH_LS', 'FAKE_SSH_MKDIR', 'FAKE_SSH_MANIFEST']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const listWith = (mode: string) => {
    process.env.FAKE_SSH_LS = mode;
    return listRemoteSkills(server, createTransportRuntime());
  };

  it('an ssh exit 255 whose stderr says "No such file or directory" is a transport failure, not an empty remote', async () => {
    // Two guards protect this case (the exit code, and "absent" meaning only ls's own report on the skills dir); with
    // both reverted to dc8cfb3's message regexes it resolves [] -- the false "nothing to delete", red (seen).
    await expect(listWith('identity')).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it.each(['dns', 'hostkey', 'reset'])('a %s failure while listing is a transport failure', async (mode) => {
    await expect(listWith(mode)).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it.each(['absent-bsd', 'absent-gnu'])("ls's own %s report about the skills directory is an empty remote", async (mode) => {
    // mutation: drop the absent-directory branch -> a first push to a fresh server fails, red
    await expect(listWith(mode)).resolves.toEqual([]);
  });

  it('ls reporting some other path missing is not "the skills directory is absent"', async () => {
    // mutation: match any "No such file or directory" again -> resolves [], red
    await expect(listWith('other-dir')).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it('a missing ssh binary is a transport failure', async () => {
    process.env.PATH = join(binDir, 'nothing-here');
    await expect(listRemoteSkills(server, createTransportRuntime())).rejects.toThrow('E_REMOTE_TRANSPORT');
  });

  it('deployReceiver files a DNS failure under E_REMOTE_TRANSPORT and a refused mkdir under E_REMOTE_ROOT', async () => {
    process.env.FAKE_SSH_MKDIR = 'dns';
    // mutation: classify by message text only -> the DNS failure is reported as an unwritable root (exit 1), red
    await expect(deployReceiver(server, createTransportRuntime())).rejects.toThrow(/^E_REMOTE_TRANSPORT:/);
    process.env.FAKE_SSH_MKDIR = 'denied';
    await expect(deployReceiver(server, createTransportRuntime())).rejects.toThrow(/^E_REMOTE_ROOT:/);
  });

  describe('push --dry-run through the real runtime', () => {
    async function home(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'syncskill-realexec-'));
      tempDirs.push(dir);
      await saveConfig({
        version: 1, conflict_resolution: 'manual', agents: {}, links: { keepme: ['claude'] },
        servers: { lab: { host: 'lab.example.invalid', remote_agents: {}, skills: { include: ['keepme'] } } }, sources: {},
      } as never, dir);
      await mkdir(join(dir, '.syncskill', 'skills', 'keepme'), { recursive: true });
      await writeFile(join(dir, '.syncskill', 'skills', 'keepme', 'SKILL.md'), '# keepme\n', 'utf8');
      return dir;
    }

    it('fails with E_REMOTE_TRANSPORT when reading the manifest hits an ssh failure', async () => {
      process.env.FAKE_SSH_MANIFEST = 'reset';
      process.env.FAKE_SSH_LS = 'listing';
      // mutation: classify by message text only -> the reset reads as "no receiver" and the plan resolves, red
      await expect(pushToServers(await home(), ['lab'], { dryRun: true, now: '2026-05-01T00:00:00.000Z' }))
        .rejects.toThrow('E_REMOTE_TRANSPORT');
    });

    it('fails with E_REMOTE_TRANSPORT when the listing hits an ssh failure', async () => {
      process.env.FAKE_SSH_LS = 'identity';
      await expect(pushToServers(await home(), ['lab'], { dryRun: true, now: '2026-05-01T00:00:00.000Z' }))
        .rejects.toThrow('E_REMOTE_TRANSPORT');
    });

    it('a remote without a receiver is still "state unknown", and the orphan plan still comes from the listing', async () => {
      process.env.FAKE_SSH_MANIFEST = 'nomodule';
      process.env.FAKE_SSH_LS = 'listing';
      const [result] = await pushToServers(await home(), ['lab'], { dryRun: true, now: '2026-05-01T00:00:00.000Z' });
      expect(result.deleted_skills).toEqual(['stale-a']);
      // Ruling (tester #477, session 5d3d0c09): warnings are {code, detail} since #477.
      expect((result.warnings ?? []).map((w) => w.code)).toContain('remote-state-unknown');
    });
  });
});
