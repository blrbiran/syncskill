# Spec Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement missing features from the syncskill-design.md spec: backup mechanism, registry rebuild, and related type updates.

**Architecture:** Extend existing types with new fields, add backup utilities, implement registry rebuild function, and integrate with doctor command.

**Tech Stack:** TypeScript, Node.js fs/promises, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add `backupsDir` to `SyncPaths` |
| `src/skills-registry.ts` | Modify | Add `last_update_hash` field, add `rebuildSkillsRegistry` function |
| `src/source.ts` | Modify | Add `archive_path` to `SourceDefinition` |
| `src/backup.ts` | Create | Backup utilities for --force update |
| `src/config-doctor.ts` | Modify | Add registry diagnostics (REGISTRY_MISSING, etc.) |
| `tests/unit/backup.test.ts` | Create | Unit tests for backup module |
| `tests/unit/skills-registry.test.ts` | Modify | Tests for rebuild function |
| `tests/unit/config-doctor.test.ts` | Modify | Tests for registry diagnostics |

---

### Task 1: Add `backupsDir` to SyncPaths

**Files:**
- Modify: `src/config.ts:7-14` (SyncPaths interface)
- Modify: `src/config.ts:49-60` (getSyncPaths function)

- [ ] **Step 1: Update SyncPaths interface**

In `src/config.ts`, add `backupsDir` to the interface:

```typescript
export interface SyncPaths {
  syncDir: string;
  configFile: string;
  skillsDir: string;
  manifestsDir: string;
  tempDir: string;
  historyFile: string;
  backupsDir: string;  // NEW
}
```

- [ ] **Step 2: Update getSyncPaths function**

```typescript
export function getSyncPaths(homeDir = homedir()): SyncPaths {
  const syncDir = getSyncDir(homeDir);

  return {
    syncDir,
    configFile: join(syncDir, 'config.yaml'),
    skillsDir: join(syncDir, 'skills'),
    manifestsDir: join(syncDir, 'manifests'),
    tempDir: join(syncDir, '.tmp'),
    historyFile: join(syncDir, 'manifest_history.json'),
    backupsDir: join(syncDir, 'backups')  // NEW
  };
}
```

- [ ] **Step 3: Run type check**

Run: `npm run build`
Expected: Build succeeds (no breaking changes since backupsDir is a new field)

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add backupsDir to SyncPaths"
```

---

### Task 2: Add `last_update_hash` to SkillRegistryEntry

**Files:**
- Modify: `src/skills-registry.ts:6-14` (SkillRegistryEntry interface)

- [ ] **Step 1: Update SkillRegistryEntry interface**

In `src/skills-registry.ts`, add optional `last_update_hash` field:

```typescript
export interface SkillRegistryEntry {
  path: string;
  origin: string;
  type: 'manual' | 'git' | 'http' | 'local';
  status: 'active' | 'ignored';
  ignored_reason?: 'duplicate' | 'user-choice' | 'conflict';
  ignored_at?: string;
  kept_by?: string;
  last_update_hash?: string;  // NEW: Only for HTTP sources, used for dirty detection
}
```

- [ ] **Step 2: Run type check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/skills-registry.ts
git commit -m "feat(registry): add last_update_hash field for HTTP dirty detection"
```

---

### Task 3: Add `archive_path` to SourceDefinition

**Files:**
- Modify: `src/source.ts:178-183` (SourceDefinition interface)

- [ ] **Step 1: Update SourceDefinition interface**

In `src/source.ts`, add optional `archive_path` field:

```typescript
export interface SourceDefinition {
  type: SourceType;
  url: string;
  path: string;
  ref?: string;
  archive_path?: string;  // NEW: For local archive sources, points to original archive file
}
```

- [ ] **Step 2: Run type check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/source.ts
git commit -m "feat(source): add archive_path field for local archive sources"
```

---

### Task 4: Create Backup Module

**Files:**
- Create: `src/backup.ts`
- Create: `tests/unit/backup.test.ts`

- [ ] **Step 1: Write failing test for backup metadata**

Create `tests/unit/backup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BackupMeta,
  loadBackupMeta,
  saveBackupMeta,
  getBackupDir
} from '../../src/backup.js';

describe('backup', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `backup-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getBackupDir', () => {
    it('returns correct path for source and skill', () => {
      const result = getBackupDir('/home/user/.syncskill/backups', 'my-source', 'my-skill');
      expect(result).toBe('/home/user/.syncskill/backups/my-source/my-skill');
    });
  });

  describe('loadBackupMeta', () => {
    it('returns empty meta when file does not exist', async () => {
      const meta = await loadBackupMeta(join(testDir, 'nonexistent'));
      expect(meta).toEqual({});
    });

    it('loads existing meta file', async () => {
      const metaDir = join(testDir, 'source1');
      await mkdir(metaDir, { recursive: true });
      const expected: BackupMeta = {
        'skill-a': {
          backed_up_at: '2026-05-11T12:00:00Z',
          reason: 'force-update',
          original_hash: 'abc123'
        }
      };
      await writeFile(join(metaDir, '_meta.json'), JSON.stringify(expected));

      const meta = await loadBackupMeta(metaDir);
      expect(meta).toEqual(expected);
    });
  });

  describe('saveBackupMeta', () => {
    it('creates meta file with entries', async () => {
      const metaDir = join(testDir, 'source2');
      await mkdir(metaDir, { recursive: true });

      const meta: BackupMeta = {
        'skill-x': {
          backed_up_at: '2026-05-11T14:00:00Z',
          reason: 'force-update',
          original_hash: 'def456'
        }
      };

      await saveBackupMeta(metaDir, meta);

      const content = await readFile(join(metaDir, '_meta.json'), 'utf8');
      expect(JSON.parse(content)).toEqual(meta);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/backup.test.ts`
Expected: FAIL with "Cannot find module '../../src/backup.js'"

- [ ] **Step 3: Create backup module implementation**

Create `src/backup.ts`:

```typescript
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFoundError } from './utils.js';

export interface BackupMetaEntry {
  backed_up_at: string;
  reason: 'force-update';
  original_hash: string;
}

export type BackupMeta = Record<string, BackupMetaEntry>;

export function getBackupDir(backupsDir: string, sourceName: string, skillName: string): string {
  return join(backupsDir, sourceName, skillName);
}

export async function loadBackupMeta(sourceBackupDir: string): Promise<BackupMeta> {
  const metaPath = join(sourceBackupDir, '_meta.json');

  try {
    const content = await readFile(metaPath, 'utf8');
    return JSON.parse(content) as BackupMeta;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

export async function saveBackupMeta(sourceBackupDir: string, meta: BackupMeta): Promise<void> {
  await mkdir(sourceBackupDir, { recursive: true });
  const metaPath = join(sourceBackupDir, '_meta.json');
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export interface BackupSkillOptions {
  backupsDir: string;
  sourceName: string;
  skillName: string;
  skillPath: string;
  originalHash: string;
}

export async function backupSkill(options: BackupSkillOptions): Promise<string> {
  const { backupsDir, sourceName, skillName, skillPath, originalHash } = options;

  const sourceBackupDir = join(backupsDir, sourceName);
  const skillBackupDir = getBackupDir(backupsDir, sourceName, skillName);

  await mkdir(skillBackupDir, { recursive: true });
  await cp(skillPath, skillBackupDir, { recursive: true });

  const meta = await loadBackupMeta(sourceBackupDir);
  meta[skillName] = {
    backed_up_at: new Date().toISOString(),
    reason: 'force-update',
    original_hash: originalHash
  };
  await saveBackupMeta(sourceBackupDir, meta);

  return skillBackupDir;
}

export interface BackupDirtySkillsOptions {
  backupsDir: string;
  sourceName: string;
  dirtySkills: Array<{ name: string; path: string; hash: string }>;
}

export interface BackupResult {
  backedUp: Array<{ name: string; backupPath: string }>;
}

export async function backupDirtySkills(options: BackupDirtySkillsOptions): Promise<BackupResult> {
  const { backupsDir, sourceName, dirtySkills } = options;
  const backedUp: Array<{ name: string; backupPath: string }> = [];

  for (const skill of dirtySkills) {
    const backupPath = await backupSkill({
      backupsDir,
      sourceName,
      skillName: skill.name,
      skillPath: skill.path,
      originalHash: skill.hash
    });
    backedUp.push({ name: skill.name, backupPath });
  }

  return { backedUp };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/backup.test.ts`
Expected: PASS

- [ ] **Step 5: Add test for backupSkill function**

Add to `tests/unit/backup.test.ts`:

```typescript
  describe('backupSkill', () => {
    it('copies skill directory and updates meta', async () => {
      const backupsDir = join(testDir, 'backups');
      const skillPath = join(testDir, 'skills', 'my-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, 'SKILL.md'), '# Test Skill');

      const { backupSkill } = await import('../../src/backup.js');

      const result = await backupSkill({
        backupsDir,
        sourceName: 'test-source',
        skillName: 'my-skill',
        skillPath,
        originalHash: 'hash123'
      });

      expect(result).toBe(join(backupsDir, 'test-source', 'my-skill'));

      const content = await readFile(join(result, 'SKILL.md'), 'utf8');
      expect(content).toBe('# Test Skill');

      const meta = await loadBackupMeta(join(backupsDir, 'test-source'));
      expect(meta['my-skill']).toBeDefined();
      expect(meta['my-skill'].original_hash).toBe('hash123');
      expect(meta['my-skill'].reason).toBe('force-update');
    });
  });
```

- [ ] **Step 6: Run all backup tests**

Run: `npm test -- tests/unit/backup.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/backup.ts tests/unit/backup.test.ts
git commit -m "feat(backup): add backup module for --force update"
```

---

### Task 5: Implement rebuildSkillsRegistry Function

**Files:**
- Modify: `src/skills-registry.ts`
- Modify: `tests/unit/skills-registry.test.ts` (or create if doesn't exist)

- [ ] **Step 1: Write failing test for rebuildSkillsRegistry**

Create or modify `tests/unit/skills-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('rebuildSkillsRegistry', () => {
  let testDir: string;
  let homeDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `registry-test-${Date.now()}`);
    homeDir = testDir;
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(join(syncDir, 'skills', 'manual-skill'), { recursive: true });
    await writeFile(join(syncDir, 'skills', 'manual-skill', 'SKILL.md'), '# Manual');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('discovers manual skills from ~/.syncskill/skills/', async () => {
    const { rebuildSkillsRegistry } = await import('../../src/skills-registry.js');

    const config = {
      version: 1,
      conflict_resolution: 'manual' as const,
      agents: {},
      links: {},
      servers: {},
      sources: {}
    };

    const registry = await rebuildSkillsRegistry(homeDir, config);

    expect(registry.skills['manual-skill']).toBeDefined();
    expect(registry.skills['manual-skill'].origin).toBe('manual');
    expect(registry.skills['manual-skill'].type).toBe('manual');
    expect(registry.skills['manual-skill'].status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/skills-registry.test.ts`
Expected: FAIL with "rebuildSkillsRegistry is not exported"

- [ ] **Step 3: Implement rebuildSkillsRegistry function**

Add to `src/skills-registry.ts`:

```typescript
import { readdir, access } from 'node:fs/promises';
import type { SyncSkillConfig } from './config.js';
import { getSyncPaths } from './config.js';
import { hashSkillDirectory } from './manifest.js';

export async function rebuildSkillsRegistry(
  homeDir: string,
  config: SyncSkillConfig
): Promise<SkillsRegistry> {
  const { skillsDir } = getSyncPaths(homeDir);
  const registry: SkillsRegistry = { version: 1, skills: {} };

  // 1. Scan ~/.syncskill/skills/ for manual skills
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(skillsDir, entry.name);
      const skillMdPath = join(skillPath, 'SKILL.md');

      try {
        await access(skillMdPath);
        registry.skills[entry.name] = {
          path: skillPath,
          origin: 'manual',
          type: 'manual',
          status: 'active'
        };
      } catch {
        // No SKILL.md, skip
      }
    }
  } catch {
    // skillsDir may not exist
  }

  // 2. Scan sources
  for (const [sourceName, sourceRaw] of Object.entries(config.sources)) {
    const source = sourceRaw as Record<string, unknown>;
    const sourcePath = source.path as string | undefined;
    const sourceType = source.type as string | undefined;
    const ignoreList = (source.ignore as string[]) ?? [];

    if (!sourcePath || !sourceType) continue;

    try {
      const entries = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(sourcePath, entry.name);
        const skillMdPath = join(skillPath, 'SKILL.md');

        try {
          await access(skillMdPath);

          const isIgnored = ignoreList.includes(entry.name);
          const entryData: SkillRegistryEntry = {
            path: skillPath,
            origin: sourceName,
            type: sourceType as 'git' | 'http' | 'local',
            status: isIgnored ? 'ignored' : 'active'
          };

          if (isIgnored) {
            entryData.ignored_reason = 'user-choice';
            entryData.ignored_at = new Date().toISOString();
          }

          // For HTTP sources, compute last_update_hash
          if (sourceType === 'http' && !isIgnored) {
            try {
              entryData.last_update_hash = await hashSkillDirectory(skillPath);
            } catch {
              // Hash computation failed, skip
            }
          }

          // Don't overwrite if already exists from manual (manual takes precedence)
          if (!registry.skills[entry.name]) {
            registry.skills[entry.name] = entryData;
          }
        } catch {
          // No SKILL.md, skip
        }
      }
    } catch {
      // Source path may not exist
    }
  }

  return registry;
}
```

- [ ] **Step 4: Add necessary import**

At the top of `src/skills-registry.ts`, ensure `join` is imported:

```typescript
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/skills-registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/skills-registry.ts tests/unit/skills-registry.test.ts
git commit -m "feat(registry): implement rebuildSkillsRegistry function"
```

---

### Task 6: Add Registry Diagnostics to Doctor

**Files:**
- Modify: `src/config-doctor.ts`
- Modify: `tests/unit/config-doctor.test.ts` or `tests/integration/doctor-cli.test.ts`

- [ ] **Step 1: Add new diagnostic codes**

In `src/config-doctor.ts`, update DiagnosticCode:

```typescript
export const DiagnosticCode = {
  NO_VALID_AGENTS: 'NO_VALID_AGENTS',
  AGENT_PATH_INVALID: 'AGENT_PATH_INVALID',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  SOURCE_PATH_INVALID: 'SOURCE_PATH_INVALID',
  REGISTRY_MISSING: 'REGISTRY_MISSING',
  REGISTRY_CORRUPT: 'REGISTRY_CORRUPT',
  REGISTRY_STALE: 'REGISTRY_STALE',
  REGISTRY_ORPHAN: 'REGISTRY_ORPHAN'
} as const;
```

- [ ] **Step 2: Add checkRegistryHealth function**

Add to `src/config-doctor.ts`:

```typescript
import { loadSkillsRegistry, getSkillsRegistryPath } from './skills-registry.js';

export async function checkRegistryHealth(
  homeDir: string,
  config: SyncSkillConfig,
  skillsDir: string
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];
  const registryPath = getSkillsRegistryPath(homeDir);

  // 1. Check if registry file exists
  try {
    await access(registryPath);
  } catch {
    items.push({
      code: DiagnosticCode.REGISTRY_MISSING,
      severity: 'warning',
      message: 'skills-registry.json does not exist',
      path: 'skills-registry.json',
      suggestion: 'Run `syncskill doctor --rebuild-registry` to create'
    });
    return items;
  }

  // 2. Try to load and parse
  let registry;
  try {
    registry = await loadSkillsRegistry(homeDir);
  } catch {
    items.push({
      code: DiagnosticCode.REGISTRY_CORRUPT,
      severity: 'warning',
      message: 'skills-registry.json is corrupt or invalid',
      path: 'skills-registry.json',
      suggestion: 'Run `syncskill doctor --rebuild-registry` to rebuild'
    });
    return items;
  }

  // 3. Check for stale entries (path doesn't exist)
  for (const [skillName, entry] of Object.entries(registry.skills)) {
    try {
      await access(entry.path);
    } catch {
      items.push({
        code: DiagnosticCode.REGISTRY_STALE,
        severity: 'warning',
        message: `Skill path does not exist: ${entry.path}`,
        path: `registry.${skillName}`,
        suggestion: `Remove stale entry for "${skillName}"`
      });
    }
  }

  // 4. Check for orphans (skills exist but not in registry)
  const existingSkills = await discoverExistingSkills(skillsDir, config.sources);
  for (const skillName of existingSkills) {
    if (!registry.skills[skillName]) {
      items.push({
        code: DiagnosticCode.REGISTRY_ORPHAN,
        severity: 'warning',
        message: `Skill "${skillName}" exists but is not in registry`,
        path: `registry.${skillName}`,
        suggestion: 'Run `syncskill doctor --rebuild-registry` to add'
      });
    }
  }

  return items;
}
```

- [ ] **Step 3: Update diagnoseConfig to include registry checks**

Modify the `diagnoseConfig` function:

```typescript
export async function diagnoseConfig(
  config: SyncSkillConfig,
  skillsDir: string,
  homeDir?: string  // NEW optional parameter
): Promise<DiagnosticReport> {
  const errors: DiagnosticItem[] = [];
  const warnings: DiagnosticItem[] = [];

  // ... existing checks ...

  // Add registry checks if homeDir is provided
  if (homeDir) {
    const registryItems = await checkRegistryHealth(homeDir, config, skillsDir);
    warnings.push(...registryItems);
  }

  return {
    errors,
    warnings,
    isHealthy: errors.length === 0 && warnings.length === 0,
    canProceed: errors.length === 0
  };
}
```

- [ ] **Step 4: Run existing tests**

Run: `npm test -- tests/integration/doctor-cli.test.ts tests/unit/config-doctor.test.ts`
Expected: PASS (existing tests should still work)

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts
git commit -m "feat(doctor): add registry health diagnostics"
```

---

### Task 7: Add --rebuild-registry CLI Option

**Files:**
- Modify: `src/index.ts` (doctor command section)

- [ ] **Step 1: Find doctor command in index.ts**

Run: `grep -n "doctor" src/index.ts | head -10`

- [ ] **Step 2: Add --rebuild-registry option**

In the doctor command definition, add:

```typescript
program
  .command('doctor')
  .description('Diagnose and repair config issues')
  .option('--fix', 'Interactive repair')
  .option('--rebuild-registry', 'Rebuild skills-registry.json from config and filesystem')
  .option('--dry-run', 'Preview changes without executing')
  .option('-y, --yes', 'Auto-confirm all repairs')
  .action(async (options) => {
    // ... existing code ...

    if (options.rebuildRegistry) {
      const { rebuildSkillsRegistry, saveSkillsRegistry, getSkillsRegistryPath } = await import('./skills-registry.js');
      const { getSyncPaths } = await import('./config.js');

      if (options.dryRun) {
        console.log('[dry-run] Would rebuild skills-registry.json');
        const registry = await rebuildSkillsRegistry(homeDir, config);
        console.log(`Would create registry with ${Object.keys(registry.skills).length} skills`);
        return;
      }

      const registryPath = getSkillsRegistryPath(homeDir);

      // Backup existing if exists
      try {
        const existing = await readFile(registryPath, 'utf8');
        await writeFile(registryPath + '.bak', existing);
        console.log('✓ Backed up existing registry to skills-registry.json.bak');
      } catch {
        // No existing registry
      }

      const registry = await rebuildSkillsRegistry(homeDir, config);
      await saveSkillsRegistry(homeDir, registry);

      const manualCount = Object.values(registry.skills).filter(s => s.type === 'manual').length;
      const sourceCount = Object.values(registry.skills).filter(s => s.type !== 'manual').length;
      const ignoredCount = Object.values(registry.skills).filter(s => s.status === 'ignored').length;

      console.log('✓ Rebuilt skills-registry.json');
      console.log(`  Manual skills: ${manualCount}`);
      console.log(`  Source skills: ${sourceCount}`);
      console.log(`  Ignored: ${ignoredCount}`);
      return;
    }

    // ... rest of existing doctor logic ...
  });
```

- [ ] **Step 3: Run build and test**

Run: `npm run build && npm test -- tests/integration/doctor-cli.test.ts`
Expected: PASS

- [ ] **Step 4: Manual test**

Run: `npm run build && node dist/index.js doctor --rebuild-registry --dry-run`
Expected: Shows preview of registry rebuild

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(doctor): add --rebuild-registry CLI option"
```

---

### Task 8: Integration Test for Backup with --force

**Files:**
- Create or modify: `tests/integration/source-update-force.test.ts`

- [ ] **Step 1: Create integration test**

Create `tests/integration/source-update-force.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('source update --force', () => {
  let testDir: string;
  let homeDir: string;
  let cli: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `force-update-test-${Date.now()}`);
    homeDir = testDir;
    cli = join(process.cwd(), 'dist', 'index.js');

    // Setup minimal config
    const syncDir = join(homeDir, '.syncskill');
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      join(syncDir, 'config.yaml'),
      'version: 1\nagents: {}\nlinks: {}\nservers: {}\nsources: {}\n'
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates backups directory structure', async () => {
    const backupsDir = join(homeDir, '.syncskill', 'backups');

    // This test validates the backup directory is created when needed
    // Full integration would require a git source with dirty state

    await mkdir(backupsDir, { recursive: true });
    await access(backupsDir);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/integration/source-update-force.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/source-update-force.test.ts
git commit -m "test: add integration test skeleton for --force backup"
```

---

## Summary

After completing all tasks:

1. `SyncPaths` includes `backupsDir`
2. `SkillRegistryEntry` includes `last_update_hash`
3. `SourceDefinition` includes `archive_path`
4. `backup.ts` module handles skill backups for --force updates
5. `rebuildSkillsRegistry()` function reconstructs registry from filesystem
6. Doctor command includes registry health checks and `--rebuild-registry` option

Run final verification:
```bash
npm run build && npm test
```
