import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake `ssh` for the real transport runtime (no network, no real ssh). It answers the receiver's `manifest` call
 * with $FAKE_SSH_MANIFEST_JSON and `ls` with the lines of $FAKE_SSH_LISTING; anything else succeeds silently.
 * Returns the directory to put first on PATH; the caller owns (and removes) it.
 */
const SCRIPT = `#!/bin/sh
case "$*" in
  *" ls "*) printf '%s\\n' $FAKE_SSH_LISTING ;;
  *" manifest") printf '%s' "$FAKE_SSH_MANIFEST_JSON" ;;
esac
exit 0
`;

export async function createFakeSshBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'syncskill-fakessh-'));
  await writeFile(join(dir, 'ssh'), SCRIPT, 'utf8');
  await chmod(join(dir, 'ssh'), 0o755);
  return dir;
}
