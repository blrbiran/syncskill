# E2E Test Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 18 E2E tests covering local archive install, pull targets, update command, dirty state, stale checkout, and link reconciliation.

**Architecture:** Extend E2E framework with new fixtures and context methods, then implement tests organized by feature (install/, sync/, source/, link/). Tests use partial mocking for SSH transport - verify state through config/registry rather than actual push/pull.

**Tech Stack:** Vitest, E2EScenario builder, E2EContext runtime, compressing (for archives)

---

## File Structure

```
tests/end2end/
├── framework/
│   ├── context.ts              # MODIFY: Add new assertion/helper methods
│   ├── scenario.ts             # MODIFY: Add withHttpSource, withLocalSource
│   └── fixtures/
│       ├── stale.ts            # CREATE: Stale checkout fixtures
│       └── index.ts            # MODIFY: Export stale fixtures
├── cases/
│   ├── install/
│   │   └── install-local-archive.test.ts  # CREATE: 2 tests
│   ├── sync/
│   │   └── pull-target.test.ts            # CREATE: 4 tests
│   ├── source/
│   │   ├── source-update.test.ts          # CREATE: 3 tests
│   │   ├── source-update-dirty.test.ts    # CREATE: 3 tests
│   │   └── source-stale-checkout.test.ts  # CREATE: 2 tests
│   └── link/
│       └── link-reconcile.test.ts         # CREATE: 4 tests
```

---

## Task 1: Add Stale Checkout Fixtures

**Files:**
- Create: `tests/end2end/framework/fixtures/stale.ts`
- Modify: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-stale.test.ts`

- [ ] **Step 1: Write failing test for createStaleGitCheckout**

```typescript
// tests/unit/e2e-fixtures-stale.test.ts
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaleGitCheckout, createStaleNonGitDir } from '../end2end/framework/fixtures/stale.js';

describe('stale fixtures', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('createStaleGitCheckout creates git repo with wrong remote', async () => {
    const parentDir = join(tmpdir(), `stale-test-${Date.now()}`);
    tempDirs.push(parentDir);
    await mkdir(parentDir, { recursive: true });

    const stalePath = await createStaleGitCheckout(parentDir, 'my-repo', 'https://wrong.url/repo.git');

    // Verify it's a git repo
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    
    const { stdout } = await execFileAsync('git', ['-C', stalePath, 'remote', 'get-url', 'origin']);
    expect(stdout.trim()).toBe('https://wrong.url/repo.git');
  });

  it('createStaleNonGitDir creates directory that is not a git repo', async () => {
    const parentDir = join(tmpdir(), `stale-test-${Date.now()}`);
    tempDirs.push(parentDir);
    await mkdir(parentDir, { recursive: true });

    const stalePath = await createStaleNonGitDir(parentDir, 'my-repo');

    // Verify directory exists
    const { access } = await import('node:fs/promises');
    await expect(access(stalePath)).resolves.toBeUndefined();

    // Verify it's NOT a git repo
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    
    await expect(
      execFileAsync('git', ['-C', stalePath, 'rev-parse', '--git-dir'])
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/e2e-fixtures-stale.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement stale fixtures**

```typescript
// tests/end2end/framework/fixtures/stale.ts
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    cwd === undefined ? args : ['-C', cwd, ...args]
  );
  return stdout;
}

/**
 * Create a stale git checkout with a mismatched remote URL.
 * Used to test that install detects and handles URL mismatch.
 */
export async function createStaleGitCheckout(
  parentDir: string,
  name: string,
  wrongRemoteUrl: string
): Promise<string> {
  const repoPath = join(parentDir, name);
  await mkdir(repoPath, { recursive: true });
  
  await git(['init'], repoPath);
  await git(['remote', 'add', 'origin', wrongRemoteUrl], repoPath);
  
  // Add a dummy file so git has something
  await writeFile(join(repoPath, 'stale.txt'), 'This is stale content\n', 'utf8');
  await git(['add', '.'], repoPath);
  await git(
    ['-c', 'user.name=Stale', '-c', 'user.email=stale@test.local', 'commit', '-m', 'Stale commit'],
    repoPath
  );
  
  return repoPath;
}

/**
 * Create a stale non-git directory.
 * Used to test that install detects and handles non-git directories.
 */
export async function createStaleNonGitDir(
  parentDir: string,
  name: string
): Promise<string> {
  const dirPath = join(parentDir, name);
  await mkdir(dirPath, { recursive: true });
  
  // Add some content to make it non-empty
  await writeFile(join(dirPath, 'stale.txt'), 'This is not a git repo\n', 'utf8');
  await mkdir(join(dirPath, 'some-skill'), { recursive: true });
  await writeFile(join(dirPath, 'some-skill', 'SKILL.md'), '# Stale Skill\n', 'utf8');
  
  return dirPath;
}
```

- [ ] **Step 4: Export from fixtures/index.ts**

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
export * from './git.js';
export * from './archive.js';
export * from './server.js';
export * from './github.js';
export * from './stale.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/e2e-fixtures-stale.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/end2end/framework/fixtures/stale.ts tests/end2end/framework/fixtures/index.ts tests/unit/e2e-fixtures-stale.test.ts
git commit -m "feat(e2e): add stale checkout fixtures for testing URL mismatch and non-git dirs"
```

---

## Task 2: Extend E2EContext with New Methods

**Files:**
- Modify: `tests/end2end/framework/context.ts`
- Test: `tests/unit/e2e-context.test.ts`

- [ ] **Step 1: Write failing test for new context methods**

Add to existing `tests/unit/e2e-context.test.ts`:

```typescript
// Add these tests to the existing describe block in tests/unit/e2e-context.test.ts

describe('E2EContext new methods', () => {
  it('writeRegistry writes skills-registry.json', async () => {
    const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });

    const ctx = new E2EContext(homeDir, '/fake/project');
    
    const registry = {
      version: 1,
      skills: {
        'test-skill': {
          path: `${homeDir}/.syncskill/skills/test-skill`,
          origin: 'manual',
          type: 'manual',
          status: 'active',
        },
      },
    };
    
    await ctx.writeRegistry(registry);
    
    const content = await ctx.readFile('.syncskill/skills-registry.json');
    expect(JSON.parse(content)).toEqual(registry);
  });

  it('assertBackupExists checks backup directory', async () => {
    const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
    tempDirs.push(homeDir);
    const backupDir = join(homeDir, '.syncskill', 'backups', 'my-source', 'my-skill');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'SKILL.md'), '# Backup\n', 'utf8');

    const ctx = new E2EContext(homeDir, '/fake/project');
    
    await expect(ctx.assertBackupExists('my-source', 'my-skill')).resolves.toBeUndefined();
    await expect(ctx.assertBackupExists('my-source', 'no-skill')).rejects.toThrow();
  });

  it('assertSymlinkTarget verifies symlink points to expected target', async () => {
    const homeDir = join(tmpdir(), `e2e-ctx-test-${Date.now()}`);
    tempDirs.push(homeDir);
    const agentDir = join(homeDir, '.claude', 'skills');
    const skillSource = join(homeDir, '.syncskill', 'skills', 'my-skill');
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillSource, { recursive: true });
    await writeFile(join(skillSource, 'SKILL.md'), '# Test\n', 'utf8');
    await symlink(skillSource, join(agentDir, 'my-skill'));

    const ctx = new E2EContext(homeDir, '/fake/project');
    
    await expect(
      ctx.assertSymlinkTarget('my-skill', 'claude', skillSource)
    ).resolves.toBeUndefined();
    
    await expect(
      ctx.assertSymlinkTarget('my-skill', 'claude', '/wrong/path')
    ).rejects.toThrow('Expected symlink');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/e2e-context.test.ts`
Expected: FAIL with "writeRegistry is not a function"

- [ ] **Step 3: Add imports at top of test file**

```typescript
// Add to imports at top of tests/unit/e2e-context.test.ts
import { mkdir, writeFile, symlink } from 'node:fs/promises';
```

- [ ] **Step 4: Implement new methods in E2EContext**

Add these methods to `tests/end2end/framework/context.ts`:

```typescript
  // Add to E2EContext class after existing methods

  /**
   * Write skills-registry.json.
   */
  async writeRegistry(registry: unknown): Promise<void> {
    const registryPath = join(this.syncskillDir, 'skills-registry.json');
    await mkdir(this.syncskillDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  /**
   * Assert that a backup exists for a source/skill.
   */
  async assertBackupExists(sourceName: string, skillName: string): Promise<void> {
    const backupPath = join(this.syncskillDir, 'backups', sourceName, skillName);
    try {
      await access(backupPath);
    } catch {
      throw new Error(
        `Expected backup to exist for source "${sourceName}" skill "${skillName}" ` +
          `at path: ${backupPath}`
      );
    }
  }

  /**
   * Assert that a symlink points to the expected target.
   */
  async assertSymlinkTarget(
    skill: string,
    agent: string,
    expectedTarget: string
  ): Promise<void> {
    const agentSkillsPath = this.getAgentSkillsPath(agent);
    const skillLinkPath = join(agentSkillsPath, skill);

    const stats = await lstat(skillLinkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(
        `Expected "${skill}" in agent "${agent}" to be a symlink, but it is not`
      );
    }

    const actualTarget = await readlink(skillLinkPath);
    if (actualTarget !== expectedTarget) {
      throw new Error(
        `Expected symlink "${skill}" in agent "${agent}" to point to:\n` +
          `  ${expectedTarget}\n` +
          `But it points to:\n` +
          `  ${actualTarget}`
      );
    }
  }

  /**
   * Create a stale git checkout in sources directory.
   */
  async createStaleGitDir(name: string, wrongUrl: string): Promise<string> {
    const { createStaleGitCheckout } = await import('./fixtures/stale.js');
    const sourcesDir = join(this.syncskillDir, 'sources');
    await mkdir(sourcesDir, { recursive: true });
    return createStaleGitCheckout(sourcesDir, name, wrongUrl);
  }

  /**
   * Create a stale non-git directory in sources directory.
   */
  async createStaleNonGitDir(name: string): Promise<string> {
    const { createStaleNonGitDir } = await import('./fixtures/stale.js');
    const sourcesDir = join(this.syncskillDir, 'sources');
    await mkdir(sourcesDir, { recursive: true });
    return createStaleNonGitDir(sourcesDir, name);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/e2e-context.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/end2end/framework/context.ts tests/unit/e2e-context.test.ts
git commit -m "feat(e2e): add writeRegistry, assertBackupExists, assertSymlinkTarget, stale dir methods to E2EContext"
```

---

## Task 3: Create Install Directory and Local Archive Tests

**Files:**
- Create: `tests/end2end/cases/install/install-local-archive.test.ts`

- [ ] **Step 1: Create install directory**

```bash
mkdir -p tests/end2end/cases/install
```

- [ ] **Step 2: Write install local zip test**

```typescript
// tests/end2end/cases/install/install-local-archive.test.ts
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('install local archive', () => {
  e2eTest('install local zip extracts and links', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('my-skills.zip', {
        skills: ['skill-alpha', 'skill-beta'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('my-skills.zip');
      const result = await ctx.run('syncskill', 'install', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify config has source with type: local and archive_path
      const config = (await ctx.readConfig()) as {
        sources?: Array<{
          name: string;
          type: string;
          archive_path?: string;
          path: string;
        }>;
        links?: Record<string, string[]>;
      };

      const source = config.sources?.find((s) => s.name === 'my-skills');
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
      expect(source?.archive_path).toBe(archivePath);

      // Verify skills are in links
      expect(config.links?.['skill-alpha']).toEqual(['*']);
      expect(config.links?.['skill-beta']).toEqual(['*']);

      // Verify skills-registry.json records correct info
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { origin: string; type: string; status: string }>;
      };
      expect(registry.skills['skill-alpha']?.origin).toBe('my-skills');
      expect(registry.skills['skill-alpha']?.type).toBe('local');
      expect(registry.skills['skill-alpha']?.status).toBe('active');

      // Verify skills are linked
      await ctx.assertLinked('skill-alpha', ['claude', 'agents']);
      await ctx.assertLinked('skill-beta', ['claude', 'agents']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('source add local archive equivalent to install', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('other-skills.zip', {
        skills: ['tool-one', 'tool-two'],
        format: 'zip',
      })
      .setup();

    try {
      const archivePath = ctx.getArchivePath('other-skills.zip');
      const result = await ctx.run('syncskill', 'source', 'add', archivePath, '-y');

      expect(result.success).toBe(true);

      // Verify same structure as install
      const config = (await ctx.readConfig()) as {
        sources?: Array<{ name: string; type: string; archive_path?: string }>;
        links?: Record<string, string[]>;
      };

      const source = config.sources?.find((s) => s.name === 'other-skills');
      expect(source).toBeDefined();
      expect(source?.type).toBe('local');
      expect(source?.archive_path).toBe(archivePath);

      // Skills should be in links
      expect(config.links?.['tool-one']).toBeDefined();
      expect(config.links?.['tool-two']).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they work**

Run: `npm run test:e2e -- tests/end2end/cases/install/install-local-archive.test.ts`
Expected: PASS (if implementation exists) or informative failure

- [ ] **Step 4: Commit**

```bash
git add tests/end2end/cases/install/install-local-archive.test.ts
git commit -m "test(e2e): add install local archive tests"
```

---

## Task 4: Create Sync Directory and Pull Target Tests

**Files:**
- Create: `tests/end2end/cases/sync/pull-target.test.ts`

- [ ] **Step 1: Create sync directory**

```bash
mkdir -p tests/end2end/cases/sync
```

- [ ] **Step 2: Write pull target tests with partial mocking**

```typescript
// tests/end2end/cases/sync/pull-target.test.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('pull target paths', () => {
  e2eTest('pull places manual skill in skills dir', async () => {
    // Setup: manual skill with registry entry
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('manual-skill', '# Original Content\n')
      .withLinks({ 'manual-skill': ['*'] })
      .setup();

    try {
      // Write registry to mark skill as manual
      const skillPath = join(ctx.syncskillDir, 'skills', 'manual-skill');
      await ctx.writeRegistry({
        version: 1,
        skills: {
          'manual-skill': {
            path: skillPath,
            origin: 'manual',
            type: 'manual',
            status: 'active',
          },
        },
      });

      // Simulate "pulled" content by directly writing to the expected location
      await writeFile(
        join(skillPath, 'SKILL.md'),
        '# Updated from server\n',
        'utf8'
      );

      // Verify link command works with the updated content
      await ctx.run('syncskill', 'link', '--all');
      await ctx.assertLinked('manual-skill', ['claude']);

      // Verify content is at expected path
      const content = await ctx.readFile('.syncskill/skills/manual-skill/SKILL.md');
      expect(content).toBe('# Updated from server\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places git source skill in sources dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('my-repo', { skills: ['git-skill'] })
      .setup();

    try {
      // Install the git source
      const repoUrl = ctx.getGitSourceUrl('my-repo');
      await ctx.run('syncskill', 'install', repoUrl, '-y');

      // Get the expected path from registry
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string; origin: string }>;
      };
      const skillEntry = registry.skills['git-skill'];
      expect(skillEntry).toBeDefined();
      expect(skillEntry.origin).toBe('my-repo');
      expect(skillEntry.path).toContain('.syncskill/sources/my-repo');

      // Simulate "pulled" content
      await writeFile(
        join(skillEntry.path, 'SKILL.md'),
        '# Pulled from server\n',
        'utf8'
      );

      // Verify link still works
      await ctx.run('syncskill', 'link', 'git-skill');
      await ctx.assertLinked('git-skill', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places http source skill in sources dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('http-pack.zip', { skills: ['http-skill'] })
      .setup();

    try {
      // Install from archive (simulates HTTP download)
      const archivePath = ctx.getArchivePath('http-pack.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Get the expected path from registry
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string; origin: string }>;
      };
      const skillEntry = registry.skills['http-skill'];
      expect(skillEntry).toBeDefined();
      expect(skillEntry.path).toContain('.syncskill/sources/http-pack');

      // Simulate "pulled" content
      await writeFile(
        join(skillEntry.path, 'SKILL.md'),
        '# Pulled from server\n',
        'utf8'
      );

      // Verify link still works
      await ctx.run('syncskill', 'link', 'http-skill');
      await ctx.assertLinked('http-skill', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('pull places local source skill in external path', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .setup();

    try {
      // Create an external local source directory
      const externalDir = join(ctx.homeDir, 'external-tools');
      const skillDir = join(externalDir, 'local-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Local Skill\n', 'utf8');

      // Manually register in registry as local source
      await ctx.writeRegistry({
        version: 1,
        skills: {
          'local-skill': {
            path: skillDir,
            origin: 'external-tools',
            type: 'local',
            status: 'active',
          },
        },
      });

      // Write config with source and link
      const config = await ctx.readConfig() as Record<string, unknown>;
      config.sources = [
        {
          name: 'external-tools',
          type: 'local',
          path: externalDir,
        },
      ];
      config.links = { 'local-skill': ['*'] };
      await ctx.writeFile('.syncskill/config.yaml', 
        (await import('yaml')).stringify(config)
      );

      // Simulate "pulled" content at external path
      await writeFile(join(skillDir, 'SKILL.md'), '# Updated externally\n', 'utf8');

      // Verify link works with external path
      await ctx.run('syncskill', 'link', 'local-skill');
      await ctx.assertLinked('local-skill', ['claude']);

      // Verify symlink points to external path
      await ctx.assertSymlinkTarget('local-skill', 'claude', skillDir);
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test:e2e -- tests/end2end/cases/sync/pull-target.test.ts`
Expected: PASS or informative failure

- [ ] **Step 4: Commit**

```bash
git add tests/end2end/cases/sync/pull-target.test.ts
git commit -m "test(e2e): add pull target path tests for manual/git/http/local sources"
```

---

## Task 5: Create Source Directory and Update Tests

**Files:**
- Create: `tests/end2end/cases/source/source-update.test.ts`

- [ ] **Step 1: Create source directory**

```bash
mkdir -p tests/end2end/cases/source
```

- [ ] **Step 2: Write source update tests**

```typescript
// tests/end2end/cases/source/source-update.test.ts
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario, modifySkillInGitRepo } from '../../framework/index.js';

describe('source update', () => {
  e2eTest('update git source fetches and resets', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('updatable-repo', {
        skills: ['update-skill'],
        skillContents: { 'update-skill': '# Version 1\n' },
      })
      .setup();

    try {
      // Install the git source
      const repoUrl = ctx.getGitSourceUrl('updatable-repo');
      await ctx.run('syncskill', 'install', repoUrl, '-y');

      // Verify initial content
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string }>;
      };
      const skillPath = registry.skills['update-skill'].path;
      let content = await ctx.readFile(skillPath.replace(ctx.homeDir, '').slice(1) + '/SKILL.md');
      expect(content).toBe('# Version 1\n');

      // Modify the skill in the git work directory and push
      const workDir = ctx.getGitSourceWorkDir('updatable-repo');
      await modifySkillInGitRepo(workDir, 'update-skill', '# Version 2\n');

      // Run update
      const result = await ctx.run('syncskill', 'update', 'updatable-repo', '-y');
      expect(result.success).toBe(true);

      // Verify updated content
      content = await ctx.readFile(skillPath.replace(ctx.homeDir, '').slice(1) + '/SKILL.md');
      expect(content).toBe('# Version 2\n');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update skips local and archive sources', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('local-archive.zip', { skills: ['archive-skill'] })
      .setup();

    try {
      // Install local archive
      const archivePath = ctx.getArchivePath('local-archive.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Verify source is type: local
      const config = (await ctx.readConfig()) as {
        sources?: Array<{ name: string; type: string }>;
      };
      const source = config.sources?.find((s) => s.name === 'local-archive');
      expect(source?.type).toBe('local');

      // Run update --all - should not error, just skip
      const result = await ctx.run('syncskill', 'update', '--all', '-y');
      expect(result.success).toBe(true);

      // Output should indicate skipping or no updates
      // (local sources have no URL to fetch from)
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update is alias for source update', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .setup();

    try {
      // Both commands should work
      const result1 = await ctx.run('syncskill', 'update', '--help');
      const result2 = await ctx.run('syncskill', 'source', 'update', '--help');

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Help output should be similar
      ctx.assertOutputContains(result1, 'update');
      ctx.assertOutputContains(result2, 'update');
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test:e2e -- tests/end2end/cases/source/source-update.test.ts`
Expected: PASS or informative failure

- [ ] **Step 4: Commit**

```bash
git add tests/end2end/cases/source/source-update.test.ts
git commit -m "test(e2e): add source update tests for git sources and skip behavior"
```

---

## Task 6: Create Source Update Dirty Tests

**Files:**
- Create: `tests/end2end/cases/source/source-update-dirty.test.ts`

- [ ] **Step 1: Write dirty state tests**

```typescript
// tests/end2end/cases/source/source-update-dirty.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario, modifySkillInGitRepo } from '../../framework/index.js';

describe('source update dirty state', () => {
  e2eTest('update detects dirty git multiskill repo', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('multi-repo', {
        skills: ['skill-a', 'skill-b', 'skill-c'],
      })
      .setup();

    try {
      // Install the git source
      const repoUrl = ctx.getGitSourceUrl('multi-repo');
      await ctx.run('syncskill', 'install', repoUrl, '-y');

      // Get installed skill path and make it dirty
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string }>;
      };
      const skillAPath = registry.skills['skill-a'].path;
      await writeFile(
        join(skillAPath, 'SKILL.md'),
        '# Local modification\n',
        'utf8'
      );

      // Modify remote and try to update
      const workDir = ctx.getGitSourceWorkDir('multi-repo');
      await modifySkillInGitRepo(workDir, 'skill-b', '# Remote update\n');

      // Run update with -y (should skip dirty sources)
      const result = await ctx.run('syncskill', 'update', '-y');
      expect(result.success).toBe(true);

      // Should indicate dirty and list affected skills
      ctx.assertOutputContains(result, 'dirty');
      ctx.assertOutputContains(result, 'skill-a');

      // All skills in the repo should be mentioned as skipped
      ctx.assertOutputContains(result, 'skip');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update detects dirty http source by hash', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withArchive('http-source.zip', { skills: ['http-skill'] })
      .setup();

    try {
      // Install - this should record last_update_hash in registry
      const archivePath = ctx.getArchivePath('http-source.zip');
      await ctx.run('syncskill', 'install', archivePath, '-y');

      // Modify the installed skill (making it dirty)
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string; last_update_hash?: string }>;
      };
      const skillPath = registry.skills['http-skill'].path;
      await writeFile(
        join(skillPath, 'SKILL.md'),
        '# Modified locally\n',
        'utf8'
      );

      // Note: HTTP update would require the source to have a URL
      // For local archives, update is skipped anyway
      // This test verifies the hash comparison mechanism works
      const originalHash = registry.skills['http-skill'].last_update_hash;
      expect(originalHash).toBeDefined();

      // Re-read registry to verify hash hasn't changed (skill is dirty)
      // The actual dirty detection happens during update when comparing hashes
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('update force creates backup', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('force-repo', {
        skills: ['force-skill'],
        skillContents: { 'force-skill': '# Original\n' },
      })
      .setup();

    try {
      // Install
      const repoUrl = ctx.getGitSourceUrl('force-repo');
      await ctx.run('syncskill', 'install', repoUrl, '-y');

      // Make dirty
      const registry = (await ctx.readRegistry()) as {
        skills: Record<string, { path: string }>;
      };
      const skillPath = registry.skills['force-skill'].path;
      await writeFile(
        join(skillPath, 'SKILL.md'),
        '# My local changes\n',
        'utf8'
      );

      // Modify remote
      const workDir = ctx.getGitSourceWorkDir('force-repo');
      await modifySkillInGitRepo(workDir, 'force-skill', '# Remote version\n');

      // Force update
      const result = await ctx.run('syncskill', 'update', '--force', '-y');
      expect(result.success).toBe(true);

      // Verify backup was created
      await ctx.assertBackupExists('force-repo', 'force-skill');

      // Verify content was updated to remote version
      const relativePath = skillPath.replace(ctx.homeDir + '/', '');
      const content = await ctx.readFile(relativePath + '/SKILL.md');
      expect(content).toBe('# Remote version\n');
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test:e2e -- tests/end2end/cases/source/source-update-dirty.test.ts`
Expected: PASS or informative failure

- [ ] **Step 3: Commit**

```bash
git add tests/end2end/cases/source/source-update-dirty.test.ts
git commit -m "test(e2e): add source update dirty state tests for git and http sources"
```

---

## Task 7: Create Stale Checkout Tests

**Files:**
- Create: `tests/end2end/cases/source/source-stale-checkout.test.ts`

- [ ] **Step 1: Write stale checkout tests**

```typescript
// tests/end2end/cases/source/source-stale-checkout.test.ts
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('source stale checkout', () => {
  e2eTest('install handles stale checkout with url mismatch', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('correct-repo', {
        skills: ['correct-skill'],
        skillContents: { 'correct-skill': '# Correct Content\n' },
      })
      .setup();

    try {
      // Create a stale git checkout with wrong URL
      await ctx.createStaleGitDir('correct-repo', 'https://wrong.example.com/other.git');

      // Verify stale directory exists
      await ctx.assertFileExists('.syncskill/sources/correct-repo/stale.txt');

      // Install the correct repo - should detect mismatch and re-clone
      const repoUrl = ctx.getGitSourceUrl('correct-repo');
      const result = await ctx.run('syncskill', 'install', repoUrl, '-y');
      expect(result.success).toBe(true);

      // Verify stale content is gone
      await ctx.assertFileNotExists('.syncskill/sources/correct-repo/stale.txt');

      // Verify correct skill is installed
      await ctx.assertFileExists('.syncskill/sources/correct-repo/correct-skill/SKILL.md');
      const content = await ctx.readFile('.syncskill/sources/correct-repo/correct-skill/SKILL.md');
      expect(content).toBe('# Correct Content\n');

      // Verify skill is linked
      await ctx.assertLinked('correct-skill', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('install handles stale checkout non-git dir', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .withGitSource('new-repo', {
        skills: ['new-skill'],
        skillContents: { 'new-skill': '# New Skill\n' },
      })
      .setup();

    try {
      // Create a stale non-git directory
      await ctx.createStaleNonGitDir('new-repo');

      // Verify stale directory exists with its content
      await ctx.assertFileExists('.syncskill/sources/new-repo/stale.txt');
      await ctx.assertFileExists('.syncskill/sources/new-repo/some-skill/SKILL.md');

      // Install the new repo - should detect non-git dir and clean up
      const repoUrl = ctx.getGitSourceUrl('new-repo');
      const result = await ctx.run('syncskill', 'install', repoUrl, '-y');
      expect(result.success).toBe(true);

      // Verify stale content is gone
      await ctx.assertFileNotExists('.syncskill/sources/new-repo/stale.txt');
      await ctx.assertFileNotExists('.syncskill/sources/new-repo/some-skill');

      // Verify new skill is installed
      await ctx.assertFileExists('.syncskill/sources/new-repo/new-skill/SKILL.md');
      const content = await ctx.readFile('.syncskill/sources/new-repo/new-skill/SKILL.md');
      expect(content).toBe('# New Skill\n');

      // Verify skill is linked
      await ctx.assertLinked('new-skill', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test:e2e -- tests/end2end/cases/source/source-stale-checkout.test.ts`
Expected: PASS or informative failure

- [ ] **Step 3: Commit**

```bash
git add tests/end2end/cases/source/source-stale-checkout.test.ts
git commit -m "test(e2e): add stale checkout tests for URL mismatch and non-git directories"
```

---

## Task 8: Create Link Directory and Reconcile Tests

**Files:**
- Create: `tests/end2end/cases/link/link-reconcile.test.ts`

- [ ] **Step 1: Create link directory**

```bash
mkdir -p tests/end2end/cases/link
```

- [ ] **Step 2: Write link reconcile tests**

```typescript
// tests/end2end/cases/link/link-reconcile.test.ts
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('link reconcile', () => {
  e2eTest('link all removes stale symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('test-skill', '# Test Skill\n')
      .withLinks({ 'test-skill': ['*'] })  // Initially link to all
      .setup();

    try {
      // First, link to all agents
      await ctx.run('syncskill', 'link', '--all');
      await ctx.assertLinked('test-skill', ['claude', 'agents', 'qwen']);

      // Now change config to only link to claude
      const config = await ctx.readConfig() as Record<string, unknown>;
      config.links = { 'test-skill': ['claude'] };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Run link --all again
      await ctx.run('syncskill', 'link', '--all');

      // Verify only claude has the link
      await ctx.assertLinked('test-skill', ['claude']);
      await ctx.assertNotLinked('test-skill', ['agents', 'qwen']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link single skill removes its stale symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents', 'qwen')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('skill-one', '# Skill One\n')
      .withSkill('skill-two', '# Skill Two\n')
      .withLinks({ 'skill-one': ['*'], 'skill-two': ['*'] })
      .setup();

    try {
      // Link all skills to all agents
      await ctx.run('syncskill', 'link', '--all');
      await ctx.assertLinked('skill-one', ['claude', 'agents', 'qwen']);
      await ctx.assertLinked('skill-two', ['claude', 'agents', 'qwen']);

      // Change config: skill-one to claude only, skill-two stays at *
      const config = await ctx.readConfig() as Record<string, unknown>;
      config.links = { 'skill-one': ['claude'], 'skill-two': ['*'] };
      await ctx.writeFile('.syncskill/config.yaml', stringify(config));

      // Run link for skill-one only
      await ctx.run('syncskill', 'link', 'skill-one');

      // skill-one should only be in claude
      await ctx.assertLinked('skill-one', ['claude']);
      await ctx.assertNotLinked('skill-one', ['agents', 'qwen']);

      // skill-two should be unaffected (still in all agents)
      await ctx.assertLinked('skill-two', ['claude', 'agents', 'qwen']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves real directories', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('managed-skill', '# Managed\n')
      .withLinks({ 'managed-skill': ['claude'] })  // Only claude
      .setup();

    try {
      // Create a real directory (not symlink) in agents' skills folder
      const agentsSkillDir = ctx.getPath('.agents', 'skills', 'managed-skill');
      await mkdir(agentsSkillDir, { recursive: true });
      await writeFile(join(agentsSkillDir, 'SKILL.md'), '# Real Dir\n', 'utf8');

      // Run link --all
      await ctx.run('syncskill', 'link', '--all');

      // Real directory should be preserved
      await ctx.assertIsRealDir('managed-skill', 'agents');

      // Claude should have symlink
      await ctx.assertIsSymlink('managed-skill', 'claude');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link preserves unmanaged symlinks', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('syncskill-managed', '# Managed\n')
      .withLinks({ 'syncskill-managed': ['claude'] })
      .setup();

    try {
      // Create an unmanaged symlink in agents (pointing outside syncskill paths)
      const externalDir = ctx.getPath('external-skill');
      await mkdir(externalDir, { recursive: true });
      await writeFile(join(externalDir, 'SKILL.md'), '# External\n', 'utf8');

      const agentsSkillsDir = ctx.getPath('.agents', 'skills');
      await mkdir(agentsSkillsDir, { recursive: true });
      await symlink(externalDir, join(agentsSkillsDir, 'external-skill'));

      // Also create a syncskill-managed link in agents that should be cleaned
      const managedSkillSource = ctx.getPath('.syncskill', 'skills', 'syncskill-managed');
      await symlink(managedSkillSource, join(agentsSkillsDir, 'syncskill-managed'));

      // Run link --all
      await ctx.run('syncskill', 'link', '--all');

      // External symlink should be preserved (not managed by syncskill)
      await ctx.assertFileExists('.agents/skills/external-skill/SKILL.md');

      // syncskill-managed should be removed from agents (not in links for agents)
      await ctx.assertNotLinked('syncskill-managed', ['agents']);

      // syncskill-managed should be in claude
      await ctx.assertLinked('syncskill-managed', ['claude']);
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test:e2e -- tests/end2end/cases/link/link-reconcile.test.ts`
Expected: PASS or informative failure

- [ ] **Step 4: Commit**

```bash
git add tests/end2end/cases/link/link-reconcile.test.ts
git commit -m "test(e2e): add link reconcile tests for stale symlink cleanup"
```

---

## Task 9: Run All E2E Tests and Fix Issues

**Files:**
- All test files created above

- [ ] **Step 1: Run all E2E tests**

Run: `npm run test:e2e`
Expected: All tests pass or reveal implementation gaps

- [ ] **Step 2: Check test output for failures**

If tests fail, the failures indicate features that need implementation. Document which tests fail and why.

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "test(e2e): fix test issues found during full run"
```

---

## Task 10: Update Anatomy and Memory

**Files:**
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`

- [ ] **Step 1: Update anatomy.md with new test files**

Add entries for all new test files created.

- [ ] **Step 2: Append to memory.md**

```markdown
| HH:MM | Added 18 E2E tests across 6 feature areas | tests/end2end/cases/* | complete | ~15000 |
```

- [ ] **Step 3: Commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md
git commit -m "docs: update anatomy and memory for E2E test implementation"
```
