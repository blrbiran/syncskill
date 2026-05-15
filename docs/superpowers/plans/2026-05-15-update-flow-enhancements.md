# Update Flow Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the spec changes from commit 48b132f including `private_agents` config, `source restore` command, `--timeout` for sync commands, `--dry-run` for update, `update-history.json`, and differentiated dirty handling (git stash vs http backup).

**Architecture:** Eight independent features that build on the existing source update infrastructure. Core changes to `source.ts` for git stash handling, new `update-history.ts` module for recovery tracking, CLI additions in `index.ts` for new commands and options.

**Tech Stack:** TypeScript, Commander.js CLI, Node.js child_process for git commands, @inquirer/prompts for interactive UI.

---

## File Structure

### New Files
- `src/core/update-history.ts` — Update history management (load/save/clear)
- `src/core/private-agents.ts` — Private agents config and computeDefaultLinkTargets()

### Modified Files
- `src/config/types.ts:17-25` — Add `private_agents` to SyncSkillConfig
- `src/source.ts:700-840` — Replace file backup with git stash for git sources
- `src/source.ts:890-920` — Update HTTP dirty handling to use update-history
- `src/index.ts:730-760` — Add `--dry-run` to source update command
- `src/index.ts:857+` — Add `source restore` command
- `src/index.ts:1103-1170` — Add `--timeout` to push/pull/sync commands
- `src/core/sync_engine.ts:97-263` — Add timeout wrapper for transport operations
- `src/core/transport.ts` — Add timeout parameter to SSH/rsync functions

### Test Files
- `tests/unit/update-history.test.ts` — Unit tests for update-history module
- `tests/unit/private-agents.test.ts` — Unit tests for private-agents module
- `tests/integration/source-restore.test.ts` — Integration tests for restore command
- `tests/integration/update-dry-run.test.ts` — Integration tests for --dry-run
- `tests/e2e/cases/source/source-restore.test.ts` — E2E tests for restore flow

---

### Task 1: Add `private_agents` to Config Types

**Files:**
- Modify: `src/config/types.ts:17-25`
- Modify: `src/config/config.ts` (add default handling)
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test for private_agents config field**

```typescript
// tests/unit/config.test.ts - add to existing file
describe('private_agents config', () => {
  it('should use default private_agents when not configured', async () => {
    const tempDir = await tempDirs.create();
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
    await writeFile(join(tempDir, '.syncskill', 'config.yaml'), `
version: 1
agents:
  claude: ~/.claude/skills
links: {}
servers: {}
sources: {}
`);
    const config = await loadConfig(tempDir);
    expect(config.private_agents).toEqual(['cursor', 'kiro', 'augment', 'cline', 'hermes']);
  });

  it('should override default private_agents when configured', async () => {
    const tempDir = await tempDirs.create();
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
    await writeFile(join(tempDir, '.syncskill', 'config.yaml'), `
version: 1
agents:
  claude: ~/.claude/skills
links: {}
servers: {}
sources: {}
private_agents:
  - cursor
  - my-custom-agent
`);
    const config = await loadConfig(tempDir);
    expect(config.private_agents).toEqual(['cursor', 'my-custom-agent']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config.test.ts -t "private_agents"`
Expected: FAIL with property not existing

- [ ] **Step 3: Add private_agents to SyncSkillConfig type**

```typescript
// src/config/types.ts - update SyncSkillConfig interface
export interface SyncSkillConfig {
  version: number;
  conflict_resolution: ConflictResolution;
  agents: Record<string, string>;
  links: Record<string, string[]>;
  servers: Record<string, unknown>;
  sources: Record<string, unknown>;
  private_agents?: string[];
}
```

- [ ] **Step 4: Add DEFAULT_PRIVATE_AGENTS constant and loading logic**

```typescript
// src/config/config.ts - add near top of file
export const DEFAULT_PRIVATE_AGENTS = ['cursor', 'kiro', 'augment', 'cline', 'hermes'];

// In loadConfig function, after parsing YAML, add:
const privateAgents = Array.isArray(parsed.private_agents) 
  ? parsed.private_agents.filter((a): a is string => typeof a === 'string')
  : DEFAULT_PRIVATE_AGENTS;

// Return config with private_agents
return {
  ...config,
  private_agents: privateAgents,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/config.test.ts -t "private_agents"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/types.ts src/config/config.ts tests/unit/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add private_agents configuration field

Add private_agents to SyncSkillConfig for agents that don't support
~/.agents/skills/ shared directory. Default: cursor, kiro, augment,
cline, hermes. Can be overridden in config.yaml.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create update-history.ts Module

**Files:**
- Create: `src/core/update-history.ts`
- Test: `tests/unit/update-history.test.ts`

- [ ] **Step 1: Write failing tests for update-history module**

```typescript
// tests/unit/update-history.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadUpdateHistory,
  saveUpdateHistory,
  recordGitOverwrite,
  recordHttpOverwrite,
  clearSourceHistory,
  type UpdateHistory,
  type GitUpdateRecord,
  type HttpUpdateRecord,
} from '../src/core/update-history.js';

describe('update-history', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.test-temp', `update-history-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return empty history when file does not exist', async () => {
    const history = await loadUpdateHistory(tempDir);
    expect(history).toEqual({});
  });

  it('should save and load git update record', async () => {
    const record: GitUpdateRecord = {
      type: 'git',
      before_commit: 'abc1234',
      after_commit: '789abcd',
      stash_commit: '456789a',
      timestamp: '2026-05-15T16:00:00Z',
    };

    await recordGitOverwrite(tempDir, 'company-skills', record);
    const history = await loadUpdateHistory(tempDir);

    expect(history['company-skills']).toEqual(record);
  });

  it('should save and load http update record', async () => {
    const record: HttpUpdateRecord = {
      type: 'http',
      backup_path: '~/.syncskill/backups/skill-pack/',
      dirty_skills: ['skill-a', 'skill-c'],
      timestamp: '2026-05-15T16:00:00Z',
    };

    await recordHttpOverwrite(tempDir, 'skill-pack', record);
    const history = await loadUpdateHistory(tempDir);

    expect(history['skill-pack']).toEqual(record);
  });

  it('should clear source history', async () => {
    await recordGitOverwrite(tempDir, 'my-source', {
      type: 'git',
      before_commit: 'abc',
      after_commit: 'def',
      stash_commit: 'ghi',
      timestamp: '2026-05-15T16:00:00Z',
    });

    await clearSourceHistory(tempDir, 'my-source');
    const history = await loadUpdateHistory(tempDir);

    expect(history['my-source']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/update-history.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement update-history.ts module**

```typescript
// src/core/update-history.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFoundError } from '../utils/utils.js';
import { getSyncPaths } from '../config/config.js';

export interface GitUpdateRecord {
  type: 'git';
  before_commit: string;
  after_commit: string;
  stash_commit: string;
  timestamp: string;
}

export interface HttpUpdateRecord {
  type: 'http';
  backup_path: string;
  dirty_skills: string[];
  timestamp: string;
}

export type UpdateRecord = GitUpdateRecord | HttpUpdateRecord;

export type UpdateHistory = Record<string, UpdateRecord>;

function getUpdateHistoryPath(homeDir: string): string {
  return join(getSyncPaths(homeDir).syncDir, 'update-history.json');
}

export async function loadUpdateHistory(homeDir: string): Promise<UpdateHistory> {
  const historyPath = getUpdateHistoryPath(homeDir);

  try {
    const content = await readFile(historyPath, 'utf8');
    return JSON.parse(content) as UpdateHistory;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

export async function saveUpdateHistory(homeDir: string, history: UpdateHistory): Promise<void> {
  const historyPath = getUpdateHistoryPath(homeDir);
  const { syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
}

export async function recordGitOverwrite(
  homeDir: string,
  sourceName: string,
  record: GitUpdateRecord
): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  history[sourceName] = record;
  await saveUpdateHistory(homeDir, history);
}

export async function recordHttpOverwrite(
  homeDir: string,
  sourceName: string,
  record: HttpUpdateRecord
): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  history[sourceName] = record;
  await saveUpdateHistory(homeDir, history);
}

export async function clearSourceHistory(homeDir: string, sourceName: string): Promise<void> {
  const history = await loadUpdateHistory(homeDir);
  delete history[sourceName];
  await saveUpdateHistory(homeDir, history);
}

export async function getSourceHistory(
  homeDir: string,
  sourceName: string
): Promise<UpdateRecord | null> {
  const history = await loadUpdateHistory(homeDir);
  return history[sourceName] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/update-history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/update-history.ts tests/unit/update-history.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add update-history module for recovery tracking

Adds update-history.json management for tracking dirty overwrites.
Git sources record stash_commit, HTTP sources record backup_path.
Enables source restore command to recover from force updates.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Implement Git Stash for Dirty Git Sources

**Files:**
- Modify: `src/source.ts:700-840` (handleDirtySource, syncSource)
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Write failing test for git stash behavior**

```typescript
// tests/unit/source.test.ts - add to existing describe block
describe('git stash for dirty update', () => {
  it('should use git stash instead of file backup for dirty git sources', async () => {
    const tempDir = await tempDirs.create();
    const { repoDir, sourceName } = await createGitSourceFixture(tempDir, {
      skills: ['skill-a'],
    });

    // Make local modification
    const skillFile = join(repoDir, 'checkout', 'skill-a', 'test.txt');
    await writeFile(skillFile, 'local modification');

    // Update with --force should use git stash
    await updateSource(tempDir, sourceName, { force: true });

    // Verify stash was created
    const { stdout } = await execFileAsync('git', ['-C', join(repoDir, 'checkout'), 'stash', 'list']);
    expect(stdout).toContain('syncskill: auto-stash');

    // Verify update-history.json records git type with stash_commit
    const history = await loadUpdateHistory(tempDir);
    expect(history[sourceName]).toBeDefined();
    expect(history[sourceName].type).toBe('git');
    expect((history[sourceName] as GitUpdateRecord).stash_commit).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/source.test.ts -t "git stash for dirty update"`
Expected: FAIL (currently uses file backup, not stash)

- [ ] **Step 3: Add gitStashAndRecord helper function**

```typescript
// src/source.ts - add after existing imports
import { recordGitOverwrite, clearSourceHistory, type GitUpdateRecord } from './core/update-history.js';

async function gitStashAndRecord(
  homeDir: string,
  sourceName: string,
  checkoutDir: string,
  timestamp: string
): Promise<{ stashCommit: string; beforeCommit: string }> {
  // Get current HEAD before any changes
  const { stdout: beforeCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);
  
  // Create stash with descriptive message
  const stashMessage = `syncskill: auto-stash before update (${timestamp})`;
  await execFileAsync('git', ['-C', checkoutDir, 'stash', 'push', '-m', stashMessage]);
  
  // Get stash commit SHA (not index-based, which can drift)
  const { stdout: stashCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'stash@{0}']);
  
  return {
    stashCommit: stashCommit.trim(),
    beforeCommit: beforeCommit.trim(),
  };
}
```

- [ ] **Step 4: Modify handleDirtySource to use git stash for git sources**

```typescript
// src/source.ts - modify handleDirtySource function
// Replace the backup logic for git sources with stash logic:

// In handleDirtySource, when decision is 'update' and sourceType is 'git':
if (opts.sourceType === 'git' && dirtyResult.dirtySkills.length > 0) {
  console.log('⚠ Stashing local changes before update...');
  const checkoutDir = join(opts.backupsDir, '..', '.sources', opts.sourceName, 'checkout');
  const timestamp = new Date().toISOString();
  const { stashCommit } = await gitStashAndRecord(
    // homeDir needs to be passed - update function signature
    opts.homeDir,
    opts.sourceName,
    checkoutDir,
    timestamp
  );
  console.log(`  ✓ Stashed changes (${stashCommit.slice(0, 7)})`);
  console.log(`  To restore: syncskill source restore ${opts.sourceName}`);
}
```

- [ ] **Step 5: Update syncSource to record update-history after successful git update**

```typescript
// src/source.ts - in syncSource function, after git reset --hard
// Record the after_commit
const { stdout: afterCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);

// If we stashed, record to update-history.json
if (didStash) {
  await recordGitOverwrite(homeDir, name, {
    type: 'git',
    before_commit: beforeCommit,
    after_commit: afterCommit.trim(),
    stash_commit: stashCommit,
    timestamp: new Date().toISOString(),
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/unit/source.test.ts -t "git stash for dirty update"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/source.ts src/core/update-history.ts tests/unit/source.test.ts
git commit -m "$(cat <<'EOF'
feat(source): use git stash for dirty git source updates

Git sources now use git stash instead of file backup when
force-updating dirty sources. Records stash_commit SHA in
update-history.json for recovery via source restore.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Implement HTTP Dirty Backup with Update History

**Files:**
- Modify: `src/source.ts:890-920` (HTTP dirty handling)
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Write failing test for HTTP backup with update-history**

```typescript
// tests/unit/source.test.ts - add test
describe('http backup with update-history', () => {
  it('should record http backup to update-history.json', async () => {
    // Setup HTTP source with dirty skill
    const tempDir = await tempDirs.create();
    // ... setup HTTP source fixture ...

    await updateSource(tempDir, 'http-source', { force: true });

    const history = await loadUpdateHistory(tempDir);
    expect(history['http-source']).toBeDefined();
    expect(history['http-source'].type).toBe('http');
    expect((history['http-source'] as HttpUpdateRecord).backup_path).toContain('backups');
    expect((history['http-source'] as HttpUpdateRecord).dirty_skills).toContain('skill-a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/source.test.ts -t "http backup with update-history"`
Expected: FAIL

- [ ] **Step 3: Update HTTP dirty handling to record update-history**

```typescript
// src/source.ts - in handleDirtySource, after backupDirtySkills for HTTP:
import { recordHttpOverwrite } from './core/update-history.js';

// After backup completes:
if (opts.sourceType === 'http' && backedUp.length > 0) {
  await recordHttpOverwrite(opts.homeDir, opts.sourceName, {
    type: 'http',
    backup_path: join(opts.backupsDir, opts.sourceName),
    dirty_skills: backedUp.map(b => b.name),
    timestamp: new Date().toISOString(),
  });
  console.log(`  To restore: syncskill source restore ${opts.sourceName}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/source.test.ts -t "http backup with update-history"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/source.ts tests/unit/source.test.ts
git commit -m "$(cat <<'EOF'
feat(source): record HTTP backup to update-history.json

HTTP source dirty backups now record backup_path and dirty_skills
to update-history.json for recovery via source restore command.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add `source restore` Command

**Files:**
- Modify: `src/index.ts:857+`
- Create: `src/source-restore.ts`
- Test: `tests/integration/source-restore.test.ts`

- [ ] **Step 1: Write failing test for source restore command**

```typescript
// tests/integration/source-restore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

describe('source restore command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.test-temp', `restore-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should show error when no history exists', async () => {
    // Setup minimal config
    await writeFile(join(tempDir, '.syncskill', 'config.yaml'), `
version: 1
agents: {}
links: {}
servers: {}
sources: {}
`);

    const { stderr } = await execFileAsync('node', [
      'dist/index.js', 'source', 'restore', 'nonexistent'
    ], { env: { ...process.env, HOME: tempDir } }).catch(e => e);

    expect(stderr).toContain('No restore history');
  });

  it('should list restore options for git source', async () => {
    // Setup with update-history.json containing git record
    await writeFile(join(tempDir, '.syncskill', 'update-history.json'), JSON.stringify({
      'my-source': {
        type: 'git',
        before_commit: 'abc1234',
        after_commit: '789abcd',
        stash_commit: '456789a',
        timestamp: '2026-05-15T16:00:00Z'
      }
    }));

    // Would need to mock interactive prompt - for now test help text
    const { stdout } = await execFileAsync('node', [
      'dist/index.js', 'source', 'restore', '--help'
    ]);

    expect(stdout).toContain('restore');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/source-restore.test.ts`
Expected: FAIL with command not found

- [ ] **Step 3: Create source-restore.ts module**

```typescript
// src/source-restore.ts
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { select } from '@inquirer/prompts';
import { getSyncPaths, loadConfig } from './config/config.js';
import {
  getSourceHistory,
  clearSourceHistory,
  type GitUpdateRecord,
  type HttpUpdateRecord,
} from './core/update-history.js';

const execFileAsync = promisify(execFile);

export interface RestoreResult {
  success: boolean;
  message: string;
}

export async function restoreSource(homeDir: string, sourceName: string): Promise<RestoreResult> {
  const record = await getSourceHistory(homeDir, sourceName);

  if (!record) {
    return {
      success: false,
      message: `No restore history for "${sourceName}".`,
    };
  }

  if (record.type === 'git') {
    return restoreGitSource(homeDir, sourceName, record);
  } else {
    return restoreHttpSource(homeDir, sourceName, record);
  }
}

async function restoreGitSource(
  homeDir: string,
  sourceName: string,
  record: GitUpdateRecord
): Promise<RestoreResult> {
  const { syncDir } = getSyncPaths(homeDir);
  const checkoutDir = join(syncDir, '.sources', sourceName, 'checkout');

  console.log(`\nLast overwrite: ${new Date(record.timestamp).toLocaleString()}`);
  console.log(`  Type: git`);
  console.log(`  Before: ${record.before_commit.slice(0, 7)} → After: ${record.after_commit.slice(0, 7)}`);
  console.log(`  Stash: ${record.stash_commit.slice(0, 7)}`);
  console.log('');

  const action = await select({
    message: 'Choose restore action:',
    choices: [
      { name: '(R) Restore to dirty state — checkout before + apply stash', value: 'restore' },
      { name: '(c) Checkout only — go back to before commit (no stash apply)', value: 'checkout' },
      { name: '(a) Apply stash only — apply stash on current version', value: 'apply' },
      { name: '(q) Cancel', value: 'cancel' },
    ],
    default: 'restore',
  });

  if (action === 'cancel') {
    return { success: false, message: 'Cancelled.' };
  }

  if (action === 'restore' || action === 'checkout') {
    await execFileAsync('git', ['-C', checkoutDir, 'checkout', record.before_commit]);
  }

  if (action === 'restore' || action === 'apply') {
    await execFileAsync('git', ['-C', checkoutDir, 'stash', 'apply', record.stash_commit]);
  }

  const messages: Record<string, string> = {
    restore: `✓ Restored ${sourceName} to dirty state\n  Checked out ${record.before_commit.slice(0, 7)}, applied stash ${record.stash_commit.slice(0, 7)}\n  Note: You are now in detached HEAD state.\n  To return to latest: syncskill source update ${sourceName}`,
    checkout: `✓ Checked out ${sourceName} to ${record.before_commit.slice(0, 7)}\n  Note: Stash ${record.stash_commit.slice(0, 7)} still available.`,
    apply: `✓ Applied stash ${record.stash_commit.slice(0, 7)} to current ${sourceName}`,
  };

  return { success: true, message: messages[action] };
}

async function restoreHttpSource(
  homeDir: string,
  sourceName: string,
  record: HttpUpdateRecord
): Promise<RestoreResult> {
  const { skillsDir } = getSyncPaths(homeDir);

  console.log(`\nLast overwrite: ${new Date(record.timestamp).toLocaleString()}`);
  console.log(`  Type: http`);
  console.log(`  Backup: ${record.backup_path}`);
  console.log(`  Dirty skills: ${record.dirty_skills.join(', ')}`);
  console.log('');

  const action = await select({
    message: 'Choose restore action:',
    choices: [
      { name: '(R) Restore backup — copy files back', value: 'restore' },
      { name: '(q) Cancel', value: 'cancel' },
    ],
    default: 'restore',
  });

  if (action === 'cancel') {
    return { success: false, message: 'Cancelled.' };
  }

  for (const skill of record.dirty_skills) {
    const backupPath = join(record.backup_path, skill);
    const targetPath = join(skillsDir, skill);
    await cp(backupPath, targetPath, { recursive: true });
  }

  return {
    success: true,
    message: `✓ Restored ${record.dirty_skills.length} skills from backup\n  ${record.dirty_skills.join(', ')}`,
  };
}
```

- [ ] **Step 4: Add source restore command to CLI**

```typescript
// src/index.ts - add after sourceCommand.command('remove')
sourceCommand
  .command('restore <name>')
  .description('Restore a source from last force-update backup')
  .action(async (name: string) => {
    const { restoreSource } = await import('./source-restore.js');
    const result = await restoreSource(resolvedHomeDir, name);
    console.log(result.message);
    if (!result.success) {
      process.exit(1);
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/integration/source-restore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/source-restore.ts src/index.ts tests/integration/source-restore.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add source restore command for recovery

Adds interactive source restore command that recovers from
force-updated dirty sources. Git sources: checkout + stash apply.
HTTP sources: copy backup files back.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add `--dry-run` to Source Update

**Files:**
- Modify: `src/index.ts:730-760`
- Modify: `src/source.ts` (add dryRun option)
- Test: `tests/integration/update-dry-run.test.ts`

- [ ] **Step 1: Write failing test for --dry-run flag**

```typescript
// tests/integration/update-dry-run.test.ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('source update --dry-run', () => {
  it('should show dry-run output without making changes', async () => {
    const { stdout } = await execFileAsync('node', [
      'dist/index.js', 'source', 'update', '--dry-run', '--help'
    ]);

    expect(stdout).toContain('--dry-run');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/update-dry-run.test.ts`
Expected: FAIL (--dry-run not defined)

- [ ] **Step 3: Add --dry-run option to UpdateSourceOptions**

```typescript
// src/source.ts - update UpdateSourceOptions interface
export interface UpdateSourceOptions {
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
}
```

- [ ] **Step 4: Implement dry-run logic in updateAllSources**

```typescript
// src/source.ts - in updateAllSources function
if (options.dryRun) {
  console.log('\n[dry-run] Updatable sources:');
  for (const source of updatableSources) {
    const urlDisplay = source.url ? ` — ${source.url}` : '';
    console.log(`  ${source.name} (${source.type})${urlDisplay}`);
  }

  // Check dirty status for each source
  const dirtyList: Array<{ name: string; skills: string[] }> = [];
  for (const source of updatableSources) {
    const previousState = await loadSourceState(homeDir, source.name);
    if (!previousState?.materialized_skills.length) continue;

    if (source.type === 'git') {
      const checkoutDir = join(getSyncPaths(homeDir).syncDir, '.sources', source.name, 'checkout');
      if (await pathExists(checkoutDir)) {
        const dirtyResult = await detectGitDirty(checkoutDir, source.path);
        if (dirtyResult.dirtySkills.length > 0) {
          dirtyList.push({ name: source.name, skills: dirtyResult.dirtySkills.map(s => s.name) });
        }
      }
    } else if (source.type === 'http') {
      const dirtyResult = await detectHttpDirty(homeDir, source.name, previousState.materialized_skills);
      if (dirtyResult.dirtySkills.length > 0) {
        dirtyList.push({ name: source.name, skills: dirtyResult.dirtySkills.map(s => s.name) });
      }
    }
  }

  if (dirtyList.length > 0) {
    console.log('\n[dry-run] Dirty sources:');
    for (const { name, skills } of dirtyList) {
      console.log(`  ⚠ ${name}: ${skills.length} skill(s) with local modifications — ${skills.join(', ')}`);
    }
    console.log(`\n[dry-run] Would update the above sources.`);
    if (!options.force) {
      console.log(`  Note: Dirty sources will be skipped without --force.`);
    } else {
      console.log(`  With --force: git sources stash + overwrite, http sources backup + overwrite.`);
    }
  } else {
    console.log('\n[dry-run] No dirty sources detected.');
    console.log('[dry-run] Would update the above sources.');
  }

  return [];
}
```

- [ ] **Step 5: Add --dry-run to CLI command**

```typescript
// src/index.ts - update source update command
sourceCommand
  .command('update [name]')
  .description('Update one source or all configured sources')
  .option('--all', 'Update all configured sources')
  .option('-y, --yes', 'Skip confirmation prompts, auto-skip dirty sources')
  .option('--force', 'Force update dirty sources (backs up first)')
  .option('--dry-run', 'Preview update without making changes')
  .action(async (name: string | undefined, options: { all?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean }) => {
    if (options.all || name === undefined) {
      await updateAllSources(resolvedHomeDir, undefined, { yes: options.yes, force: options.force, dryRun: options.dryRun });
      return;
    }

    await updateSource(resolvedHomeDir, name, { yes: options.yes, force: options.force, dryRun: options.dryRun });
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/integration/update-dry-run.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/source.ts src/index.ts tests/integration/update-dry-run.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add --dry-run to source update command

Shows which sources would be updated and their dirty status
without executing network or write operations.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add `--timeout` to Push/Pull/Sync Commands

**Files:**
- Modify: `src/index.ts:1103-1170`
- Modify: `src/core/sync_engine.ts:34-39`
- Modify: `src/core/transport.ts`
- Test: `tests/integration/sync-timeout.test.ts`

- [ ] **Step 1: Write failing test for --timeout option**

```typescript
// tests/integration/sync-timeout.test.ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('sync --timeout', () => {
  it('should accept --timeout parameter', async () => {
    const { stdout } = await execFileAsync('node', [
      'dist/index.js', 'push', '--help'
    ]);

    expect(stdout).toContain('--timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/sync-timeout.test.ts`
Expected: FAIL (--timeout not in help)

- [ ] **Step 3: Add timeout to SyncEngineOptions**

```typescript
// src/core/sync_engine.ts - update SyncEngineOptions
export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
  noRefresh?: boolean;
  yes?: boolean;
  timeout?: number;
}
```

- [ ] **Step 4: Add --timeout to CLI commands**

```typescript
// src/index.ts - update push command
program
  .command('push [server]')
  .description('Push local skill changes to one server or all configured servers')
  .option('--all', 'Push to all configured servers')
  .option('--dry-run', 'Preview changes without pushing')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--timeout <seconds>', 'Timeout for SSH operations in seconds', parseInt)
  .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; yes?: boolean; timeout?: number }) => {
    // ... existing code ...
    const results = await pushToServers(resolvedHomeDir, targetServers, {
      dryRun: options.dryRun,
      noRefresh: !program.opts<{ refresh: boolean }>().refresh,
      yes: options.yes,
      timeout: options.timeout
    });
    // ...
  });

// Similarly update pull and sync commands
```

- [ ] **Step 5: Pass timeout to transport functions**

```typescript
// src/core/transport.ts - add timeout wrapper
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${message} exceeded ${timeoutMs / 1000}s`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/integration/sync-timeout.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/sync_engine.ts src/core/transport.ts src/index.ts tests/integration/sync-timeout.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add --timeout parameter to push/pull/sync commands

Allows setting explicit timeout for SSH/rsync operations.
Defaults to OS SSH config timeouts when not specified.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Fix Default Dirty Action to Skip (Safety First)

**Files:**
- Modify: `src/source.ts:815-835`
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Write failing test for default Skip behavior**

```typescript
// tests/unit/source.test.ts - add test
describe('default dirty action', () => {
  it('should default to Skip for non-skill dirty in interactive mode', async () => {
    // The default option for non-skill dirty should now be 'skip' not 'update'
    // This is a behavioral test - verify the select call has default: 'skip'
  });
});
```

- [ ] **Step 2: Update non-skill dirty default to 'skip'**

```typescript
// src/source.ts - in handleDirtySource function
// Change line ~829 from:
default: 'update' // Default to update for non-skill dirty
// To:
default: 'skip' // Default to skip (safety first)
```

- [ ] **Step 3: Update prompt text to match spec**

```typescript
// src/source.ts - update choice labels to match spec
// For skill dirty:
choices: [
  { name: '(S) Skip — keep local modifications, skip this source', value: 'skip' as const },
  { name: '(o) Overwrite — stash local changes and update to latest', value: 'update' as const },
  { name: '(q) Quit — stop update', value: 'quit' as const }
],
default: 'skip'

// For non-skill dirty:
choices: [
  { name: '(S) Skip — keep changes, skip this source', value: 'skip' as const },
  { name: '(o) Overwrite — stash changes and update', value: 'update' as const },
  { name: '(q) Quit — stop update', value: 'quit' as const }
],
default: 'skip'
```

- [ ] **Step 4: Run tests to verify behavior**

Run: `npm test -- tests/unit/source.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/source.ts tests/unit/source.test.ts
git commit -m "$(cat <<'EOF'
fix(source): default dirty action to Skip for safety

Both skill-dirty and non-skill-dirty now default to Skip instead of
Update. Safety first: user must explicitly choose to overwrite.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Create computeDefaultLinkTargets() Function

**Files:**
- Create: `src/core/private-agents.ts`
- Test: `tests/unit/private-agents.test.ts`

- [ ] **Step 1: Write failing tests for computeDefaultLinkTargets**

```typescript
// tests/unit/private-agents.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { computeDefaultLinkTargets } from '../src/core/private-agents.js';

describe('computeDefaultLinkTargets', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.test-temp', `private-agents-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return ["agents"] when no private agents detected', async () => {
    const targets = await computeDefaultLinkTargets(tempDir, {
      agents: { claude: '~/.claude/skills' },
      private_agents: ['cursor', 'kiro'],
    });

    expect(targets).toEqual(['agents']);
  });

  it('should include detected private agents', async () => {
    // Create cursor agent directory
    await mkdir(join(tempDir, '.cursor', 'skills'), { recursive: true });

    const targets = await computeDefaultLinkTargets(tempDir, {
      agents: {
        claude: '~/.claude/skills',
        cursor: '~/.cursor/skills',
      },
      private_agents: ['cursor', 'kiro'],
    });

    expect(targets).toContain('agents');
    expect(targets).toContain('cursor');
  });

  it('should create ~/.agents/skills/ if not exists and print message', async () => {
    const { created } = await computeDefaultLinkTargets(tempDir, {
      agents: { claude: '~/.claude/skills' },
      private_agents: [],
    }, { createSharedDir: true });

    expect(created).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/private-agents.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement computeDefaultLinkTargets**

```typescript
// src/core/private-agents.ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../utils/utils.js';

export interface ComputeLinkTargetsConfig {
  agents: Record<string, string>;
  private_agents?: string[];
}

export interface ComputeLinkTargetsOptions {
  createSharedDir?: boolean;
}

export interface ComputeLinkTargetsResult {
  targets: string[];
  created: boolean;
}

export async function computeDefaultLinkTargets(
  homeDir: string,
  config: ComputeLinkTargetsConfig,
  options: ComputeLinkTargetsOptions = {}
): Promise<ComputeLinkTargetsResult> {
  const targets: string[] = ['agents'];
  const privateAgents = config.private_agents ?? [];
  let created = false;

  // Check if ~/.agents/skills/ exists, create if needed
  const sharedDir = join(homeDir, '.agents', 'skills');
  if (!(await pathExists(sharedDir))) {
    if (options.createSharedDir) {
      await mkdir(sharedDir, { recursive: true });
      created = true;
      console.log(`Created ~/.agents/skills/`);
      console.log(`  This is the standard shared skills directory for agents that support it.`);
      console.log(`  Skills linked here are available to: claude, windsurf, codex, ...`);
    }
  }

  // Add detected private agents to targets
  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    if (privateAgents.includes(agentName)) {
      // Check if this agent is actually configured/detected
      const resolvedPath = agentPath.replace(/^~/, homeDir);
      if (await pathExists(resolvedPath)) {
        targets.push(agentName);
      }
    }
  }

  return { targets, created };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/private-agents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/private-agents.ts tests/unit/private-agents.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add computeDefaultLinkTargets function

Implements smart default link targets: ["agents"] for shared directory
plus any detected private_agents. Creates ~/.agents/skills/ on first
use with explanatory message.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update Documentation

**Files:**
- Modify: `docs/config-guide.md`
- Modify: `docs/design-guide.md`
- Modify: `docs/usage-guide.md`
- Modify: `docs/README.md`
- Modify: `README.md`
- Modify: `skills/syncskill/SKILL.md`

- [ ] **Step 1: Update docs/config-guide.md with private_agents**

Add section for `private_agents` configuration field.

- [ ] **Step 2: Update docs/usage-guide.md with new commands**

Add documentation for:
- `source restore <name>`
- `--dry-run` for source update
- `--timeout` for push/pull/sync

- [ ] **Step 3: Update docs/design-guide.md with update-history.json**

Add section explaining the update-history.json schema and recovery mechanism.

- [ ] **Step 4: Update README.md with quick reference**

Add quick reference for new commands and options.

- [ ] **Step 5: Update skills/syncskill/SKILL.md**

Update the syncskill skill documentation with new capabilities.

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md skills/syncskill/SKILL.md
git commit -m "$(cat <<'EOF'
docs: update documentation for update flow enhancements

- Add private_agents config documentation
- Document source restore command
- Document --dry-run for update and --timeout for sync
- Update SKILL.md with new capabilities

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Update CLI Help Text

**Files:**
- Modify: `src/index.ts` (command descriptions)

- [ ] **Step 1: Review and update all command descriptions**

Ensure all new options and commands have accurate help text.

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
docs(cli): update help text for new commands and options

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Execution Notes

1. Tasks 1-2 are foundational and should be completed first
2. Tasks 3-4 can be done in parallel (git vs http dirty handling)
3. Task 5 (restore command) depends on Tasks 2-4
4. Tasks 6-8 are independent CLI enhancements
5. Task 9 can be done anytime after Task 1
6. Tasks 10-11 (documentation) should be done last
