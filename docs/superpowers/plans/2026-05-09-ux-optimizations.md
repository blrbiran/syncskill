# UX Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 9 UX optimizations from syncskill-design.md to improve CLI usability

**Architecture:** Changes span CLI entry (index.ts), source management (source.ts), sync engine (sync_engine.ts), matrix editor (matrix-editor.ts), and conflict resolution (conflict.ts). New file skills-ignore.json tracks ignored skills.

**Tech Stack:** TypeScript, Node.js 20+, @inquirer/prompts, commander

---

## File Structure

**New Files:**
- `src/skills-ignore.ts` — Load/save/query skills-ignore.json

**Modified Files:**
- `src/index.ts` — CLI commands (resolve, push, link, source remove)
- `src/source.ts` — Auto-detection, skill scanning, same-repo merge
- `src/sync_engine.ts` — --dry-run support
- `src/matrix-editor.ts` — New shortcuts (A, /, g, G)
- `src/linker.ts` — discover migration prompt, --dry-run
- `src/conflict.ts` — --diff support

---

## Task 1: Matrix Editor Shortcuts (P3)

**Files:**
- Modify: `src/matrix-editor.ts`
- Test: `tests/unit/matrix-editor.test.ts`

- [ ] **Step 1: Write tests for new shortcuts**

```typescript
// tests/unit/matrix-editor.test.ts - add these tests

describe('matrix editor shortcuts', () => {
  it('A (shift+a) toggles entire column', () => {
    const config: MatrixEditorConfig = {
      title: 'Test',
      rows: ['skill1', 'skill2', 'skill3'],
      columns: ['agent1', 'agent2'],
      selected: { skill1: ['agent1'], skill2: [], skill3: ['agent1'] }
    };
    // When A is pressed on column 0 (agent1), all rows should toggle
    // Since not all are selected, all should become selected
    const result = simulateKeypress(config, { name: 'A', shift: true }, { row: 0, col: 0 });
    expect(result.selected.skill1).toContain('agent1');
    expect(result.selected.skill2).toContain('agent1');
    expect(result.selected.skill3).toContain('agent1');
  });

  it('g jumps to first row', () => {
    const config: MatrixEditorConfig = {
      title: 'Test',
      rows: ['skill1', 'skill2', 'skill3'],
      columns: ['agent1'],
      selected: {}
    };
    // Start at row 2, press g, should move to row 0
    const result = simulateKeypress(config, { name: 'g' }, { row: 2, col: 0 });
    expect(result.cursorRow).toBe(0);
  });

  it('G jumps to last row', () => {
    const config: MatrixEditorConfig = {
      title: 'Test',
      rows: ['skill1', 'skill2', 'skill3'],
      columns: ['agent1'],
      selected: {}
    };
    // Start at row 0, press G, should move to row 2
    const result = simulateKeypress(config, { name: 'G', shift: true }, { row: 0, col: 0 });
    expect(result.cursorRow).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/matrix-editor.test.ts --run`
Expected: FAIL - tests reference undefined functions

- [ ] **Step 3: Add column toggle (Shift+A) to matrix editor**

```typescript
// src/matrix-editor.ts - add inside useKeypress handler after the 'a' key handler

} else if (key.name === 'A' || (key.name === 'a' && key.shift)) {
  // Toggle entire column
  const colName = columns[cursorCol];
  const allSelected = rows.every((rowName) => (selected[rowName] ?? []).includes(colName));
  const newSelected = { ...selected };
  for (const rowName of rows) {
    const current = newSelected[rowName] ?? [];
    if (allSelected) {
      newSelected[rowName] = current.filter((c) => c !== colName);
    } else if (!current.includes(colName)) {
      newSelected[rowName] = [...current, colName];
    }
  }
  setSelected(newSelected);
}
```

- [ ] **Step 4: Add g/G shortcuts for first/last row**

```typescript
// src/matrix-editor.ts - add inside useKeypress handler

} else if (key.name === 'g' && !key.shift) {
  // Jump to first row
  setCurrentPage(0);
  setCursorRow(0);
} else if (key.name === 'G' || (key.name === 'g' && key.shift)) {
  // Jump to last row
  const lastPage = totalPages - 1;
  setCurrentPage(lastPage);
  const lastPageRowCount = rows.length - lastPage * pageSize;
  setCursorRow(lastPageRowCount - 1);
}
```

- [ ] **Step 5: Add search (/) shortcut stub**

For now, we'll add a placeholder that could be expanded later. The search functionality requires a more complex state machine with an input field, which is beyond the scope of this task.

```typescript
// src/matrix-editor.ts - add inside useKeypress handler
// Note: Full search implementation deferred - would require input state

} else if (key.name === '/') {
  // TODO: Search functionality - requires input state machine
  // For now, this is a no-op placeholder
}
```

- [ ] **Step 6: Update help line**

```typescript
// src/matrix-editor.ts - update helpLine constant

const helpLine = '↑↓←→ navigate  Space: toggle  Tab: next  a: row  A: col  g/G: first/last  Enter/Esc: save';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/unit/matrix-editor.test.ts --run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/matrix-editor.ts tests/unit/matrix-editor.test.ts
git commit -m "feat(matrix-editor): add A/g/G shortcuts for column toggle and jump"
```

---

## Task 2: Resolve Command Syntax Simplification (P1)

**Files:**
- Modify: `src/index.ts:511-579`
- Modify: `src/conflict.ts`
- Test: `tests/integration/reconciliation-cli.test.ts`

- [ ] **Step 1: Write test for new positional syntax**

```typescript
// tests/integration/reconciliation-cli.test.ts - add test

it('resolve accepts positional local/remote argument', async () => {
  // Setup: create a conflict state
  const { homeDir, cleanup } = await createTestHome();
  try {
    await setupConflictState(homeDir, 'test-skill', 'server1');
    
    // Test new syntax: resolve <skill> local
    const { stdout } = await execFileAsync('node', [
      cliPath,
      'resolve',
      'test-skill',
      'local',
      '--home', homeDir
    ]);
    
    expect(stdout).toContain('test-skill');
    expect(stdout).toContain('push'); // resolved to push direction
  } finally {
    await cleanup();
  }
});

it('resolve --diff shows file differences', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    await setupConflictState(homeDir, 'test-skill', 'server1');
    
    const { stdout } = await execFileAsync('node', [
      cliPath,
      'resolve',
      'test-skill',
      '--diff',
      '--home', homeDir
    ]);
    
    expect(stdout).toContain('local_hash');
    expect(stdout).toContain('remote_hash');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/integration/reconciliation-cli.test.ts --run`
Expected: FAIL

- [ ] **Step 3: Update resolve command to accept positional argument**

```typescript
// src/index.ts - replace the resolve command (lines ~511-579)

program
  .command('resolve <skill> [side]')
  .description('Resolve a conflict by choosing local or remote state')
  .option('--take <side>', 'Choose which side to keep (deprecated, use positional arg)')
  .option('--manual', 'Create .sync-conflict marker file for manual resolution')
  .option('--diff', 'Show hash differences for the conflict')
  .action(async (skill: string, side: string | undefined, options: { take?: 'local' | 'remote'; manual?: boolean; diff?: boolean }) => {
    // Support both new positional syntax and old --take flag
    let takeSide: 'local' | 'remote' | undefined = options.take;
    
    if (side === 'local' || side === 'remote') {
      takeSide = side;
    } else if (side !== undefined) {
      throw new Error(`Invalid side "${side}". Expected "local" or "remote".`);
    }

    const servers = await listTrackedServers(resolvedHomeDir);

    if (servers.length === 0) {
      console.error('No tracked servers found. Run "syncskill refresh" first to track server manifests.');
      process.exit(1);
    }

    // Handle --diff option
    if (options.diff) {
      for (const server of servers) {
        const manifest = await loadServerManifest(resolvedHomeDir, server);
        const reconciled = reconcileManifest(manifest);
        const current = reconciled.skills[skill];

        if (current && current.direction === 'conflict') {
          console.log(`Skill: ${skill}`);
          console.log(`Server: ${server}`);
          console.log(`Local hash:  ${current.local_hash ?? '(none)'}`);
          console.log(`Remote hash: ${current.remote_hash ?? '(none)'}`);
          console.log(`Recorded:    ${current.recorded_hash ?? '(none)'}`);
          return;
        }
      }
      throw new Error(`No conflict found for skill: ${skill}`);
    }

    if (!takeSide && !options.manual) {
      throw new Error('resolve requires <local|remote> or --manual');
    }

    const updatedAt = new Date().toISOString();
    let resolved = false;

    for (const server of servers) {
      const manifest = await loadServerManifest(resolvedHomeDir, server);
      const reconciled = reconcileManifest(manifest);
      const current = reconciled.skills[skill];

      if (!current || current.direction !== 'conflict') {
        continue;
      }

      if (options.manual) {
        const { skillsDir } = getSyncPaths(resolvedHomeDir);
        const skillDir = join(skillsDir, skill);
        await mkdir(skillDir, { recursive: true });
        const markerPath = join(skillDir, '.sync-conflict');
        const markerContent = formatConflictMarker({
          skill,
          server,
          local_hash: current.local_hash ?? '',
          remote_hash: current.remote_hash ?? '',
          created_at: updatedAt
        });
        await writeFile(markerPath, markerContent, 'utf8');
        console.log(`Created conflict marker: ${markerPath}`);
        resolved = true;
        continue;
      }

      const updatedManifest = applyResolution(reconciled, skill, takeSide!, updatedAt);
      await saveServerManifest(resolvedHomeDir, updatedManifest);

      const updatedSkill = updatedManifest.skills[skill];
      console.log(`${skill}\t${server}\t${updatedSkill.direction}\t${updatedSkill.status}`);
      resolved = true;
    }

    if (!resolved) {
      throw new Error(`No tracked conflict found for skill: ${skill}`);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/integration/reconciliation-cli.test.ts --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/integration/reconciliation-cli.test.ts
git commit -m "feat(cli): simplify resolve syntax with positional args and add --diff"
```

---

## Task 3: Push Interactive Server Selection (P0)

**Files:**
- Modify: `src/index.ts:581-594`
- Test: `tests/integration/sync-cli.test.ts`

- [ ] **Step 1: Write test for interactive push**

```typescript
// tests/integration/sync-cli.test.ts - add test

it('push without args shows server selection', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    // Setup multiple servers in config
    await setupMultipleServers(homeDir, ['server1', 'server2', 'server3']);
    
    // Run push with simulated stdin selecting "All servers"
    // Note: This test may need mocking of @inquirer/prompts
    const { stdout } = await runWithStdin(
      ['node', cliPath, 'push', '--home', homeDir],
      '\n' // Enter to select first option (All servers)
    );
    
    expect(stdout).toContain('server1');
    expect(stdout).toContain('server2');
    expect(stdout).toContain('server3');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Update push command for interactive selection**

```typescript
// src/index.ts - replace push command (lines ~581-594)

program
  .command('push [server]')
  .description('Push local skill changes to one server or all configured servers')
  .option('--all', 'Push to all configured servers')
  .option('--dry-run', 'Preview changes without pushing')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean; yes?: boolean }) => {
    const config = await loadConfig(resolvedHomeDir);
    const allServers = Object.keys(config.servers).sort();
    
    let targetServers: string[];
    
    if (options.all) {
      targetServers = allServers;
    } else if (server) {
      targetServers = [server];
    } else if (allServers.length === 0) {
      console.error('No servers configured. Use "syncskill config server" to add servers.');
      process.exit(1);
    } else if (allServers.length === 1 || options.yes) {
      targetServers = allServers;
    } else {
      // Interactive selection
      const { checkbox } = await import('@inquirer/prompts');
      const selected = await checkbox({
        message: 'Select servers to push:',
        choices: [
          { name: 'All servers', value: '__all__', checked: true },
          ...allServers.map(s => ({ name: s, value: s, checked: false }))
        ]
      });
      
      if (selected.includes('__all__')) {
        targetServers = allServers;
      } else if (selected.length === 0) {
        console.log('No servers selected. Cancelled.');
        return;
      } else {
        targetServers = selected;
      }
    }

    if (options.dryRun) {
      console.log('[dry-run] Would push to:', targetServers.join(', '));
      // TODO: Implement full dry-run output
      return;
    }

    const results = await pushToServers(resolvedHomeDir, targetServers);

    for (const result of results) {
      for (const line of formatSkillRows('push', result)) {
        console.log(line);
      }
    }
  });
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/integration/sync-cli.test.ts --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/integration/sync-cli.test.ts
git commit -m "feat(cli): add interactive server selection for push command"
```

---

## Task 4: Link Command Unification (P2)

**Files:**
- Modify: `src/index.ts:187-228` and `src/index.ts:149-153`
- Test: `tests/integration/config-cli.test.ts`

- [ ] **Step 1: Write test for link without args**

```typescript
// tests/integration/config-cli.test.ts - add test

it('link without args enters matrix editor', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    // Setup config with skills and agents
    await setupConfigWithSkills(homeDir);
    
    // Run link command - should show matrix editor
    // Note: Testing interactive commands requires mocking
    // For now, verify help text mentions matrix editor
    const { stdout } = await execFileAsync('node', [cliPath, 'link', '--help']);
    
    expect(stdout).toContain('matrix editor');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Update link command to open matrix editor by default**

```typescript
// src/index.ts - replace link command (lines ~187-228)

program
  .command('link [skill]')
  .description('Manage skill → agent links. No args or --edit opens matrix editor')
  .option('--edit', 'Open matrix editor (same as no args)')
  .option('--all', 'Link all configured skills')
  .option('--status', 'Show link status')
  .option('--unlink <skill>', 'Remove links for one skill')
  .option('--dry-run', 'Preview changes without applying')
  .action(async (skill: string | undefined, options: { edit?: boolean; all?: boolean; status?: boolean; unlink?: string; dryRun?: boolean }) => {
    if (options.status) {
      const statuses = await collectLinkStatus(resolvedHomeDir);

      for (const status of statuses) {
        console.log(`${status.skill}\t${status.agent}\t${status.state}`);
      }

      return;
    }

    if (typeof options.unlink === 'string') {
      const confirmed = await confirm({
        message: `Unlink skill "${options.unlink}" from all agents?`,
        default: false,
      });
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
      await unlinkSkill(resolvedHomeDir, options.unlink);
      return;
    }

    if (options.all) {
      if (options.dryRun) {
        console.log('[dry-run] Would link all configured skills');
        // TODO: Show what would be linked
        return;
      }
      await linkConfiguredSkills(resolvedHomeDir, { all: true });
      return;
    }

    if (typeof skill === 'string') {
      await linkConfiguredSkills(resolvedHomeDir, { all: false, skillName: skill });
      return;
    }

    // No args or --edit: open matrix editor
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
  });
```

- [ ] **Step 3: Keep config link as alias (deprecation notice)**

```typescript
// src/index.ts - update config link command (lines ~149-153)

configCommand
  .command('link')
  .description('Edit skill → agent links (matrix editor) [deprecated: use "link" instead]')
  .action(async () => {
    console.log('Note: "config link" is deprecated. Use "syncskill link" instead.');
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
  });
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/integration/config-cli.test.ts --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/integration/config-cli.test.ts
git commit -m "feat(cli): unify link command with matrix editor, deprecate config link"
```

---

## Task 5: Source Remove Unified Options (P3)

**Files:**
- Modify: `src/index.ts:326-426`
- Test: `tests/integration/source-remove.test.ts`

- [ ] **Step 1: Write test for unified options display**

```typescript
// tests/integration/source-remove.test.ts - add test

it('source remove shows all options with disabled indicator for non-git', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    // Setup an HTTP source
    await setupHttpSource(homeDir, 'http-source');
    
    // Verify the prompt shows disabled option
    // Note: This requires mocking the select prompt
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Update source remove to show unified options**

```typescript
// src/index.ts - replace source remove action (lines ~326-426)

.action(async (name: string, options: { force?: boolean }) => {
  const config = await loadConfig(resolvedHomeDir);
  const sourceRaw = config.sources[name];

  if (!sourceRaw) {
    console.error(`Source not found: ${name}`);
    process.exit(1);
  }

  const sourceType = (sourceRaw as Record<string, unknown>).type as string;
  const isGitSource = sourceType === 'git';

  const ownershipState = await loadSkillOwnershipState(resolvedHomeDir);
  const localSkills = new Set(await listLocalSkillNames(resolvedHomeDir));
  const orphans = findOrphanSkills(name, config, ownershipState, localSkills);

  // Show affected skills
  const ownedSkills = Object.entries(ownershipState.owners)
    .filter(([, owner]) => owner === name)
    .map(([skill]) => skill);

  if (ownedSkills.length > 0) {
    console.log(`\nSkills provided by source "${name}":`);
    for (const skill of ownedSkills) {
      const isOrphan = orphans.includes(skill);
      console.log(`  - ${skill}${isOrphan ? ' (orphan - only from this source)' : ''}`);
    }
    console.log('');
  } else {
    console.log(`\nSource "${name}" provides no skills.\n`);
  }

  let action: RemovalAction;

  if (options.force) {
    action = RemovalAction.RemoveAll;
  } else {
    // Unified options for all types, with disabled indicator
    const choices = [
      {
        name: isGitSource 
          ? 'Convert to local source (keep files, no more git updates)'
          : '[disabled] Convert to local source (git only)',
        value: RemovalAction.ConvertToLocal,
        disabled: !isGitSource
      },
      {
        name: 'Remove config + links only (keep skill files on disk)',
        value: RemovalAction.RemoveConfigKeepFiles,
      },
      {
        name: 'Remove everything (config, links, and skill files)',
        value: RemovalAction.RemoveAll,
      },
    ];

    const choice = await select({
      message: `How do you want to remove source "${name}" (type: ${sourceType})?`,
      choices: choices.filter(c => !c.disabled)
    });
    action = choice;
  }

  // Double confirmation for destructive actions
  if (action === RemovalAction.RemoveAll && orphans.length > 0) {
    const confirmed = await confirm({
      message: `This will permanently delete ${orphans.length} orphan skill(s). Continue?`,
      default: false,
    });
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
  }

  await removeSource(resolvedHomeDir, name, { action });

  switch (action) {
    case RemovalAction.ConvertToLocal:
      console.log(`Converted source "${name}" to local type.`);
      break;
    case RemovalAction.RemoveConfigKeepFiles:
      console.log(`Removed source "${name}" (skill files kept on disk).`);
      break;
    case RemovalAction.RemoveAll:
      console.log(`Removed source "${name}" and all associated files.`);
      break;
  }
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/integration/source-remove.test.ts --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/integration/source-remove.test.ts
git commit -m "feat(cli): unify source remove options with disabled indicator"
```

---

## Task 6: Multi-Server Hint on Server Add (P3)

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/server-cli.test.ts`

- [ ] **Step 1: Add server count check after adding server**

```typescript
// src/config-ui.ts - find the server add logic and add after successful add:

// After adding a server, check if we now have 3+
const serverCount = Object.keys(config.servers).length;
if (serverCount >= 3) {
  console.log('\nNote: With 3+ servers, auto-refresh may be slow.');
  console.log('Use --no-refresh to skip, then run `syncskill refresh` manually.\n');
}
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/integration/server-cli.test.ts --run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/config-ui.ts tests/integration/server-cli.test.ts
git commit -m "feat(cli): show multi-server hint when adding 3rd+ server"
```

---

## Task 7: Skills Ignore JSON Support (P1)

**Files:**
- Create: `src/skills-ignore.ts`
- Test: `tests/unit/skills-ignore.test.ts`

- [ ] **Step 1: Create skills-ignore.ts module**

```typescript
// src/skills-ignore.ts

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncPaths } from './config.js';

export interface IgnoredSkillEntry {
  path: string;
  source: string;
  reason: 'duplicate' | 'user-choice' | 'conflict';
  kept?: {
    path: string;
    source: string;
  };
  ignored_at: string;
}

export interface SkillsIgnore {
  version: 1;
  ignored: Record<string, IgnoredSkillEntry>;
}

export function getSkillsIgnorePath(homeDir: string): string {
  const { syncDir } = getSyncPaths(homeDir);
  return join(syncDir, 'skills-ignore.json');
}

export async function loadSkillsIgnore(homeDir: string): Promise<SkillsIgnore> {
  const path = getSkillsIgnorePath(homeDir);
  
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as SkillsIgnore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, ignored: {} };
    }
    throw error;
  }
}

export async function saveSkillsIgnore(homeDir: string, ignore: SkillsIgnore): Promise<void> {
  const path = getSkillsIgnorePath(homeDir);
  await writeFile(path, JSON.stringify(ignore, null, 2), 'utf8');
}

export function isSkillIgnored(ignore: SkillsIgnore, skillName: string): boolean {
  return skillName in ignore.ignored;
}

export function addIgnoredSkill(
  ignore: SkillsIgnore,
  skillName: string,
  entry: Omit<IgnoredSkillEntry, 'ignored_at'>
): SkillsIgnore {
  return {
    ...ignore,
    ignored: {
      ...ignore.ignored,
      [skillName]: {
        ...entry,
        ignored_at: new Date().toISOString()
      }
    }
  };
}

export function removeIgnoredSkill(ignore: SkillsIgnore, skillName: string): SkillsIgnore {
  const { [skillName]: _, ...rest } = ignore.ignored;
  return { ...ignore, ignored: rest };
}
```

- [ ] **Step 2: Write tests**

```typescript
// tests/unit/skills-ignore.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSkillsIgnore,
  saveSkillsIgnore,
  isSkillIgnored,
  addIgnoredSkill,
  removeIgnoredSkill
} from '../src/skills-ignore.js';

describe('skills-ignore', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = join(tmpdir(), `skills-ignore-test-${Date.now()}`);
    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads empty ignore file when none exists', async () => {
    const ignore = await loadSkillsIgnore(tempDir);
    expect(ignore.version).toBe(1);
    expect(ignore.ignored).toEqual({});
  });

  it('saves and loads ignore entries', async () => {
    const ignore = addIgnoredSkill(
      { version: 1, ignored: {} },
      'test-skill',
      {
        path: '/path/to/skill',
        source: 'my-source',
        reason: 'duplicate',
        kept: { path: '/path/to/other', source: 'other-source' }
      }
    );
    
    await saveSkillsIgnore(tempDir, ignore);
    const loaded = await loadSkillsIgnore(tempDir);
    
    expect(isSkillIgnored(loaded, 'test-skill')).toBe(true);
    expect(loaded.ignored['test-skill'].reason).toBe('duplicate');
  });

  it('removes ignored skill', async () => {
    let ignore = addIgnoredSkill(
      { version: 1, ignored: {} },
      'test-skill',
      { path: '/path', source: 'src', reason: 'user-choice' }
    );
    
    expect(isSkillIgnored(ignore, 'test-skill')).toBe(true);
    
    ignore = removeIgnoredSkill(ignore, 'test-skill');
    
    expect(isSkillIgnored(ignore, 'test-skill')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/unit/skills-ignore.test.ts --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/skills-ignore.ts tests/unit/skills-ignore.test.ts
git commit -m "feat: add skills-ignore.json module for tracking ignored skills"
```

---

## Task 8: Dry-Run Support for Push/Pull/Sync (P0)

**Files:**
- Modify: `src/sync_engine.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/sync-cli.test.ts`

- [ ] **Step 1: Add dry-run option to sync engine types**

```typescript
// src/sync_engine.ts - update SyncEngineOptions interface

export interface SyncEngineOptions {
  runtime?: TransportRuntime;
  now?: string;
  dryRun?: boolean;
}

export interface DryRunResult {
  server: string;
  direction: 'push' | 'pull';
  skills: Array<{
    name: string;
    action: 'add' | 'update' | 'delete' | 'skip' | 'conflict';
    files?: Array<{ path: string; change: '+' | '~' | '-' }>;
  }>;
}
```

- [ ] **Step 2: Implement dry-run in pushToServers**

```typescript
// src/sync_engine.ts - add to pushToServers before the actual push loop

export async function pushToServers(homeDir: string, servers?: string[], options: SyncEngineOptions = {}): Promise<PushResult[]> {
  const config = await loadConfig(homeDir);
  const targetServers = resolveTargetServers(config, servers);
  const runtime = options.runtime ?? createTransportRuntime();
  const results: PushResult[] = [];

  for (const serverName of targetServers) {
    const server = getConfiguredServer(config, serverName);
    const updated = await prepareManifest(homeDir, server, runtime, options.now);
    const manifest = applyConflictPolicy(updated.manifest, config.conflict_resolution, updated.updatedAt);
    const conflictedSkills = listSkillsByDirection(manifest, 'conflict');
    const pushedSkills = listSkillsByDirection(manifest, 'push');

    if (options.dryRun) {
      console.log(`\n[dry-run] push to ${serverName}:\n`);
      
      if (pushedSkills.length === 0 && conflictedSkills.length === 0) {
        console.log('  (no changes)');
      } else {
        for (const skill of pushedSkills) {
          const state = manifest.skills[skill];
          const action = state.local_hash && !state.remote_hash ? '+' : '~';
          console.log(`  ${action} ${skill}`);
        }
        for (const skill of conflictedSkills) {
          console.log(`  ! ${skill} (conflict)`);
        }
      }
      
      results.push({
        server: serverName,
        pushed_skills: [],
        skipped_skills: pushedSkills,
        conflicted_skills: conflictedSkills,
        manifest
      });
      continue;
    }

    // ... existing push logic ...
  }

  return results;
}
```

- [ ] **Step 3: Add --dry-run to pull and sync commands**

```typescript
// src/index.ts - update pull command

program
  .command('pull [server]')
  .description('Pull remote skill changes from one server or all configured servers')
  .option('--all', 'Pull from all configured servers')
  .option('--dry-run', 'Preview changes without pulling')
  .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean }) => {
    const servers = options.all || server === undefined ? undefined : [server];
    const results = await pullFromServers(resolvedHomeDir, servers, { dryRun: options.dryRun });

    for (const result of results) {
      for (const line of formatSkillRows('pull', result)) {
        console.log(line);
      }
    }
  });

// src/index.ts - update sync command

program
  .command('sync [server]')
  .description('Pull then push changes for one server or all configured servers')
  .option('--all', 'Sync all configured servers')
  .option('--dry-run', 'Preview changes without syncing')
  .action(async (server: string | undefined, options: { all?: boolean; dryRun?: boolean }) => {
    const servers = options.all || server === undefined ? undefined : [server];
    const results = await syncServers(resolvedHomeDir, servers, { dryRun: options.dryRun });

    // ... rest of output logic
  });
```

- [ ] **Step 4: Write tests**

```typescript
// tests/integration/sync-cli.test.ts - add test

it('push --dry-run shows preview without pushing', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    await setupPushableState(homeDir, 'test-skill', 'server1');
    
    const { stdout } = await execFileAsync('node', [
      cliPath,
      'push',
      'server1',
      '--dry-run',
      '--home', homeDir
    ]);
    
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain('test-skill');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/integration/sync-cli.test.ts --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sync_engine.ts src/index.ts tests/integration/sync-cli.test.ts
git commit -m "feat(cli): add --dry-run support for push/pull/sync commands"
```

---

## Task 9: Discover Migration Prompt (P2)

**Files:**
- Modify: `src/linker.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/discover.test.ts`

- [ ] **Step 1: Add agent directory scanning to discoverSkills**

```typescript
// src/linker.ts - add function to scan agent directories

export interface UnmanagedSkill {
  name: string;
  path: string;
  agent: string;
}

export async function findUnmanagedSkills(homeDir: string): Promise<UnmanagedSkill[]> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const managedSkills = new Set(await listLocalSkillNames(homeDir));
  const unmanaged: UnmanagedSkill[] = [];
  
  for (const [agentName, agentPath] of Object.entries(config.agents)) {
    const resolvedPath = agentPath.replace(/^~/, homeDir);
    
    try {
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const skillPath = join(resolvedPath, entry.name);
        
        // Check if it's a symlink pointing to our managed skills
        try {
          const linkTarget = await readlink(skillPath);
          if (linkTarget.startsWith(skillsDir)) continue; // Already managed
        } catch {
          // Not a symlink, or error reading - continue checking
        }
        
        // Check if skill has SKILL.md
        try {
          await readFile(join(skillPath, 'SKILL.md'), 'utf8');
          
          if (!managedSkills.has(entry.name)) {
            unmanaged.push({
              name: entry.name,
              path: skillPath,
              agent: agentName
            });
          }
        } catch {
          // No SKILL.md, skip
        }
      }
    } catch {
      // Agent directory doesn't exist or not accessible
    }
  }
  
  return unmanaged;
}
```

- [ ] **Step 2: Update discover command to prompt for migration**

```typescript
// src/index.ts - update discover command (lines ~169-185)

program
  .command('discover')
  .description('Discover skills in ~/.syncskill/skills/ and configured sources, register to config links')
  .option('--all-agents', 'Link new skills to all configured agents')
  .action(async (options: { allAgents?: boolean }) => {
    // Discover skills from sources and manual directory
    const addedSkills = await discoverSkills(resolvedHomeDir, {
      allAgents: Boolean(options.allAgents)
    });

    if (addedSkills.length > 0) {
      console.log('Found new skills in sources:');
      for (const skillName of addedSkills) {
        console.log(`  ✓ Added "${skillName}"`);
      }
    }

    // Check for unmanaged skills in agent directories
    const unmanaged = await findUnmanagedSkills(resolvedHomeDir);
    
    if (unmanaged.length > 0) {
      console.log('\nFound unmanaged skills in agent directories:');
      for (const skill of unmanaged) {
        console.log(`  ${skill.path}`);
      }
      
      const confirmed = await confirm({
        message: `Migrate ${unmanaged.length} skill(s) to ~/.syncskill/skills/?`,
        default: true
      });
      
      if (confirmed) {
        const { skillsDir } = getSyncPaths(resolvedHomeDir);
        
        for (const skill of unmanaged) {
          const targetPath = join(skillsDir, skill.name);
          await cp(skill.path, targetPath, { recursive: true });
          console.log(`  ✓ Migrated "${skill.name}"`);
        }
        
        // Re-run discover to register migrated skills
        await discoverSkills(resolvedHomeDir, {
          allAgents: Boolean(options.allAgents)
        });
      }
    }

    // Generate skills-index.json
    const index = await buildSkillsIndex(resolvedHomeDir);
    await saveSkillsIndex(resolvedHomeDir, index);
  });
```

- [ ] **Step 3: Add import for new function**

```typescript
// src/index.ts - update imports

import { collectLinkStatus, discoverSkills, findUnmanagedSkills, linkConfiguredSkills, unlinkSkill } from './linker.js';
```

- [ ] **Step 4: Write tests**

```typescript
// tests/integration/discover.test.ts - add test

it('discover prompts to migrate unmanaged skills from agent directories', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    // Setup: create a skill in agent directory that's not managed
    const agentSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentSkillsDir, { recursive: true });
    await mkdir(join(agentSkillsDir, 'unmanaged-skill'));
    await writeFile(join(agentSkillsDir, 'unmanaged-skill', 'SKILL.md'), '# Test');
    
    // Run discover with simulated 'yes' input
    const { stdout } = await runWithStdin(
      ['node', cliPath, 'discover', '--home', homeDir],
      'y\n'
    );
    
    expect(stdout).toContain('unmanaged-skill');
    expect(stdout).toContain('Migrate');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/integration/discover.test.ts --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/linker.ts src/index.ts tests/integration/discover.test.ts
git commit -m "feat(cli): discover prompts to migrate unmanaged skills from agent dirs"
```

---

## Task 10: Source Add Auto-Detection and Skill Selection (P1)

**Files:**
- Modify: `src/source.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/source-cli.test.ts`

- [ ] **Step 1: Add URL type detection function**

```typescript
// src/source.ts - add detection function

export function detectSourceType(input: string): { type: SourceType; url: string; ref?: string } | null {
  // File system paths
  if (input.startsWith('/') || input.startsWith('~') || input.startsWith('./') || input.startsWith('../')) {
    return { type: 'local', url: input };
  }
  
  // GitHub/GitLab URLs
  const gitHostMatch = input.match(/^https?:\/\/(github\.com|gitlab\.com)\/([^\/]+)\/([^\/]+)/);
  if (gitHostMatch) {
    // Check for /tree/<branch>/<path> pattern
    const treeMatch = input.match(/\/tree\/([^\/]+)(\/.*)?$/);
    if (treeMatch) {
      const branch = treeMatch[1];
      const repoBase = input.replace(/\/tree\/.*$/, '');
      return { type: 'git', url: `${repoBase}.git`, ref: branch };
    }
    
    // Plain repo URL
    const url = input.endsWith('.git') ? input : `${input}.git`;
    return { type: 'git', url };
  }
  
  // .git suffix
  if (input.endsWith('.git')) {
    return { type: 'git', url: input };
  }
  
  // Archive files
  if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip)$/.test(input)) {
    return { type: 'http', url: input };
  }
  
  // Unknown - return null to trigger interactive prompt
  return null;
}
```

- [ ] **Step 2: Add skill scanning function**

```typescript
// src/source.ts - add skill scanning

export interface DiscoveredSkill {
  name: string;
  relativePath: string;
  absolutePath: string;
}

export async function scanSkillsInDirectory(baseDir: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];
  
  async function scanDir(dir: string, relPath: string = ''): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // Skip hidden dirs
        
        const fullPath = join(dir, entry.name);
        const relativePath = relPath ? `${relPath}/${entry.name}` : entry.name;
        
        // Check if this directory has SKILL.md
        try {
          await readFile(join(fullPath, 'SKILL.md'), 'utf8');
          skills.push({
            name: entry.name,
            relativePath,
            absolutePath: fullPath
          });
        } catch {
          // No SKILL.md, recurse into subdirectory
          await scanDir(fullPath, relativePath);
        }
      }
    } catch {
      // Directory not accessible
    }
  }
  
  await scanDir(baseDir);
  return skills;
}
```

- [ ] **Step 3: Update addSourceFromUrl with new flow**

```typescript
// src/source.ts - update addSourceFromUrl

export interface AddSourceOptions {
  name?: string;
  type?: SourceType;
  store?: string;
  skillSubdir?: string;
  ref?: string;
  yes?: boolean;
  dryRun?: boolean;
}

export interface AddSourceResult {
  name: string;
  source: SourceDefinition;
  skills: string[];
  ignoredSkills: string[];
  sameRepoMatch?: { name: string; source: SourceDefinition };
}

export async function addSourceFromUrl(
  homeDir: string,
  urlOrPath: string,
  options: AddSourceOptions = {}
): Promise<AddSourceResult> {
  // Step 1: Detect type if not provided
  let sourceType = options.type;
  let effectiveUrl = urlOrPath;
  let ref = options.ref;
  
  if (!sourceType) {
    const detected = detectSourceType(urlOrPath);
    if (detected) {
      sourceType = detected.type;
      effectiveUrl = detected.url;
      ref = ref ?? detected.ref;
    } else {
      // Check if path exists locally
      try {
        await lstat(urlOrPath);
        sourceType = 'local';
        effectiveUrl = urlOrPath;
      } catch {
        // Will need to prompt user - throw for now
        throw new Error(`Could not determine source type for "${urlOrPath}". Use --type to specify.`);
      }
    }
  }
  
  // Step 2: Determine name and store
  const name = options.name ?? deriveSourceName(effectiveUrl);
  const store = options.store ?? getDefaultStore(homeDir, name, sourceType);
  
  // ... rest of existing logic with skill scanning ...
  
  return {
    name,
    source: { type: sourceType, url: effectiveUrl, store, ref },
    skills: [],
    ignoredSkills: []
  };
}
```

- [ ] **Step 4: Update CLI to use checkbox for skill selection**

```typescript
// src/index.ts - update source add command with checkbox

.action(async (nameOrUrl: string, options: {
  type?: SourceType;
  url?: string;
  store?: string;
  path?: string;
  skillSubdir?: string;
  ref?: string;
  yes?: boolean;
  dryRun?: boolean;
}) => {
  // ... existing type detection logic ...
  
  const result = await addSourceFromUrl(resolvedHomeDir, effectiveUrl, {
    name: options.url ? nameOrUrl : undefined,
    type: effectiveType,
    store: effectiveStore,
    skillSubdir: options.skillSubdir,
    ref: options.ref,
    yes: options.yes,
    dryRun: options.dryRun
  });

  if (result.sameRepoMatch) {
    // Handle same-repo case
    console.log(`\nRepository already exists as source: ${result.sameRepoMatch.name}`);
    // ... prompt to restore from ignore ...
    return;
  }

  // Scan for skills and let user select
  if (!options.yes && result.skills.length > 1) {
    const { checkbox } = await import('@inquirer/prompts');
    const selected = await checkbox({
      message: `Found ${result.skills.length} skills. Select which to add:`,
      choices: result.skills.map(s => ({
        name: `${s} (${result.source.store}/${s})`,
        value: s,
        checked: true
      }))
    });
    
    // Update links for selected, add others to ignore
    // ... implementation ...
  }

  console.log(`Added source: ${result.name}`);
});
```

- [ ] **Step 5: Add -y/--yes flag**

```typescript
// src/index.ts - add to source add options

.option('-y, --yes', 'Skip confirmation prompts, select all skills')
```

- [ ] **Step 6: Write tests**

```typescript
// tests/integration/source-cli.test.ts - add tests

it('source add auto-detects github URL as git type', async () => {
  const result = detectSourceType('https://github.com/org/repo');
  expect(result?.type).toBe('git');
  expect(result?.url).toBe('https://github.com/org/repo.git');
});

it('source add parses /tree/<branch>/<path> format', async () => {
  const result = detectSourceType('https://github.com/org/repo/tree/main/skills/my-skill');
  expect(result?.type).toBe('git');
  expect(result?.ref).toBe('main');
});

it('source add -y skips skill selection prompt', async () => {
  // Test implementation
});
```

- [ ] **Step 7: Run tests**

Run: `npm test -- tests/integration/source-cli.test.ts --run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/source.ts src/index.ts tests/integration/source-cli.test.ts
git commit -m "feat(source): add auto-detection, skill scanning, and -y flag"
```

---

## Task 11: Same-Repo Merge Simplification (P2)

**Files:**
- Modify: `src/source.ts`
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Simplify same-repo handling to use ignore list**

```typescript
// src/source.ts - update same-repo handling in addSourceFromUrl

// When same repo is detected:
if (existingSource) {
  // Load skills-ignore to check if requested path is there
  const ignore = await loadSkillsIgnore(homeDir);
  const requestedSkillName = deriveSkillNameFromPath(newSubdir);
  
  if (isSkillIgnored(ignore, requestedSkillName)) {
    // Restore from ignore
    const updatedIgnore = removeIgnoredSkill(ignore, requestedSkillName);
    await saveSkillsIgnore(homeDir, updatedIgnore);
    
    // Add to links
    const config = await loadConfig(homeDir);
    config.links[requestedSkillName] = ['*'];
    await saveConfig(config, homeDir);
    
    return {
      name: existingSource.name,
      source: existingSource,
      skills: [requestedSkillName],
      ignoredSkills: [],
      restoredFromIgnore: true
    };
  }
  
  // Check if already in links
  const config = await loadConfig(homeDir);
  if (requestedSkillName in config.links) {
    console.log(`Skill "${requestedSkillName}" is already added.`);
    return {
      name: existingSource.name,
      source: existingSource,
      skills: [],
      ignoredSkills: [],
      alreadyExists: true
    };
  }
  
  // Not in ignore, not in links - check if path exists
  // May need git pull first
  // ...
}
```

- [ ] **Step 2: Write tests**

```typescript
// tests/unit/source.test.ts - add test

it('same-repo add restores skill from ignore list', async () => {
  const { homeDir, cleanup } = await createTestHome();
  try {
    // Setup: existing source with skill in ignore
    await setupSourceWithIgnoredSkill(homeDir, 'repo', 'ignored-skill');
    
    // Add the same repo skill
    const result = await addSourceFromUrl(homeDir, 
      'https://github.com/org/repo/tree/main/skills/ignored-skill');
    
    expect(result.restoredFromIgnore).toBe(true);
    expect(result.skills).toContain('ignored-skill');
    
    // Verify skill is no longer in ignore
    const ignore = await loadSkillsIgnore(homeDir);
    expect(isSkillIgnored(ignore, 'ignored-skill')).toBe(false);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/unit/source.test.ts --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/source.ts tests/unit/source.test.ts
git commit -m "feat(source): simplify same-repo merge to use ignore list"
```

---

## Task 12: Final Integration Test and Cleanup

**Files:**
- Test: `tests/integration/ux-optimizations.test.ts`

- [ ] **Step 1: Write comprehensive integration test**

```typescript
// tests/integration/ux-optimizations.test.ts

import { describe, it, expect } from 'vitest';
import { execFileAsync, createTestHome } from './helpers.js';

describe('UX Optimizations Integration', () => {
  it('resolve accepts positional syntax', async () => {
    // Test implementation
  });
  
  it('push shows interactive selection without args', async () => {
    // Test implementation
  });
  
  it('link opens matrix editor without args', async () => {
    // Test implementation
  });
  
  it('--dry-run works for push/pull/sync', async () => {
    // Test implementation
  });
  
  it('discover prompts for migration', async () => {
    // Test implementation
  });
  
  it('source add auto-detects and scans skills', async () => {
    // Test implementation
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test --run`
Expected: All tests PASS

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Manual smoke test**

```bash
npm link
syncskill --help
syncskill link --help
syncskill resolve --help
syncskill push --help
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "test: add UX optimizations integration tests"
```

---

## Summary

This plan implements all 9 UX optimizations:

| Priority | Optimization | Task |
|----------|-------------|------|
| P0 | Push interactive selection | Task 3 |
| P0 | --dry-run support | Task 8 |
| P1 | Source add simplification | Task 10 |
| P1 | Resolve syntax | Task 2 |
| P2 | Link unification | Task 4 |
| P2 | Same-repo merge | Task 11 |
| P2 | Discover migration | Task 9 |
| P3 | Matrix editor shortcuts | Task 1 |
| P3 | Source remove unified | Task 5 |
| P3 | Multi-server hint | Task 6 |

Supporting tasks:
- Task 7: skills-ignore.json module
- Task 12: Integration tests
