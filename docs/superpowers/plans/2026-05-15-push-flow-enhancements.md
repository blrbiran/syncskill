# Push Flow Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement push flow optimizations and safety features from spec commit bea60c27, including hash-based receiver deployment, remote directory verification, skill cleanup with confirmation, and remote-change warnings.

**Architecture:** Enhance `transport.ts` with `receiverNeedsUpdate()` for hash comparison. Add `verifyRemoteSkills()` and `cleanupRemoteSkills()` to `sync_engine.ts` with interactive confirmation. Push flow gets new step to warn about remote changes without implicit pull.

**Tech Stack:** Node.js, SSH/rsync, MD5 hashing, @inquirer/prompts for confirmation

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/transport.ts` | Add `receiverNeedsUpdate()`, `listRemoteSkills()`, `deleteRemoteSkills()` |
| `src/core/sync_engine.ts` | Add verification step, cleanup step, remote-change warnings |
| `src/index.ts` | Pass `--no-refresh` flag to push flow |
| `tests/unit/transport.test.ts` | Unit tests for new transport functions |
| `tests/integration/sync-engine.test.ts` | Integration tests for enhanced push flow |
| `docs/config-guide.md` | Update manifest format to show 3-field model |
| `docs/design-guide.md` | Document new push flow steps |
| `README.md` | Minor updates if needed |
| `skills/syncskill/SKILL.md` | No changes needed |

---

## Task 1: Add `receiverNeedsUpdate()` to transport.ts

**Files:**
- Modify: `src/core/transport.ts`
- Test: `tests/unit/transport.test.ts` (new test file or add to existing)

- [ ] **Step 1.1: Write the failing test for receiverNeedsUpdate**

```typescript
// tests/unit/transport.test.ts - add to existing or create new
import { describe, it, expect, vi } from 'vitest';
import { receiverNeedsUpdate, type TransportRuntime } from '../../src/core/transport.js';
import type { ConfiguredServer } from '../../src/config/config.js';

describe('receiverNeedsUpdate', () => {
  const mockServer: ConfiguredServer = {
    name: 'test-server',
    host: 'example.com',
    user: 'testuser'
  };

  it('returns true when remote file does not exist', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.includes('md5sum')) {
          throw new Error('md5sum: No such file or directory');
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await receiverNeedsUpdate(mockServer, runtime);
    expect(result).toBe(true);
  });

  it('returns true when hash differs', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.includes('md5sum')) {
          return { stdout: 'differenthash123  ~/.syncskill/sync_receiver.mjs\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await receiverNeedsUpdate(mockServer, runtime);
    expect(result).toBe(true);
  });

  it('returns false when hash matches', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        // This will need to match the actual hash computed from the receiver file
        if (args.includes('md5sum')) {
          // We'll mock this to return the expected hash
          return { stdout: 'PLACEHOLDER_HASH  ~/.syncskill/sync_receiver.mjs\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    // Note: Test will need adjustment once we compute actual hash
    const result = await receiverNeedsUpdate(mockServer, runtime);
    // Initially this should fail since we haven't implemented the function
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npm test -- tests/unit/transport.test.ts -t "receiverNeedsUpdate"`
Expected: FAIL with "receiverNeedsUpdate is not exported" or similar

- [ ] **Step 1.3: Implement receiverNeedsUpdate function**

Add to `src/core/transport.ts`:

```typescript
import { createHash } from 'node:crypto';

// Add this function before deployReceiver
export async function receiverNeedsUpdate(server: ConfiguredServer, runtime: TransportRuntime): Promise<boolean> {
  // Compute local receiver hash
  const receiverContent = await readFile(new URL('../receiver/sync_receiver.mjs', import.meta.url), 'utf8');
  const localHash = createHash('md5').update(receiverContent).digest('hex');

  try {
    // Get remote receiver hash via SSH md5sum
    const result = await runtime.exec('ssh', buildSshArgs(server, ['md5sum', REMOTE_RECEIVER]));
    const remoteHash = result.stdout.trim().split(/\s+/)[0];
    
    return localHash !== remoteHash;
  } catch {
    // File doesn't exist or command failed - needs update
    return true;
  }
}
```

- [ ] **Step 1.4: Update deployReceiver to use receiverNeedsUpdate**

Modify `deployReceiver` in `src/core/transport.ts`:

```typescript
export async function deployReceiver(server: ConfiguredServer, runtime: TransportRuntime): Promise<void> {
  // Check if update is needed
  const needsUpdate = await receiverNeedsUpdate(server, runtime);
  
  if (!needsUpdate) {
    // Only push config (remote_agents may have changed)
    await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_ROOT}/receiver_config.json`]), {
      stdin: `${JSON.stringify({ remote_agents: server.remote_agents }, null, 2)}\n`
    });
    return;
  }

  const bootstrap = await readFile(new URL('../receiver/bootstrap_remote.sh', import.meta.url), 'utf8');
  const receiver = await readFile(new URL('../receiver/sync_receiver.mjs', import.meta.url), 'utf8');

  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-s']), { stdin: bootstrap });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_RECEIVER}`]), { stdin: receiver });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_ROOT}/receiver_config.json`]), {
    stdin: `${JSON.stringify({ remote_agents: server.remote_agents }, null, 2)}\n`
  });
}
```

- [ ] **Step 1.5: Fix test with actual hash computation**

Update the test to properly compute the expected hash:

```typescript
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// In the test setup
const __dirname = dirname(fileURLToPath(import.meta.url));
const receiverPath = join(__dirname, '../../src/receiver/sync_receiver.mjs');

it('returns false when hash matches', async () => {
  const receiverContent = await readFile(receiverPath, 'utf8');
  const expectedHash = createHash('md5').update(receiverContent).digest('hex');

  const runtime: TransportRuntime = {
    calls: [],
    async exec(file, args) {
      this.calls?.push({ file, args });
      if (args.includes('md5sum')) {
        return { stdout: `${expectedHash}  ~/.syncskill/sync_receiver.mjs\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  };

  const result = await receiverNeedsUpdate(mockServer, runtime);
  expect(result).toBe(false);
});
```

- [ ] **Step 1.6: Run tests to verify they pass**

Run: `npm test -- tests/unit/transport.test.ts -t "receiverNeedsUpdate"`
Expected: PASS

- [ ] **Step 1.7: Commit**

```bash
git add src/core/transport.ts tests/unit/transport.test.ts
git commit -m "$(cat <<'EOF'
feat(transport): add hash-based receiver deployment check

- Add receiverNeedsUpdate() to compare local/remote receiver MD5 hash
- Only redeploy receiver files when hash differs or file missing
- Always push receiver_config.json (remote_agents may change)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `listRemoteSkills()` to transport.ts

**Files:**
- Modify: `src/core/transport.ts`
- Test: `tests/unit/transport.test.ts`

- [ ] **Step 2.1: Write the failing test**

```typescript
// Add to tests/unit/transport.test.ts
describe('listRemoteSkills', () => {
  const mockServer: ConfiguredServer = {
    name: 'test-server',
    host: 'example.com',
    user: 'testuser'
  };

  it('returns skill names from remote skills directory', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        // Simulates `ls ~/.syncskill/skills/`
        if (args.some(a => a.includes('ls'))) {
          return { stdout: 'skill-a\nskill-b\nskill-c\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await listRemoteSkills(mockServer, runtime);
    expect(result).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('returns empty array when directory is empty or missing', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        if (args.some(a => a.includes('ls'))) {
          throw new Error('No such file or directory');
        }
        return { stdout: '', stderr: '' };
      }
    };

    const result = await listRemoteSkills(mockServer, runtime);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npm test -- tests/unit/transport.test.ts -t "listRemoteSkills"`
Expected: FAIL

- [ ] **Step 2.3: Implement listRemoteSkills**

Add to `src/core/transport.ts`:

```typescript
export async function listRemoteSkills(server: ConfiguredServer, runtime: TransportRuntime): Promise<string[]> {
  try {
    const result = await runtime.exec('ssh', buildSshArgs(server, ['ls', REMOTE_SKILLS_DIR]));
    return result.stdout
      .trim()
      .split('\n')
      .filter(name => name.length > 0)
      .sort();
  } catch {
    // Directory doesn't exist or is empty
    return [];
  }
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `npm test -- tests/unit/transport.test.ts -t "listRemoteSkills"`
Expected: PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/core/transport.ts tests/unit/transport.test.ts
git commit -m "$(cat <<'EOF'
feat(transport): add listRemoteSkills for remote directory listing

- Add listRemoteSkills() to get skill names from remote ~/.syncskill/skills/
- Returns empty array if directory missing or empty

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `deleteRemoteSkills()` to transport.ts

**Files:**
- Modify: `src/core/transport.ts`
- Test: `tests/unit/transport.test.ts`

- [ ] **Step 3.1: Write the failing test**

```typescript
// Add to tests/unit/transport.test.ts
describe('deleteRemoteSkills', () => {
  const mockServer: ConfiguredServer = {
    name: 'test-server',
    host: 'example.com',
    user: 'testuser'
  };

  it('deletes specified skills from remote', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    };

    await deleteRemoteSkills(mockServer, ['skill-a', 'skill-b'], runtime);

    // Verify rm -rf was called for each skill
    const rmCalls = runtime.calls?.filter(c => 
      c.args.some(a => a.includes('rm'))
    ) ?? [];
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0].args.join(' ')).toContain('skill-a');
    expect(rmCalls[0].args.join(' ')).toContain('skill-b');
  });

  it('does nothing when skill list is empty', async () => {
    const runtime: TransportRuntime = {
      calls: [],
      async exec(file, args) {
        this.calls?.push({ file, args });
        return { stdout: '', stderr: '' };
      }
    };

    await deleteRemoteSkills(mockServer, [], runtime);
    expect(runtime.calls?.length).toBe(0);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `npm test -- tests/unit/transport.test.ts -t "deleteRemoteSkills"`
Expected: FAIL

- [ ] **Step 3.3: Implement deleteRemoteSkills**

Add to `src/core/transport.ts`:

```typescript
export async function deleteRemoteSkills(
  server: ConfiguredServer,
  skills: string[],
  runtime: TransportRuntime
): Promise<void> {
  if (skills.length === 0) {
    return;
  }

  // Delete all skills in one command
  const paths = skills.map(skill => `${REMOTE_SKILLS_DIR}/${skill}`);
  await runtime.exec('ssh', buildSshArgs(server, ['rm', '-rf', ...paths]));
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `npm test -- tests/unit/transport.test.ts -t "deleteRemoteSkills"`
Expected: PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/core/transport.ts tests/unit/transport.test.ts
git commit -m "$(cat <<'EOF'
feat(transport): add deleteRemoteSkills for cleanup

- Add deleteRemoteSkills() to remove skills from remote server
- Single SSH call with rm -rf for efficiency

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add remote-change warning to push flow

**Files:**
- Modify: `src/core/sync_engine.ts`
- Test: `tests/integration/sync-engine.test.ts`

- [ ] **Step 4.1: Write the failing test**

```typescript
// Add to tests/integration/sync-engine.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('pushToServers remote-change warnings', () => {
  it('prints warning for skills with direction=pull', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    
    // Setup mock that returns a manifest with a skill that has direction=pull
    // ... test setup ...

    // After push completes, verify warning was printed
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('remote has changes')
    );

    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "remote-change warnings"`
Expected: FAIL (warning not printed)

- [ ] **Step 4.3: Add remote-change warning to pushToServers**

Modify `pushToServers` in `src/core/sync_engine.ts`, add after line that checks for conflicts:

```typescript
// Add after: const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
const pullSkills = listSkillsByDirection(manifest, 'pull');

// Print warnings for skills that have remote changes
for (const skill of pullSkills) {
  console.log(`  Skipping ${skill}: remote has changes. Use \`syncskill pull\` to update local.`);
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "remote-change warnings"`
Expected: PASS

- [ ] **Step 4.5: Commit**

```bash
git add src/core/sync_engine.ts tests/integration/sync-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): add warning for remote-changed skills during push

- Print warning for each skill with direction=pull during push
- No implicit pull - user must run syncskill pull explicitly

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add --no-refresh safety net verification

**Files:**
- Modify: `src/core/sync_engine.ts`
- Modify: `src/index.ts` (pass noRefresh flag)
- Test: `tests/integration/sync-engine.test.ts`

- [ ] **Step 5.1: Update SyncEngineOptions type**

Add to `src/core/sync_engine.ts`:

```typescript
export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
  noRefresh?: boolean;  // Add this field
}
```

- [ ] **Step 5.2: Write the failing test**

```typescript
// Add to tests/integration/sync-engine.test.ts
describe('pushToServers --no-refresh safety net', () => {
  it('forces push for skip skills that are missing remotely when noRefresh=true', async () => {
    // Mock: manifest says skill-a is in-sync (skip)
    // Mock: listRemoteSkills returns [] (skill-a missing remotely)
    // Expected: skill-a should be pushed anyway

    const result = await pushToServers(homeDir, ['test-server'], {
      noRefresh: true,
      runtime: mockRuntime
    });

    expect(result[0].pushed_skills).toContain('skill-a');
  });

  it('does not verify remote when noRefresh=false', async () => {
    // Normal flow should not call listRemoteSkills for verification
    const result = await pushToServers(homeDir, ['test-server'], {
      noRefresh: false,
      runtime: mockRuntime
    });

    // listRemoteSkills should not be called for verification
    const lsCalls = mockRuntime.calls?.filter(c => 
      c.args.includes('ls') && c.args.some(a => a.includes('skills'))
    ) ?? [];
    expect(lsCalls.length).toBe(0);
  });
});
```

- [ ] **Step 5.3: Run test to verify it fails**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "no-refresh safety"`
Expected: FAIL

- [ ] **Step 5.4: Implement --no-refresh safety net in pushToServers**

Add verification logic to `pushToServers` in `src/core/sync_engine.ts`:

```typescript
// Add import at top
import { listRemoteSkills, deleteRemoteSkills } from './transport.js';

// Inside pushToServers, after computing delta, before pushing:
// Safety net: verify remote skills exist when --no-refresh is used
if (options.noRefresh) {
  const remoteSkillList = await listRemoteSkills(server, runtime);
  const remoteSkillSet = new Set(remoteSkillList);
  
  // Find skills marked as skip but missing remotely
  const skipSkills = listSkillsByDirection(manifest, 'skip');
  const missingRemotely = skipSkills.filter(skill => 
    manifest.skills[skill]?.local_hash !== null && !remoteSkillSet.has(skill)
  );
  
  if (missingRemotely.length > 0) {
    console.log(`  Safety net: ${missingRemotely.length} skill(s) missing remotely, forcing push`);
    // Force these to push by updating manifest direction
    for (const skill of missingRemotely) {
      if (manifest.skills[skill]) {
        manifest.skills[skill].direction = 'push';
        manifest.skills[skill].status = 'local-changed';
      }
    }
    // Re-compute pushed skills list
    pushedSkills = listSkillsByDirection(manifest, 'push');
  }
}
```

- [ ] **Step 5.5: Pass noRefresh flag from CLI**

Modify push command in `src/index.ts` to pass the flag:

```typescript
// In push command action handler, add noRefresh to options
const results = await pushToServers(homeDir, serverNames, {
  dryRun: options.dryRun,
  noRefresh: options.noRefresh ?? program.opts().noRefresh
});
```

- [ ] **Step 5.6: Run tests to verify they pass**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "no-refresh safety"`
Expected: PASS

- [ ] **Step 5.7: Commit**

```bash
git add src/core/sync_engine.ts src/index.ts tests/integration/sync-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): add --no-refresh safety net for missing remote skills

- When --no-refresh is used, verify remote skills directory
- Force push for skills marked skip but missing remotely
- Normal flow with refresh already handles this via refreshRemoteManifest

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add remote skill cleanup with confirmation

**Files:**
- Modify: `src/core/sync_engine.ts`
- Test: `tests/integration/sync-engine.test.ts`

- [ ] **Step 6.1: Add yes option to SyncEngineOptions**

Update type in `src/core/sync_engine.ts`:

```typescript
export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
  noRefresh?: boolean;
  yes?: boolean;  // Add this for auto-confirm
}
```

- [ ] **Step 6.2: Write the failing test**

```typescript
// Add to tests/integration/sync-engine.test.ts
describe('pushToServers remote cleanup', () => {
  it('identifies remote skills not in include list for cleanup', async () => {
    // Mock: remote has skill-orphan, local include list only has skill-a
    // Expected: skill-orphan should be identified for deletion

    const consoleSpy = vi.spyOn(console, 'log');
    
    // With yes=false and no stdin, should skip cleanup
    const result = await pushToServers(homeDir, ['test-server'], {
      runtime: mockRuntime,
      yes: false
    });

    // Should log about skills to remove
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('skill-orphan')
    );

    consoleSpy.mockRestore();
  });

  it('deletes remote orphan skills when yes=true', async () => {
    const result = await pushToServers(homeDir, ['test-server'], {
      runtime: mockRuntime,
      yes: true
    });

    // Verify deleteRemoteSkills was called
    const rmCalls = mockRuntime.calls?.filter(c => 
      c.args.some(a => a.includes('rm'))
    ) ?? [];
    expect(rmCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6.3: Run test to verify it fails**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "remote cleanup"`
Expected: FAIL

- [ ] **Step 6.4: Implement remote cleanup logic**

Add to `pushToServers` in `src/core/sync_engine.ts`:

```typescript
// Add import at top
import { confirm } from '@inquirer/prompts';

// Inside pushToServers, after pushing skills but before finalizing manifest:
// Cleanup: remove remote skills not in current include list
const remoteSkillList = options.noRefresh 
  ? remoteSkillList  // Already fetched above
  : await listRemoteSkills(server, runtime);

const localSkillSet = new Set(Object.keys(manifest.skills).filter(
  skill => manifest.skills[skill]?.local_hash !== null
));
const orphanSkills = remoteSkillList.filter(skill => !localSkillSet.has(skill));

if (orphanSkills.length > 0 && !options.dryRun) {
  console.log(`\nRemote skills to remove (no longer in local config):`);
  for (const skill of orphanSkills) {
    console.log(`  - ${skill}`);
  }

  let shouldDelete = options.yes ?? false;
  if (!shouldDelete) {
    try {
      shouldDelete = await confirm({
        message: `Remove ${orphanSkills.length} remote skill(s)?`,
        default: false
      });
    } catch {
      // User cancelled or non-interactive
      shouldDelete = false;
    }
  }

  if (shouldDelete) {
    await deleteRemoteSkills(server, orphanSkills, runtime);
    console.log(`  Removed ${orphanSkills.length} remote skill(s)`);
  } else {
    console.log(`  Skipped remote cleanup`);
  }
}
```

- [ ] **Step 6.5: Run tests to verify they pass**

Run: `npm test -- tests/integration/sync-engine.test.ts -t "remote cleanup"`
Expected: PASS

- [ ] **Step 6.6: Commit**

```bash
git add src/core/sync_engine.ts tests/integration/sync-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): add remote skill cleanup with confirmation

- Detect remote skills not in local include list
- Prompt for confirmation before deletion (unless -y/--yes)
- Skip cleanup in dry-run mode

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update documentation - config-guide.md

**Files:**
- Modify: `docs/config-guide.md`

- [ ] **Step 7.1: Update manifest format section**

Find the manifest format section and update to show 3-field model:

```markdown
## Manifest Format (3-field model)

Each server manifest (`~/.syncskill/manifests/<server>.json`) tracks sync state:

```json
{
  "version": 1,
  "server": "server-name",
  "updated_at": "2026-05-15T00:00:00Z",
  "skills": {
    "skill-name": {
      "local_hash": "abc123...",
      "remote_hash": "def456...",
      "recorded_hash": "abc123...",
      "direction": "push",
      "status": "in-sync"
    }
  }
}
```

**3-field model explanation:**
- `local_hash`: Current local file hash (recomputed on each refresh)
- `remote_hash`: Last known remote hash (fetched from remote manifest)
- `recorded_hash`: Baseline hash from last sync point (set after push/pull completes)

The `recorded_hash` serves as a 3-way merge base:
- `local_hash ≠ recorded_hash` → Local changed since last sync
- `remote_hash ≠ recorded_hash` → Remote changed since last sync
- Both differ → Conflict

This design handles external operations (like `git checkout`) correctly: even if local files are reverted, `recorded_hash` remains unchanged, so the system detects the local change.
```

- [ ] **Step 7.2: Verify the edit**

Run: `grep -A 20 "3-field" docs/config-guide.md`
Expected: Shows the new 3-field model documentation

- [ ] **Step 7.3: Commit**

```bash
git add docs/config-guide.md
git commit -m "$(cat <<'EOF'
docs(config): document 3-field manifest model

- Add detailed explanation of local_hash, remote_hash, recorded_hash
- Explain 3-way merge base concept
- Document how external operations are handled

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update documentation - design-guide.md

**Files:**
- Modify: `docs/design-guide.md`

- [ ] **Step 8.1: Read current design-guide.md**

Check current content to determine where to add push flow documentation.

- [ ] **Step 8.2: Add/update push flow section**

Add or update the push flow section:

```markdown
## Push Flow

The push operation follows these steps:

1. **Receiver deployment** (hash-based): Compare local `sync_receiver.mjs` MD5 hash with remote. Only redeploy if hash differs or file missing.
2. **Push receiver config**: Always push `receiver_config.json` (remote_agents may change).
3. **Compute local hashes**: Calculate MD5 for each skill directory.
4. **Fetch remote manifest**: Get current remote state.
5. **Compute delta**: Compare using 3-field model (local_hash, remote_hash, recorded_hash).
6. **Detect conflicts**: Mark skills where both local and remote changed.
7. **Safety net** (--no-refresh only): Verify remote skills directory. Force push for skills marked "skip" but missing remotely.
8. **Remote cleanup**: Identify and optionally delete remote skills not in local include list. Requires user confirmation unless `-y`.
9. **Push skills**: rsync each skill marked for push.
10. **Warn about remote changes**: Print warning for skills with remote changes (direction=pull). No implicit pull.
11. **Update manifest**: Set `remote_hash=local_hash, recorded_hash=local_hash` for pushed skills.
12. **Push manifest**: Send updated manifest to remote.
13. **Apply**: Execute `sync_receiver.mjs apply` to create/clean agent symlinks.
```

- [ ] **Step 8.3: Commit**

```bash
git add docs/design-guide.md
git commit -m "$(cat <<'EOF'
docs(design): document enhanced push flow

- Add complete push flow with all 13 steps
- Document hash-based receiver deployment
- Document --no-refresh safety net
- Document remote cleanup with confirmation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 9.1: Run unit tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9.2: Run integration tests**

Run: `npm run test:integration`
Expected: All tests pass

- [ ] **Step 9.3: Build and verify CLI**

Run: `npm run build && node dist/index.js --help`
Expected: Build succeeds, help displays correctly

- [ ] **Step 9.4: Manual smoke test**

```bash
# Test push dry-run to see new behaviors
node dist/index.js push --dry-run
```

- [ ] **Step 9.5: Final commit if any fixes needed**

If any fixes were needed during verification, commit them.

---

## Summary

This plan implements 4 key enhancements from spec commit bea60c27:

1. **Hash-based receiver deployment** (Task 1): Only redeploy `sync_receiver.mjs` when MD5 hash differs
2. **Remote directory listing** (Tasks 2-3): Add `listRemoteSkills()` and `deleteRemoteSkills()`
3. **Remote-change warnings** (Task 4): Warn about skills with remote changes during push
4. **--no-refresh safety net** (Task 5): Verify remote skills exist when skipping refresh
5. **Remote cleanup** (Task 6): Delete orphan remote skills with confirmation
6. **Documentation** (Tasks 7-8): Update config-guide.md and design-guide.md
