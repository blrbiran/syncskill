# Source Remove Interactive Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement interactive confirmation flow for `source remove` command with orphan skill detection and type-specific removal options.

**Architecture:** Add orphan detection function to `source.ts`, create interactive removal flow in CLI that presents type-specific options (3 for git, 2 for http/local), require double confirmation for destructive operations. The `removeSource()` function gets a new `RemovalAction` enum to specify what to do.

**Tech Stack:** TypeScript, @inquirer/prompts (select, confirm), vitest for testing

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/source.ts` | Add `findOrphanSkills()`, `RemovalAction` enum, enhance `removeSource()` |
| `src/index.ts` | Interactive confirmation flow before calling `removeSource()` |
| `tests/unit/source.test.ts` | Unit tests for `findOrphanSkills()` |
| `tests/integration/source-remove.test.ts` | Integration tests for removal actions |

---

### Task 1: Add Orphan Skill Detection Function

**Files:**
- Modify: `src/source.ts` (add export)
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Write the failing test for orphan detection**

Add to `tests/unit/source.test.ts`:

```typescript
import { findOrphanSkills } from '../../src/source.js';
import type { SyncSkillConfig } from '../../src/config.js';

describe('findOrphanSkills', () => {
  it('returns skills only owned by the target source', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: {
        'skill-a': ['*'],
        'skill-b': ['*'],
        'skill-c': ['*'],
      },
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git' },
        'source-two': { type: 'git', url: 'https://example.com/other.git' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = {
      owners: {
        'skill-a': 'source-one',
        'skill-b': 'source-one',
        'skill-c': 'source-two',
      },
    };
    const localSkills = new Set<string>(); // no manual skills

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual(['skill-a', 'skill-b']);
  });

  it('excludes skills that exist in local skills directory', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['*'] },
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = {
      owners: { 'skill-a': 'source-one' },
    };
    const localSkills = new Set(['skill-a']); // also exists locally

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual([]);
  });

  it('returns empty array when source owns no skills', () => {
    const config: SyncSkillConfig = {
      version: 1,
      agents: { claude: '~/.claude/skills' },
      links: {},
      sources: {
        'source-one': { type: 'git', url: 'https://example.com/repo.git' },
      },
      servers: {},
      conflict_resolution: 'manual',
    };
    const ownershipState = { owners: {} };
    const localSkills = new Set<string>();

    const orphans = findOrphanSkills('source-one', config, ownershipState, localSkills);

    expect(orphans).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/source.test.ts -t "findOrphanSkills"`
Expected: FAIL with "findOrphanSkills is not exported"

- [ ] **Step 3: Implement findOrphanSkills function**

Add to `src/source.ts` after the imports:

```typescript
import type { SkillOwnershipState } from './source.js';

export function findOrphanSkills(
  sourceName: string,
  config: SyncSkillConfig,
  ownershipState: SkillOwnershipState,
  localSkills: Set<string>
): string[] {
  const orphans: string[] = [];

  for (const [skill, owner] of Object.entries(ownershipState.owners)) {
    if (owner !== sourceName) continue;

    // Check if skill exists in local skills directory (manual management)
    if (localSkills.has(skill)) continue;

    // Check if any other source provides this skill
    const otherSourceProvides = Object.entries(ownershipState.owners).some(
      ([s, o]) => s === skill && o !== sourceName
    );
    if (otherSourceProvides) continue;

    orphans.push(skill);
  }

  return orphans.sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/source.test.ts -t "findOrphanSkills"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/source.ts tests/unit/source.test.ts
git commit -m "feat(source): add findOrphanSkills for orphan detection"
```

---

### Task 2: Add RemovalAction Enum and Enhance removeSource

**Files:**
- Modify: `src/source.ts`
- Test: `tests/integration/source-remove.test.ts`

- [ ] **Step 1: Write failing tests for new removal actions**

Add to `tests/integration/source-remove.test.ts`:

```typescript
import { RemovalAction } from '../../src/source.js';

describe('removeSource with RemovalAction', () => {
  it('converts git source to local with RemovalAction.ConvertToLocal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');
    const skillsDir = join(syncDir, 'skills');

    await mkdir(sourcesDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(sourcesDir, 'materialized', 'skill-a', 'SKILL.md'), 'content', { recursive: true });
    await mkdir(join(sourcesDir, 'materialized', 'skill-a'), { recursive: true });
    await writeFile(join(sourcesDir, 'materialized', 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(syncDir, '.sources', 'ownership.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.ConvertToLocal });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeDefined();
    expect(config.sources['test-source'].type).toBe('local');
    expect(config.sources['test-source'].store).toBe(join(sourcesDir, 'materialized'));
  });

  it('removes config but keeps files with RemovalAction.RemoveConfigKeepFiles', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');
    const skillsDir = join(syncDir, 'skills');

    await mkdir(join(sourcesDir, 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(syncDir, '.sources', 'ownership.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.RemoveConfigKeepFiles });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeUndefined();
    expect(config.links['skill-a']).toBeUndefined();
    // Files should still exist
    expect(await stat(join(skillsDir, 'skill-a', 'SKILL.md')).then(() => true).catch(() => false)).toBe(true);
  });

  it('removes everything with RemovalAction.RemoveAll', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-remove-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const sourcesDir = join(syncDir, '.sources', 'test-source');
    const skillsDir = join(syncDir, 'skills');

    await mkdir(join(sourcesDir, 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(skillsDir, 'skill-a'), { recursive: true });
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), 'content');
    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: { 'skill-a': ['*'] },
        sources: { 'test-source': { type: 'git', url: 'https://example.com/repo.git' } },
        servers: {},
        conflict_resolution: 'manual',
      })
    );
    await writeFile(
      join(sourcesDir, 'state.json'),
      JSON.stringify({ materialized_skills: ['skill-a'], updated_at: '2026-01-01T00:00:00Z' })
    );
    await writeFile(
      join(syncDir, '.sources', 'ownership.json'),
      JSON.stringify({ owners: { 'skill-a': 'test-source' } })
    );

    await removeSource(homeDir, 'test-source', { action: RemovalAction.RemoveAll });

    const config = parse(await readFile(join(syncDir, 'config.yaml'), 'utf-8')) as SyncSkillConfig;
    expect(config.sources['test-source']).toBeUndefined();
    expect(config.links['skill-a']).toBeUndefined();
    // Files should be deleted
    expect(await stat(join(skillsDir, 'skill-a')).then(() => true).catch(() => false)).toBe(false);
    expect(await stat(sourcesDir).then(() => true).catch(() => false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/integration/source-remove.test.ts -t "RemovalAction"`
Expected: FAIL with "RemovalAction is not exported"

- [ ] **Step 3: Add RemovalAction enum to source.ts**

Add to `src/source.ts` after the imports:

```typescript
export enum RemovalAction {
  /** Git only: Convert source from git to local, keep store directory */
  ConvertToLocal = 'convert-to-local',
  /** Remove source config and links, keep skill files on disk */
  RemoveConfigKeepFiles = 'remove-config-keep-files',
  /** Remove source config, links, and all skill files */
  RemoveAll = 'remove-all',
}
```

- [ ] **Step 4: Update RemoveSourceOptions interface**

Update in `src/source.ts`:

```typescript
export interface RemoveSourceOptions {
  /** @deprecated Use action instead */
  keepStore?: boolean;
  /** Removal action to perform */
  action?: RemovalAction;
}
```

- [ ] **Step 5: Implement enhanced removeSource function**

Replace the `removeSource` function in `src/source.ts`:

```typescript
export async function removeSource(
  homeDir = homedir(),
  name: string,
  options: RemoveSourceOptions = {}
): Promise<void> {
  const config = await loadConfig(homeDir);
  const source = config.sources[name];

  if (source === undefined) {
    throw new Error(`Source not found: ${name}`);
  }

  const ownershipState = await loadSkillOwnershipState(homeDir);
  const sourceState = await loadSourceState(homeDir, name);
  const ownedSkills = sourceState?.materialized_skills ?? [];
  const { skillsDir, syncDir } = getSyncPaths(homeDir);
  const sourceDir = join(syncDir, '.sources', name);

  // Handle legacy keepStore option
  const action = options.action ??
    (options.keepStore ? RemovalAction.RemoveConfigKeepFiles : RemovalAction.RemoveAll);

  if (action === RemovalAction.ConvertToLocal) {
    if (source.type !== 'git') {
      throw new Error(`ConvertToLocal only valid for git sources, got: ${source.type}`);
    }
    // Convert to local source pointing to materialized directory
    const materializedDir = join(sourceDir, 'materialized');
    config.sources[name] = {
      type: 'local',
      store: materializedDir,
    };
    await saveConfig(config, homeDir);
    return;
  }

  // Remove source from config
  delete config.sources[name];

  // Remove links for owned skills
  const nextOwnership = structuredClone(ownershipState) as SkillOwnershipState;
  for (const skill of ownedSkills) {
    if (nextOwnership.owners[skill] === name) {
      delete nextOwnership.owners[skill];
      delete config.links[skill];
    }
  }

  await saveConfig(config, homeDir);
  await saveSkillOwnershipState(homeDir, nextOwnership);

  if (action === RemovalAction.RemoveAll) {
    // Delete skill files
    for (const skill of ownedSkills) {
      const skillPath = join(skillsDir, skill);
      await rm(skillPath, { recursive: true, force: true });
    }
    // Delete source directory
    await rm(sourceDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/integration/source-remove.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/source.ts tests/integration/source-remove.test.ts
git commit -m "feat(source): add RemovalAction enum for flexible source removal"
```

---

### Task 3: Add Interactive Confirmation to CLI

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update imports in index.ts**

Add to imports in `src/index.ts`:

```typescript
import { select, confirm } from '@inquirer/prompts';
import {
  addSourceFromUrl,
  findOrphanSkills,
  formatSourceListLines,
  listSources,
  RemovalAction,
  removeSource,
  SourceType,
  updateAllSources,
  updateSource,
} from './source.js';
import { loadSkillOwnershipState } from './source.js';
import { listLocalSkillNames } from './manifest.js';
```

- [ ] **Step 2: Replace source remove command implementation**

Replace the `source remove` command section in `src/index.ts`:

```typescript
  sourceCommand
    .command('remove <name>')
    .description('Remove a configured source')
    .option('--force', 'Skip confirmation prompts')
    .action(async (name: string, options: { force?: boolean }) => {
      const config = await loadConfig(resolvedHomeDir);
      const source = config.sources[name];

      if (!source) {
        console.error(`Source not found: ${name}`);
        process.exit(1);
      }

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
      } else if (source.type === 'git') {
        // Git source: 3 options
        const choice = await select({
          message: `How do you want to remove source "${name}"?`,
          choices: [
            {
              name: 'Convert to local source (keep files, no more git updates)',
              value: RemovalAction.ConvertToLocal,
            },
            {
              name: 'Remove config + links only (keep skill files on disk)',
              value: RemovalAction.RemoveConfigKeepFiles,
            },
            {
              name: 'Remove everything (config, links, and skill files)',
              value: RemovalAction.RemoveAll,
            },
          ],
        });
        action = choice;
      } else {
        // HTTP/Local source: 2 options
        const choice = await select({
          message: `How do you want to remove source "${name}"?`,
          choices: [
            {
              name: 'Remove config + links only (keep skill files on disk)',
              value: RemovalAction.RemoveConfigKeepFiles,
            },
            {
              name: 'Remove everything (config, links, and skill files)',
              value: RemovalAction.RemoveAll,
            },
          ],
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

- [ ] **Step 3: Build and test manually**

Run:
```bash
npm run build
```
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): add interactive confirmation for source remove"
```

---

### Task 4: Export loadSkillOwnershipState and listLocalSkillNames

**Files:**
- Modify: `src/source.ts`
- Modify: `src/manifest.ts`

- [ ] **Step 1: Verify loadSkillOwnershipState is exported**

Check `src/source.ts` - if `loadSkillOwnershipState` is not exported, add `export` to the function:

```typescript
export async function loadSkillOwnershipState(homeDir: string): Promise<SkillOwnershipState> {
  // existing implementation
}
```

- [ ] **Step 2: Add listLocalSkillNames to manifest.ts if not present**

Check `src/manifest.ts`. If `listLocalSkillNames` doesn't exist, add:

```typescript
export async function listLocalSkillNames(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit if changes were needed**

```bash
git add src/source.ts src/manifest.ts
git commit -m "fix(source): export loadSkillOwnershipState and listLocalSkillNames"
```

---

### Task 5: Add Integration Test for Interactive Flow

**Files:**
- Modify: `tests/integration/source-remove.test.ts`

- [ ] **Step 1: Add test for orphan detection in CLI context**

Add to `tests/integration/source-remove.test.ts`:

```typescript
describe('findOrphanSkills integration', () => {
  it('correctly identifies orphan skills with real file structure', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-orphan-'));
    tempDirs.push(homeDir);
    const syncDir = join(homeDir, '.syncskill');
    const skillsDir = join(syncDir, 'skills');

    // Create skills directory with one manual skill
    await mkdir(join(skillsDir, 'manual-skill'), { recursive: true });
    await writeFile(join(skillsDir, 'manual-skill', 'SKILL.md'), 'manual');

    // Create source with two skills, one overlaps with manual
    await mkdir(join(syncDir, '.sources', 'test-source', 'materialized', 'skill-a'), { recursive: true });
    await mkdir(join(syncDir, '.sources', 'test-source', 'materialized', 'manual-skill'), { recursive: true });

    await writeFile(
      join(syncDir, 'config.yaml'),
      stringify({
        version: 1,
        agents: { claude: '~/.claude/skills' },
        links: {
          'skill-a': ['*'],
          'manual-skill': ['*'],
        },
        sources: {
          'test-source': { type: 'git', url: 'https://example.com/repo.git' },
        },
        servers: {},
        conflict_resolution: 'manual',
      })
    );

    await writeFile(
      join(syncDir, '.sources', 'ownership.json'),
      JSON.stringify({
        owners: {
          'skill-a': 'test-source',
          'manual-skill': 'test-source',
        },
      })
    );

    const config = await loadConfig(homeDir);
    const ownershipState = await loadSkillOwnershipState(homeDir);
    const localSkills = new Set(await listLocalSkillNames(homeDir));

    const orphans = findOrphanSkills('test-source', config, ownershipState, localSkills);

    // manual-skill exists in skillsDir, so not orphan
    // skill-a only from source, so orphan
    expect(orphans).toEqual(['skill-a']);
  });
});
```

- [ ] **Step 2: Run test to verify**

Run: `npm test -- tests/integration/source-remove.test.ts -t "findOrphanSkills integration"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/source-remove.test.ts
git commit -m "test(source): add integration test for orphan detection"
```

---

### Task 6: Update Spec and Documentation

**Files:**
- Modify: `docs/superpowers/specs/syncskill-design.md` (commit the staged changes)

- [ ] **Step 1: Verify spec changes are ready**

Run: `git diff docs/superpowers/specs/syncskill-design.md`
Expected: Shows the `source remove` interactive confirmation additions

- [ ] **Step 2: Stage and commit the spec**

```bash
git add docs/superpowers/specs/syncskill-design.md
git commit -m "docs(spec): add source remove interactive confirmation spec"
```

- [ ] **Step 3: Update anatomy.md if needed**

If any new files were created, update `.wolf/anatomy.md` accordingly.

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Add `findOrphanSkills()` function | 5 min |
| 2 | Add `RemovalAction` enum and enhance `removeSource()` | 10 min |
| 3 | Add interactive confirmation to CLI | 10 min |
| 4 | Export helper functions | 3 min |
| 5 | Add integration test for orphan detection | 5 min |
| 6 | Commit spec changes | 2 min |

**Total:** ~35 minutes
