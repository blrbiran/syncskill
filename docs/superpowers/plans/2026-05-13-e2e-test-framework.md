# E2E Test Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a comprehensive E2E test framework for syncskill that simulates user workflows while protecting real user directories.

**Architecture:** Builder pattern (E2EScenario) for declarative test setup + Runtime context (E2EContext) for command execution and assertions. Four-layer safety guard prevents touching real HOME. Mock servers via local tmp directories simulate remote sync.

**Tech Stack:** vitest, Node.js fs/child_process, temp directories

**Spec:** `docs/superpowers/specs/e2e-test-design.md`

---

## File Structure

```
tests/end2end/
├── framework/
│   ├── index.ts              # Public exports
│   ├── guard.ts              # Safety protection (L1-L4)
│   ├── cleanup.ts            # Temp directory cleanup
│   ├── scenario.ts           # E2EScenario builder
│   ├── context.ts            # E2EContext runtime
│   ├── runner.ts             # CLI command execution
│   ├── e2e-test.ts           # e2eTest wrapper function
│   ├── setup.ts              # vitest setup file
│   └── fixtures/
│       ├── index.ts          # Fixture exports
│       ├── skill.ts          # Skill file creation
│       ├── git.ts            # Git repo fixtures
│       ├── archive.ts        # Archive file creation
│       ├── server.ts         # Mock server simulation
│       └── github.ts         # TEST_REPO configuration
├── cases/
│   └── smoke/
│       └── init.test.ts      # Initial smoke test
└── smoke.test.ts             # Existing (keep)
```

---

## Task 1: Guard Module - Safety Protection

**Files:**
- Create: `tests/end2end/framework/guard.ts`
- Test: `tests/unit/e2e-guard.test.ts`

### Step 1: Write the failing test for guard

- [ ] Create test file

```typescript
// tests/unit/e2e-guard.test.ts
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E Guard', () => {
  it('throws E2EGuardError when path is real HOME', async () => {
    const { E2EGuardError, assertPathSafe } = await import(
      '../end2end/framework/guard.js'
    );
    const realHome = homedir();

    expect(() => assertPathSafe(realHome)).toThrow(E2EGuardError);
    expect(() => assertPathSafe(join(realHome, '.syncskill'))).toThrow(E2EGuardError);
    expect(() => assertPathSafe(join(realHome, '.claude', 'skills'))).toThrow(E2EGuardError);
  });

  it('allows paths in temp directory', async () => {
    const { assertPathSafe } = await import('../end2end/framework/guard.js');
    const tempPath = join(tmpdir(), 'syncskill-e2e-test123', '.syncskill');

    expect(() => assertPathSafe(tempPath)).not.toThrow();
  });

  it('isInAllowedTempDir returns true for temp paths', async () => {
    const { isInAllowedTempDir } = await import('../end2end/framework/guard.js');
    const allowedTemp = join(tmpdir(), 'syncskill-e2e-abc');

    expect(isInAllowedTempDir(join(allowedTemp, '.syncskill'), allowedTemp)).toBe(true);
    expect(isInAllowedTempDir('/home/user/.syncskill', allowedTemp)).toBe(false);
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-guard.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement guard module

- [ ] Create guard.ts

```typescript
// tests/end2end/framework/guard.ts
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Error thrown when E2E test attempts to access protected paths.
 */
export class E2EGuardError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly reason: string
  ) {
    super(
      `E2E Guard: Attempted to access protected path.\n` +
        `  Path: ${attemptedPath}\n` +
        `  Reason: ${reason}\n` +
        `  This is a bug in the E2E test framework or test case.`
    );
    this.name = 'E2EGuardError';
  }
}

const REAL_HOME = homedir();

/**
 * Paths that E2E tests must NEVER touch.
 */
const PROTECTED_PATHS = [
  REAL_HOME,
  `${REAL_HOME}/.syncskill`,
  `${REAL_HOME}/.claude`,
  `${REAL_HOME}/.agents`,
  `${REAL_HOME}/.cursor`,
  `${REAL_HOME}/.windsurf`,
  `${REAL_HOME}/.codex`,
  `${REAL_HOME}/.gemini`,
  `${REAL_HOME}/.kiro`,
  `${REAL_HOME}/.augment`,
  `${REAL_HOME}/.config/agents`,
  `${REAL_HOME}/.cline`,
  `${REAL_HOME}/.config/opencode`,
  `${REAL_HOME}/.qwen`,
  `${REAL_HOME}/.openclaw`,
  `${REAL_HOME}/.hermes`,
  `${REAL_HOME}/.qoder`,
  `${REAL_HOME}/.aone_copilot`,
];

/**
 * Check if a path is safe to access (not in protected paths).
 * Throws E2EGuardError if the path is protected.
 */
export function assertPathSafe(path: string): void {
  const resolved = resolve(path);

  for (const protected_ of PROTECTED_PATHS) {
    if (resolved === protected_ || resolved.startsWith(protected_ + '/')) {
      throw new E2EGuardError(resolved, `Path is within protected directory: ${protected_}`);
    }
  }
}

/**
 * Check if a path is within an allowed temp directory.
 */
export function isInAllowedTempDir(path: string, allowedTempDir: string): boolean {
  const resolved = resolve(path);
  const allowedResolved = resolve(allowedTempDir);
  return resolved === allowedResolved || resolved.startsWith(allowedResolved + '/');
}

/**
 * Get the list of protected paths (for diagnostics).
 */
export function getProtectedPaths(): readonly string[] {
  return PROTECTED_PATHS;
}
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-guard.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/guard.ts tests/unit/e2e-guard.test.ts
git commit -m "feat(e2e): add guard module for path safety protection"
```

---

## Task 2: Cleanup Module

**Files:**
- Create: `tests/end2end/framework/cleanup.ts`
- Test: `tests/unit/e2e-cleanup.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-cleanup.test.ts
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Cleanup', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('TEMP_PREFIX is syncskill-e2e-', async () => {
    const { TEMP_PREFIX } = await import('../end2end/framework/cleanup.js');
    expect(TEMP_PREFIX).toBe('syncskill-e2e-');
  });

  it('cleanupStaleTempDirs removes old temp directories', async () => {
    const { TEMP_PREFIX, cleanupStaleTempDirs } = await import(
      '../end2end/framework/cleanup.js'
    );

    // Create a stale temp dir
    const staleDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    createdDirs.push(staleDir);
    await mkdir(join(staleDir, '.syncskill'), { recursive: true });

    // Run cleanup
    await cleanupStaleTempDirs();

    // Verify it's gone
    await expect(stat(staleDir)).rejects.toThrow();
  });

  it('createManagedTempDir creates temp directory with prefix', async () => {
    const { TEMP_PREFIX, createManagedTempDir } = await import(
      '../end2end/framework/cleanup.js'
    );

    const tempDir = await createManagedTempDir();
    createdDirs.push(tempDir);

    expect(tempDir).toContain(TEMP_PREFIX);
    const stats = await stat(tempDir);
    expect(stats.isDirectory()).toBe(true);
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-cleanup.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement cleanup module

- [ ] Create cleanup.ts

```typescript
// tests/end2end/framework/cleanup.ts
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix for all E2E temp directories.
 */
export const TEMP_PREFIX = 'syncskill-e2e-';

/**
 * Clean up stale temp directories from previous crashed runs.
 * Called in globalSetup before tests start.
 */
export async function cleanupStaleTempDirs(): Promise<void> {
  const tmp = tmpdir();
  let entries: string[];

  try {
    entries = await readdir(tmp);
  } catch {
    return;
  }

  const staleThreshold = Date.now() - 60 * 60 * 1000; // 1 hour old

  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;

    const fullPath = join(tmp, entry);
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory() && stats.mtimeMs < staleThreshold) {
        await rm(fullPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore errors for individual directories
    }
  }
}

/**
 * Create a new managed temp directory for E2E tests.
 */
export async function createManagedTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), TEMP_PREFIX));
}

/**
 * Remove a temp directory.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-cleanup.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/cleanup.ts tests/unit/e2e-cleanup.test.ts
git commit -m "feat(e2e): add cleanup module for temp directory management"
```

---

## Task 3: Runner Module - CLI Execution

**Files:**
- Create: `tests/end2end/framework/runner.ts`
- Test: `tests/unit/e2e-runner.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-runner.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

describe('E2E Runner', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('execCommand runs a command and returns result', async () => {
    const { execCommand } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await execCommand('echo', ['hello'], { cwd: tempDir });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('execCommand returns failure for non-zero exit', async () => {
    const { execCommand } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await execCommand('node', ['-e', 'process.exit(1)'], {
      cwd: tempDir,
      expectedExitCode: null,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('runSyncskill runs syncskill CLI with HOME override', async () => {
    const { runSyncskill } = await import('../end2end/framework/runner.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-runner-'));
    tempDirs.push(tempDir);

    const result = await runSyncskill(tempDir, rootDir, ['--help']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('Usage: syncskill');
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-runner.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement runner module

- [ ] Create runner.ts

```typescript
// tests/end2end/framework/runner.ts
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Result of running a command.
 */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Options for running a command.
 */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  expectedExitCode?: number | null;
  stdin?: string;
}

/**
 * Check if verbose mode is enabled.
 */
export function isVerbose(): boolean {
  return (
    process.env.E2E_VERBOSE === '1' ||
    process.env.E2E_VERBOSE === 'true'
  );
}

/**
 * Execute a command and return the result.
 */
export async function execCommand(
  cmd: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const {
    cwd = process.cwd(),
    env = {},
    timeout = 30000,
    expectedExitCode = 0,
  } = options;

  const verbose = isVerbose();

  if (verbose) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`▶ ${cmd} ${args.join(' ')}`);
    console.log(`  cwd: ${cwd}`);
    console.log(`${'─'.repeat(60)}`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
    exitCode = execError.code ?? 1;
  }

  if (verbose) {
    if (stdout) console.log(`📤 stdout:\n${indent(stdout)}`);
    if (stderr) console.log(`📥 stderr:\n${indent(stderr)}`);
    console.log(`⏹ exit: ${exitCode}`);
  }

  const success = exitCode === 0;

  if (expectedExitCode !== null && exitCode !== expectedExitCode) {
    throw new Error(
      `Command failed with exit code ${exitCode}, expected ${expectedExitCode}\n` +
        `Command: ${cmd} ${args.join(' ')}\n` +
        `stdout: ${stdout}\n` +
        `stderr: ${stderr}`
    );
  }

  return { stdout, stderr, exitCode, success };
}

/**
 * Run syncskill CLI with HOME environment override.
 */
export async function runSyncskill(
  homeDir: string,
  projectRoot: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {}
): Promise<RunResult> {
  const distPath = join(projectRoot, 'dist', 'index.js');

  return execCommand('node', [distPath, ...args], {
    ...options,
    cwd: homeDir,
    env: {
      ...options.env,
      HOME: homeDir,
      USERPROFILE: homeDir, // Windows
    },
  });
}

/**
 * Get the project root directory.
 */
export function getProjectRoot(): string {
  return join(__dirname, '..', '..', '..');
}

function indent(text: string, spaces = 4): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
```

- [ ] Run test to verify it passes

```bash
npm run build && npm run test:unit -- tests/unit/e2e-runner.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/runner.ts tests/unit/e2e-runner.test.ts
git commit -m "feat(e2e): add runner module for CLI command execution"
```

---

## Task 4: Skill Fixture

**Files:**
- Create: `tests/end2end/framework/fixtures/skill.ts`
- Create: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-skill.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-fixtures-skill.test.ts
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Skill Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createSkillDir creates a skill directory with SKILL.md', async () => {
    const { createSkillDir } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    const skillPath = await createSkillDir(tempDir, 'my-skill');

    const stats = await stat(skillPath);
    expect(stats.isDirectory()).toBe(true);

    const content = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
    expect(content).toContain('# my-skill');
  });

  it('createSkillDir accepts custom content', async () => {
    const { createSkillDir } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    const customContent = '# Custom Skill\n\nThis is custom.';
    const skillPath = await createSkillDir(tempDir, 'custom', customContent);

    const content = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
    expect(content).toBe(customContent);
  });

  it('createMultipleSkills creates multiple skill directories', async () => {
    const { createMultipleSkills } = await import(
      '../end2end/framework/fixtures/skill.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-skill-'));
    tempDirs.push(tempDir);

    await createMultipleSkills(tempDir, ['skill-a', 'skill-b', 'skill-c']);

    for (const name of ['skill-a', 'skill-b', 'skill-c']) {
      const stats = await stat(join(tempDir, name));
      expect(stats.isDirectory()).toBe(true);
    }
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-fixtures-skill.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement skill fixture

- [ ] Create fixtures directory and skill.ts

```typescript
// tests/end2end/framework/fixtures/skill.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Default SKILL.md content template.
 */
function defaultSkillContent(name: string): string {
  return `# ${name}\n\nA test skill for E2E testing.\n`;
}

/**
 * Create a skill directory with SKILL.md.
 */
export async function createSkillDir(
  parentDir: string,
  name: string,
  content?: string
): Promise<string> {
  const skillPath = join(parentDir, name);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, 'SKILL.md'),
    content ?? defaultSkillContent(name),
    'utf8'
  );
  return skillPath;
}

/**
 * Create multiple skill directories.
 */
export async function createMultipleSkills(
  parentDir: string,
  names: string[],
  contents?: Record<string, string>
): Promise<string[]> {
  const paths: string[] = [];
  for (const name of names) {
    const path = await createSkillDir(parentDir, name, contents?.[name]);
    paths.push(path);
  }
  return paths;
}
```

- [ ] Create fixtures/index.ts

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-fixtures-skill.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/fixtures/
git add tests/unit/e2e-fixtures-skill.test.ts
git commit -m "feat(e2e): add skill fixture for creating test skills"
```

---

## Task 5: Git Fixture

**Files:**
- Create: `tests/end2end/framework/fixtures/git.ts`
- Modify: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-git.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-fixtures-git.test.ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('E2E Git Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createGitBareRepo creates a bare git repository', async () => {
    const { createGitBareRepo } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const bareRepoPath = await createGitBareRepo(tempDir, 'test-repo');

    const stats = await stat(bareRepoPath);
    expect(stats.isDirectory()).toBe(true);
    expect(bareRepoPath).toContain('test-repo.git');
  });

  it('createGitSourceFixture creates bare repo with skills', async () => {
    const { createGitSourceFixture } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const { bareRepoUrl, workDir } = await createGitSourceFixture(tempDir, 'my-repo', {
      skills: ['skill-a', 'skill-b'],
      branch: 'main',
    });

    expect(bareRepoUrl).toContain('my-repo.git');

    // Clone and verify skills exist
    const cloneDir = join(tempDir, 'clone');
    await execFileAsync('git', ['clone', bareRepoUrl, cloneDir]);

    const skillA = await stat(join(cloneDir, 'skill-a', 'SKILL.md'));
    expect(skillA.isFile()).toBe(true);

    const skillB = await stat(join(cloneDir, 'skill-b', 'SKILL.md'));
    expect(skillB.isFile()).toBe(true);
  });

  it('addSkillToGitRepo adds a new skill and pushes', async () => {
    const { createGitSourceFixture, addSkillToGitRepo } = await import(
      '../end2end/framework/fixtures/git.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-git-'));
    tempDirs.push(tempDir);

    const { bareRepoUrl, workDir } = await createGitSourceFixture(tempDir, 'repo', {
      skills: ['existing'],
    });

    await addSkillToGitRepo(workDir, 'new-skill', '# New Skill\n');

    // Clone and verify new skill exists
    const cloneDir = join(tempDir, 'verify');
    await execFileAsync('git', ['clone', bareRepoUrl, cloneDir]);

    const content = await readFile(join(cloneDir, 'new-skill', 'SKILL.md'), 'utf8');
    expect(content).toBe('# New Skill\n');
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-fixtures-git.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement git fixture

- [ ] Create git.ts

```typescript
// tests/end2end/framework/fixtures/git.ts
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createSkillDir, createMultipleSkills } from './skill.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    cwd === undefined ? args : ['-C', cwd, ...args]
  );
  return stdout;
}

async function gitCommit(repoDir: string, message: string): Promise<void> {
  await git(['add', '.'], repoDir);
  await git(
    [
      '-c', 'user.name=E2E Test',
      '-c', 'user.email=e2e@test.local',
      'commit', '-m', message,
    ],
    repoDir
  );
}

/**
 * Create a bare git repository.
 */
export async function createGitBareRepo(
  parentDir: string,
  name: string
): Promise<string> {
  const bareRepoPath = join(parentDir, `${name}.git`);
  await git(['init', '--bare', bareRepoPath]);
  return bareRepoPath;
}

export interface GitSourceConfig {
  skills: string[];
  branch?: string;
  skillContents?: Record<string, string>;
}

export interface GitSourceFixture {
  bareRepoUrl: string;
  workDir: string;
}

/**
 * Create a git source fixture with skills.
 */
export async function createGitSourceFixture(
  parentDir: string,
  name: string,
  config: GitSourceConfig
): Promise<GitSourceFixture> {
  const branch = config.branch ?? 'main';
  const bareRepoPath = await createGitBareRepo(parentDir, name);
  const workDir = join(parentDir, `${name}-work`);

  // Clone, add skills, push
  await git(['clone', bareRepoPath, workDir]);
  await git(['checkout', '-b', branch], workDir);

  // Create skills
  for (const skillName of config.skills) {
    await createSkillDir(workDir, skillName, config.skillContents?.[skillName]);
  }

  // Commit and push
  await gitCommit(workDir, 'Initial commit with skills');
  await git(['push', '-u', 'origin', branch], workDir);

  return {
    bareRepoUrl: bareRepoPath,
    workDir,
  };
}

/**
 * Add a new skill to an existing git repo and push.
 */
export async function addSkillToGitRepo(
  workDir: string,
  skillName: string,
  content?: string
): Promise<void> {
  await createSkillDir(workDir, skillName, content);
  await gitCommit(workDir, `Add skill: ${skillName}`);
  await git(['push'], workDir);
}

/**
 * Modify a skill in an existing git repo and push.
 */
export async function modifySkillInGitRepo(
  workDir: string,
  skillName: string,
  newContent: string
): Promise<void> {
  await writeFile(join(workDir, skillName, 'SKILL.md'), newContent, 'utf8');
  await gitCommit(workDir, `Modify skill: ${skillName}`);
  await git(['push'], workDir);
}

/**
 * Remove a skill from an existing git repo and push.
 */
export async function removeSkillFromGitRepo(
  workDir: string,
  skillName: string
): Promise<void> {
  await rm(join(workDir, skillName), { recursive: true, force: true });
  await gitCommit(workDir, `Remove skill: ${skillName}`);
  await git(['push'], workDir);
}
```

- [ ] Update fixtures/index.ts

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
export * from './git.js';
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-fixtures-git.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/fixtures/git.ts tests/end2end/framework/fixtures/index.ts
git add tests/unit/e2e-fixtures-git.test.ts
git commit -m "feat(e2e): add git fixture for creating test repositories"
```

---

## Task 6: Archive Fixture

**Files:**
- Create: `tests/end2end/framework/fixtures/archive.ts`
- Modify: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-archive.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-fixtures-archive.test.ts
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as compressing from 'compressing';

describe('E2E Archive Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createArchive creates a zip with skills', async () => {
    const { createArchive } = await import(
      '../end2end/framework/fixtures/archive.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-archive-'));
    tempDirs.push(tempDir);

    const archivePath = await createArchive(tempDir, 'skills.zip', {
      skills: ['skill-a', 'skill-b'],
      format: 'zip',
    });

    expect(archivePath).toContain('skills.zip');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Extract and verify
    const extractDir = join(tempDir, 'extracted');
    await compressing.zip.uncompress(archivePath, extractDir);

    const skillA = await stat(join(extractDir, 'skill-a', 'SKILL.md'));
    expect(skillA.isFile()).toBe(true);
  });

  it('createArchive creates a tar.gz with skills', async () => {
    const { createArchive } = await import(
      '../end2end/framework/fixtures/archive.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-archive-'));
    tempDirs.push(tempDir);

    const archivePath = await createArchive(tempDir, 'skills.tar.gz', {
      skills: ['my-skill'],
      format: 'tar.gz',
    });

    expect(archivePath).toContain('skills.tar.gz');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);

    // Extract and verify
    const extractDir = join(tempDir, 'extracted');
    await compressing.tgz.uncompress(archivePath, extractDir);

    const skill = await stat(join(extractDir, 'my-skill', 'SKILL.md'));
    expect(skill.isFile()).toBe(true);
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-fixtures-archive.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement archive fixture

- [ ] Create archive.ts

```typescript
// tests/end2end/framework/fixtures/archive.ts
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as compressing from 'compressing';

import { createMultipleSkills } from './skill.js';

export interface ArchiveConfig {
  skills: string[];
  format?: 'zip' | 'tar.gz';
  skillContents?: Record<string, string>;
}

/**
 * Create an archive file containing skills.
 */
export async function createArchive(
  parentDir: string,
  name: string,
  config: ArchiveConfig
): Promise<string> {
  const format = config.format ?? 'zip';
  const archivePath = join(parentDir, name);

  // Create temp directory for skills
  const contentDir = join(parentDir, `${name}-content`);
  await mkdir(contentDir, { recursive: true });

  // Create skills
  await createMultipleSkills(contentDir, config.skills, config.skillContents);

  // Create archive
  if (format === 'zip') {
    await compressing.zip.compressDir(contentDir, archivePath);
  } else {
    await compressing.tgz.compressDir(contentDir, archivePath);
  }

  // Cleanup temp content dir
  await rm(contentDir, { recursive: true, force: true });

  return archivePath;
}
```

- [ ] Update fixtures/index.ts

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
export * from './git.js';
export * from './archive.js';
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-fixtures-archive.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/fixtures/archive.ts tests/end2end/framework/fixtures/index.ts
git add tests/unit/e2e-fixtures-archive.test.ts
git commit -m "feat(e2e): add archive fixture for creating test archives"
```

---

## Task 7: Mock Server Fixture

**Files:**
- Create: `tests/end2end/framework/fixtures/server.ts`
- Modify: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-server.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-fixtures-server.test.ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('E2E Mock Server Fixture', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createMockServer creates a server directory structure', async () => {
    const { createMockServer } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'dev-server',
      skills: ['skill-a'],
    });

    expect(server.name).toBe('dev-server');
    expect(server.path).toContain('dev-server');

    const syncskillDir = await stat(server.syncskillDir);
    expect(syncskillDir.isDirectory()).toBe(true);

    const skillsDir = await stat(server.skillsDir);
    expect(skillsDir.isDirectory()).toBe(true);
  });

  it('modifyServerSkill updates skill content', async () => {
    const { createMockServer, modifyServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'dev',
      skills: ['my-skill'],
    });

    await modifyServerSkill(server, 'my-skill', '# Modified\n');

    const content = await readFile(
      join(server.skillsDir, 'my-skill', 'SKILL.md'),
      'utf8'
    );
    expect(content).toBe('# Modified\n');
  });

  it('addServerSkill adds a new skill', async () => {
    const { createMockServer, addServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, { name: 'prod' });

    await addServerSkill(server, 'new-skill', '# New\n');

    const stats = await stat(join(server.skillsDir, 'new-skill', 'SKILL.md'));
    expect(stats.isFile()).toBe(true);
  });

  it('removeServerSkill removes a skill', async () => {
    const { createMockServer, removeServerSkill } = await import(
      '../end2end/framework/fixtures/server.js'
    );
    const tempDir = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    tempDirs.push(tempDir);

    const server = await createMockServer(tempDir, {
      name: 'staging',
      skills: ['to-remove'],
    });

    await removeServerSkill(server, 'to-remove');

    await expect(stat(join(server.skillsDir, 'to-remove'))).rejects.toThrow();
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-fixtures-server.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement server fixture

- [ ] Create server.ts

```typescript
// tests/end2end/framework/fixtures/server.ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSkillDir, createMultipleSkills } from './skill.js';

export interface MockServerConfig {
  name: string;
  skills?: string[];
  agents?: Record<string, string>;
}

export interface MockServer {
  name: string;
  path: string;
  syncskillDir: string;
  skillsDir: string;
  agents: Record<string, string>;
}

/**
 * Create a mock server directory structure.
 */
export async function createMockServer(
  parentDir: string,
  config: MockServerConfig
): Promise<MockServer> {
  const serverPath = join(parentDir, `server-${config.name}`);
  const syncskillDir = join(serverPath, '.syncskill');
  const skillsDir = join(syncskillDir, 'skills');

  await mkdir(skillsDir, { recursive: true });

  // Create pre-installed skills
  if (config.skills && config.skills.length > 0) {
    await createMultipleSkills(skillsDir, config.skills);
  }

  return {
    name: config.name,
    path: serverPath,
    syncskillDir,
    skillsDir,
    agents: config.agents ?? {},
  };
}

/**
 * Modify a skill on a mock server.
 */
export async function modifyServerSkill(
  server: MockServer,
  skillName: string,
  content: string
): Promise<void> {
  const skillPath = join(server.skillsDir, skillName, 'SKILL.md');
  await writeFile(skillPath, content, 'utf8');
}

/**
 * Add a new skill to a mock server.
 */
export async function addServerSkill(
  server: MockServer,
  skillName: string,
  content?: string
): Promise<void> {
  await createSkillDir(server.skillsDir, skillName, content);
}

/**
 * Remove a skill from a mock server.
 */
export async function removeServerSkill(
  server: MockServer,
  skillName: string
): Promise<void> {
  await rm(join(server.skillsDir, skillName), { recursive: true, force: true });
}

/**
 * Read a skill from a mock server.
 */
export async function readServerSkill(
  server: MockServer,
  skillName: string
): Promise<string> {
  return readFile(join(server.skillsDir, skillName, 'SKILL.md'), 'utf8');
}
```

- [ ] Update fixtures/index.ts

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
export * from './git.js';
export * from './archive.js';
export * from './server.js';
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-fixtures-server.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/fixtures/server.ts tests/end2end/framework/fixtures/index.ts
git add tests/unit/e2e-fixtures-server.test.ts
git commit -m "feat(e2e): add mock server fixture for simulating remote servers"
```

---

## Task 8: GitHub Test Repo Configuration

**Files:**
- Create: `tests/end2end/framework/fixtures/github.ts`
- Modify: `tests/end2end/framework/fixtures/index.ts`
- Test: `tests/unit/e2e-fixtures-github.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-fixtures-github.test.ts
import { describe, expect, it } from 'vitest';

describe('E2E GitHub Config', () => {
  it('TEST_REPO has default URLs', async () => {
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.baseUrl).toBe('https://github.com/blrbiran/syncskill_test');
    expect(TEST_REPO.sshUrl).toBe('git@github.com:blrbiran/syncskill_test.git');
  });

  it('TEST_REPO URLs can be overridden via env', async () => {
    process.env.E2E_TEST_REPO_URL = 'https://custom.example.com/repo';
    process.env.E2E_TEST_REPO_SSH = 'git@custom.example.com:repo.git';

    // Re-import to get fresh values
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.baseUrl).toBe('https://custom.example.com/repo');
    expect(TEST_REPO.sshUrl).toBe('git@custom.example.com:repo.git');

    // Cleanup
    delete process.env.E2E_TEST_REPO_URL;
    delete process.env.E2E_TEST_REPO_SSH;
  });

  it('TEST_REPO.urls derives from baseUrl', async () => {
    delete process.env.E2E_TEST_REPO_URL;

    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.urls.root).toBe(TEST_REPO.baseUrl);
    expect(TEST_REPO.urls.skills).toContain('/tree/main/skills');
    expect(TEST_REPO.urls.singleSkill).toContain('/tree/main/skills/skill-alpha');
  });

  it('TEST_REPO.expectedSkills has predefined values', async () => {
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.expectedSkills.root).toContain('syncskill_test');
    expect(TEST_REPO.expectedSkills.skills).toEqual(['skill-alpha', 'skill-beta']);
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-fixtures-github.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement github fixture

- [ ] Create github.ts

```typescript
// tests/end2end/framework/fixtures/github.ts

const DEFAULT_BASE_URL = 'https://github.com/blrbiran/syncskill_test';
const DEFAULT_SSH_URL = 'git@github.com:blrbiran/syncskill_test.git';

/**
 * Official test repository configuration.
 * URLs can be overridden via environment variables.
 */
export const TEST_REPO = {
  get baseUrl(): string {
    return process.env.E2E_TEST_REPO_URL ?? DEFAULT_BASE_URL;
  },

  get sshUrl(): string {
    return process.env.E2E_TEST_REPO_SSH ?? DEFAULT_SSH_URL;
  },

  localPath: 'tests/end2end/fixtures/syncskill_test',

  urls: {
    get root() {
      return TEST_REPO.baseUrl;
    },
    get skills() {
      return `${TEST_REPO.baseUrl}/tree/main/skills`;
    },
    get singleSkill() {
      return `${TEST_REPO.baseUrl}/tree/main/skills/skill-alpha`;
    },
    get examples() {
      return `${TEST_REPO.baseUrl}/tree/main/examples`;
    },
    get singleExample() {
      return `${TEST_REPO.baseUrl}/tree/main/examples/example-one`;
    },
  },

  expectedSkills: {
    root: ['syncskill_test', 'skill-alpha', 'skill-beta', 'example-one', 'example-two'],
    skills: ['skill-alpha', 'skill-beta'],
    singleSkill: ['skill-alpha'],
    examples: ['example-one', 'example-two'],
    singleExample: ['example-one'],
  },
};
```

- [ ] Update fixtures/index.ts

```typescript
// tests/end2end/framework/fixtures/index.ts
export * from './skill.js';
export * from './git.js';
export * from './archive.js';
export * from './server.js';
export * from './github.js';
```

- [ ] Run test to verify it passes

```bash
npm run test:unit -- tests/unit/e2e-fixtures-github.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/fixtures/github.ts tests/end2end/framework/fixtures/index.ts
git add tests/unit/e2e-fixtures-github.test.ts
git commit -m "feat(e2e): add GitHub test repo configuration"
```

---

## Task 9: E2EContext Implementation

**Files:**
- Create: `tests/end2end/framework/context.ts`
- Test: `tests/unit/e2e-context.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-context.test.ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

describe('E2EContext', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates context with correct paths', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    expect(ctx.homeDir).toBe(tempDir);
    expect(ctx.syncskillDir).toBe(join(tempDir, '.syncskill'));
  });

  it('getPath returns absolute path', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    expect(ctx.getPath('.syncskill', 'skills')).toBe(
      join(tempDir, '.syncskill', 'skills')
    );
  });

  it('readFile and writeFile work correctly', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await mkdir(join(tempDir, 'test'), { recursive: true });
    await ctx.writeFile('test/file.txt', 'hello');

    const content = await ctx.readFile('test/file.txt');
    expect(content).toBe('hello');
  });

  it('assertFileExists passes for existing file', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await mkdir(join(tempDir, '.syncskill'), { recursive: true });
    await writeFile(join(tempDir, '.syncskill', 'config.yaml'), 'version: 1');

    await expect(ctx.assertFileExists('.syncskill/config.yaml')).resolves.not.toThrow();
  });

  it('assertFileExists fails for missing file', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    await expect(ctx.assertFileExists('missing.txt')).rejects.toThrow();
  });

  it('assertLinked checks symlink correctly', async () => {
    const { E2EContext } = await import('../end2end/framework/context.js');
    const tempDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(tempDir);

    const ctx = new E2EContext(tempDir, rootDir);

    // Setup: create skill and agent dir with symlink
    const skillDir = join(tempDir, '.syncskill', 'skills', 'my-skill');
    const agentDir = join(tempDir, '.claude', 'skills');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# my-skill');
    await mkdir(agentDir, { recursive: true });
    await symlink(skillDir, join(agentDir, 'my-skill'));

    await expect(ctx.assertLinked('my-skill', ['claude'])).resolves.not.toThrow();
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-context.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement context module

- [ ] Create context.ts

```typescript
// tests/end2end/framework/context.ts
import { lstat, mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

import { E2EGuardError, assertPathSafe } from './guard.js';
import { runSyncskill, execCommand, type RunResult, type RunOptions } from './runner.js';
import { removeTempDir } from './cleanup.js';
import type { MockServer } from './fixtures/server.js';
import type { GitSourceFixture } from './fixtures/git.js';

interface CommandHistoryEntry {
  cmd: string;
  args: string[];
  result: RunResult;
  timestamp: number;
}

/**
 * E2E test runtime context.
 */
export class E2EContext {
  readonly homeDir: string;
  readonly syncskillDir: string;
  private readonly projectRoot: string;
  private commandHistory: CommandHistoryEntry[] = [];
  private gitSources: Map<string, GitSourceFixture> = new Map();
  private mockServers: Map<string, MockServer> = new Map();
  private archives: Map<string, string> = new Map();

  constructor(homeDir: string, projectRoot: string) {
    this.homeDir = homeDir;
    this.syncskillDir = join(homeDir, '.syncskill');
    this.projectRoot = projectRoot;
  }

  // ─────────────────────────────────────────────────────────
  // Path Access
  // ─────────────────────────────────────────────────────────

  getPath(...segments: string[]): string {
    return join(this.homeDir, ...segments);
  }

  getGitSourceUrl(name: string): string {
    const source = this.gitSources.get(name);
    if (!source) throw new Error(`Git source "${name}" not found`);
    return source.bareRepoUrl;
  }

  getGitSourceWorkDir(name: string): string {
    const source = this.gitSources.get(name);
    if (!source) throw new Error(`Git source "${name}" not found`);
    return source.workDir;
  }

  getArchivePath(name: string): string {
    const path = this.archives.get(name);
    if (!path) throw new Error(`Archive "${name}" not found`);
    return path;
  }

  getMockServerPath(name: string): string {
    const server = this.mockServers.get(name);
    if (!server) throw new Error(`Mock server "${name}" not found`);
    return server.path;
  }

  // ─────────────────────────────────────────────────────────
  // Internal Registration
  // ─────────────────────────────────────────────────────────

  registerGitSource(name: string, fixture: GitSourceFixture): void {
    this.gitSources.set(name, fixture);
  }

  registerMockServer(name: string, server: MockServer): void {
    this.mockServers.set(name, server);
  }

  registerArchive(name: string, path: string): void {
    this.archives.set(name, path);
  }

  // ─────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────

  async run(cmd: 'syncskill', ...args: string[]): Promise<RunResult>;
  async run(cmd: 'syncskill', args: string[], options?: RunOptions): Promise<RunResult>;
  async run(
    cmd: 'syncskill',
    argsOrFirst: string | string[],
    optionsOrSecond?: RunOptions | string,
    ...restArgs: string[]
  ): Promise<RunResult> {
    let args: string[];
    let options: RunOptions = {};

    if (Array.isArray(argsOrFirst)) {
      args = argsOrFirst;
      options = (optionsOrSecond as RunOptions) ?? {};
    } else {
      args = [argsOrFirst];
      if (typeof optionsOrSecond === 'string') {
        args.push(optionsOrSecond, ...restArgs);
      } else if (optionsOrSecond) {
        options = optionsOrSecond;
      }
      args.push(...restArgs.filter((a) => typeof a === 'string'));
    }

    const result = await runSyncskill(this.homeDir, this.projectRoot, args, options);

    this.commandHistory.push({
      cmd: 'syncskill',
      args,
      result,
      timestamp: Date.now(),
    });

    return result;
  }

  async exec(cmd: string, args: string[], options?: RunOptions): Promise<RunResult> {
    return execCommand(cmd, args, {
      ...options,
      cwd: options?.cwd ? this.getPath(options.cwd) : this.homeDir,
      env: { ...options?.env, HOME: this.homeDir },
    });
  }

  async runExpectFail(cmd: 'syncskill', ...args: string[]): Promise<RunResult> {
    return this.run(cmd, args, { expectedExitCode: null });
  }

  // ─────────────────────────────────────────────────────────
  // File Operations
  // ─────────────────────────────────────────────────────────

  async readFile(relativePath: string): Promise<string> {
    const absPath = this.getPath(relativePath);
    assertPathSafe(absPath);
    return readFile(absPath, 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const absPath = this.getPath(relativePath);
    assertPathSafe(absPath);
    await writeFile(absPath, content, 'utf8');
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.getPath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async readlink(relativePath: string): Promise<string> {
    return readlink(this.getPath(relativePath));
  }

  async readdir(relativePath: string): Promise<string[]> {
    return readdir(this.getPath(relativePath));
  }

  async readConfig(): Promise<unknown> {
    const content = await this.readFile('.syncskill/config.yaml');
    return parse(content);
  }

  async readRegistry(): Promise<unknown> {
    const content = await this.readFile('.syncskill/skills-registry.json');
    return JSON.parse(content);
  }

  // ─────────────────────────────────────────────────────────
  // Assertions
  // ─────────────────────────────────────────────────────────

  async assertFileExists(relativePath: string): Promise<void> {
    const exists = await this.exists(relativePath);
    if (!exists) {
      throw new Error(`Expected file to exist: ${relativePath}`);
    }
  }

  async assertFileNotExists(relativePath: string): Promise<void> {
    const exists = await this.exists(relativePath);
    if (exists) {
      throw new Error(`Expected file to not exist: ${relativePath}`);
    }
  }

  async assertFileContains(relativePath: string, substring: string): Promise<void> {
    const content = await this.readFile(relativePath);
    if (!content.includes(substring)) {
      throw new Error(
        `Expected file "${relativePath}" to contain "${substring}", got: ${content.slice(0, 200)}`
      );
    }
  }

  async assertLinked(skill: string, agents: string[]): Promise<void> {
    for (const agent of agents) {
      const agentPath = this.getAgentSkillsPath(agent);
      const linkPath = join(agentPath, skill);

      try {
        const lstats = await lstat(linkPath);
        if (!lstats.isSymbolicLink()) {
          throw new Error(`Expected "${linkPath}" to be a symlink, but it's not`);
        }
      } catch (error) {
        throw new Error(`Expected skill "${skill}" to be linked to agent "${agent}"`);
      }
    }
  }

  async assertNotLinked(skill: string, agents: string[]): Promise<void> {
    for (const agent of agents) {
      const agentPath = this.getAgentSkillsPath(agent);
      const linkPath = join(agentPath, skill);

      try {
        await lstat(linkPath);
        throw new Error(`Expected skill "${skill}" to NOT be linked to agent "${agent}"`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async assertIsSymlink(skill: string, agent: string): Promise<void> {
    const linkPath = join(this.getAgentSkillsPath(agent), skill);
    const lstats = await lstat(linkPath);
    if (!lstats.isSymbolicLink()) {
      throw new Error(`Expected "${linkPath}" to be a symlink`);
    }
  }

  async assertIsRealDir(skill: string, agent: string): Promise<void> {
    const dirPath = join(this.getAgentSkillsPath(agent), skill);
    const lstats = await lstat(dirPath);
    if (lstats.isSymbolicLink() || !lstats.isDirectory()) {
      throw new Error(`Expected "${dirPath}" to be a real directory (not symlink)`);
    }
  }

  async assertSourceExists(name: string): Promise<void> {
    const config = (await this.readConfig()) as { sources?: Record<string, unknown> };
    if (!config.sources?.[name]) {
      throw new Error(`Expected source "${name}" to exist in config`);
    }
  }

  async assertLinksConfig(skill: string, expectedAgents: string[]): Promise<void> {
    const config = (await this.readConfig()) as { links?: Record<string, string[]> };
    const actual = config.links?.[skill];
    if (!actual) {
      throw new Error(`Expected skill "${skill}" to be in links config`);
    }
    const actualSet = new Set(actual);
    const expectedSet = new Set(expectedAgents);
    if (actualSet.size !== expectedSet.size || ![...actualSet].every((a) => expectedSet.has(a))) {
      throw new Error(
        `Expected links for "${skill}" to be [${expectedAgents.join(', ')}], got [${actual.join(', ')}]`
      );
    }
  }

  assertOutputContains(result: RunResult, substring: string): void {
    const combined = result.stdout + result.stderr;
    if (!combined.includes(substring)) {
      throw new Error(
        `Expected output to contain "${substring}"\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
  }

  assertOutputMatches(result: RunResult, pattern: RegExp): void {
    const combined = result.stdout + result.stderr;
    if (!pattern.test(combined)) {
      throw new Error(
        `Expected output to match ${pattern}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  // Mock Server Assertions
  // ─────────────────────────────────────────────────────────

  async assertServerHasSkill(serverName: string, skillName: string): Promise<void> {
    const server = this.mockServers.get(serverName);
    if (!server) throw new Error(`Mock server "${serverName}" not found`);

    const skillPath = join(server.skillsDir, skillName, 'SKILL.md');
    try {
      await stat(skillPath);
    } catch {
      throw new Error(`Expected server "${serverName}" to have skill "${skillName}"`);
    }
  }

  async assertServerSkillContent(
    serverName: string,
    skillName: string,
    expectedContent: string
  ): Promise<void> {
    const server = this.mockServers.get(serverName);
    if (!server) throw new Error(`Mock server "${serverName}" not found`);

    const content = await readFile(join(server.skillsDir, skillName, 'SKILL.md'), 'utf8');
    if (content !== expectedContent) {
      throw new Error(
        `Expected server "${serverName}" skill "${skillName}" content to be "${expectedContent}", got "${content}"`
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    await removeTempDir(this.homeDir);
  }

  dumpDiagnostics(): void {
    console.log('\n' + '═'.repeat(60));
    console.log('📋 E2E TEST DIAGNOSTICS');
    console.log('═'.repeat(60));

    console.log(`\n📁 Home directory: ${this.homeDir}`);
    console.log(`📁 Syncskill dir: ${this.syncskillDir}`);

    if (this.commandHistory.length > 0) {
      console.log('\n📜 Command history:');
      for (const entry of this.commandHistory) {
        console.log(`  [${new Date(entry.timestamp).toISOString()}]`);
        console.log(`    $ ${entry.cmd} ${entry.args.join(' ')}`);
        console.log(`    exit: ${entry.result.exitCode}`);
        if (entry.result.stderr) {
          console.log(`    stderr: ${entry.result.stderr.slice(0, 200)}...`);
        }
      }
    }

    console.log('\n' + '═'.repeat(60));
  }

  // ─────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────

  private getAgentSkillsPath(agent: string): string {
    const agentPaths: Record<string, string> = {
      claude: '.claude/skills',
      agents: '.agents/skills',
      cursor: '.cursor/skills',
      windsurf: '.windsurf/skills',
      codex: '.codex/skills',
      gemini: '.gemini/skills',
      kiro: '.kiro/skills',
      augment: '.augment/skills',
      amp: '.config/agents/skills',
      cline: '.cline/skills',
      opencode: '.config/opencode/skills',
      qwen: '.qwen/skills',
      openclaw: '.openclaw/skills',
      hermes: '.hermes/skills',
      qoder: '.qoder/skills',
      aone_copilot: '.aone_copilot/skills',
    };

    const relativePath = agentPaths[agent];
    if (!relativePath) {
      throw new Error(`Unknown agent: ${agent}`);
    }
    return this.getPath(relativePath);
  }
}
```

- [ ] Run test to verify it passes

```bash
npm run build && npm run test:unit -- tests/unit/e2e-context.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/context.ts tests/unit/e2e-context.test.ts
git commit -m "feat(e2e): add E2EContext runtime context"
```

---

## Task 10: E2EScenario Implementation

**Files:**
- Create: `tests/end2end/framework/scenario.ts`
- Test: `tests/unit/e2e-scenario.test.ts`

### Step 1: Write the failing test

- [ ] Create test file

```typescript
// tests/unit/e2e-scenario.test.ts
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

describe('E2EScenario', () => {
  const contexts: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      await ctx.cleanup();
    }
  });

  it('setup creates temp directory and returns context', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario().setup();
    contexts.push(ctx);

    expect(ctx.homeDir).toContain('syncskill-e2e-');
    const stats = await stat(ctx.homeDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('withAgents creates agent directories', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .setup();
    contexts.push(ctx);

    const claudeStats = await stat(join(ctx.homeDir, '.claude', 'skills'));
    expect(claudeStats.isDirectory()).toBe(true);

    const agentsStats = await stat(join(ctx.homeDir, '.agents', 'skills'));
    expect(agentsStats.isDirectory()).toBe(true);
  });

  it('withSkill creates skill in syncskill dir', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withSkill('my-skill', '# My Skill\n')
      .setup();
    contexts.push(ctx);

    const skillStats = await stat(join(ctx.syncskillDir, 'skills', 'my-skill', 'SKILL.md'));
    expect(skillStats.isFile()).toBe(true);
  });

  it('withInit runs syncskill init', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withAgents('claude')
      .withInit({ skipScan: true, skipSkill: true })
      .setup();
    contexts.push(ctx);

    await ctx.assertFileExists('.syncskill/config.yaml');
  });

  it('withGitSource creates git repository', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withGitSource('test-repo', { skills: ['skill-a'] })
      .setup();
    contexts.push(ctx);

    const url = ctx.getGitSourceUrl('test-repo');
    expect(url).toContain('test-repo.git');
  });

  it('withArchive creates archive file', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withArchive('skills.zip', { skills: ['skill-x'], format: 'zip' })
      .setup();
    contexts.push(ctx);

    const archivePath = ctx.getArchivePath('skills.zip');
    const stats = await stat(archivePath);
    expect(stats.isFile()).toBe(true);
  });

  it('withMockServer creates server directory', async () => {
    const { E2EScenario } = await import('../end2end/framework/scenario.js');

    const ctx = await new E2EScenario()
      .withMockServer({ name: 'dev' })
      .setup();
    contexts.push(ctx);

    const serverPath = ctx.getMockServerPath('dev');
    const stats = await stat(serverPath);
    expect(stats.isDirectory()).toBe(true);
  });
});
```

- [ ] Run test to verify it fails

```bash
npm run test:unit -- tests/unit/e2e-scenario.test.ts
```

Expected: FAIL with "Cannot find module"

### Step 2: Implement scenario module

- [ ] Create scenario.ts

```typescript
// tests/end2end/framework/scenario.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { createManagedTempDir } from './cleanup.js';
import { E2EContext } from './context.js';
import { getProjectRoot, runSyncskill } from './runner.js';
import {
  createSkillDir,
  createMultipleSkills,
  createGitSourceFixture,
  createArchive,
  createMockServer,
  type GitSourceConfig,
  type ArchiveConfig,
  type MockServerConfig,
} from './fixtures/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface InitOptions {
  skipScan?: boolean;
  skipSkill?: boolean;
}

/**
 * Builder for E2E test scenarios.
 */
export class E2EScenario {
  private agents: string[] = [];
  private skills: Array<{ name: string; content?: string }> = [];
  private gitSources: Array<{ name: string; config: GitSourceConfig }> = [];
  private archives: Array<{ name: string; config: ArchiveConfig }> = [];
  private mockServers: MockServerConfig[] = [];
  private configOverrides: Record<string, unknown> = {};
  private linksConfig: Record<string, string[]> = {};
  private initOptions: InitOptions | null = null;
  private envVars: Record<string, string> = {};
  private _requiresNetwork = false;

  // ─────────────────────────────────────────────────────────
  // Agent Configuration
  // ─────────────────────────────────────────────────────────

  withAgent(name: string): this {
    this.agents.push(name);
    return this;
  }

  withAgents(...names: string[]): this {
    this.agents.push(...names);
    return this;
  }

  // ─────────────────────────────────────────────────────────
  // Skill Configuration
  // ─────────────────────────────────────────────────────────

  withSkill(name: string, content?: string): this {
    this.skills.push({ name, content });
    return this;
  }

  withSkills(names: string[]): this {
    for (const name of names) {
      this.skills.push({ name });
    }
    return this;
  }

  // ─────────────────────────────────────────────────────────
  // Source Configuration
  // ─────────────────────────────────────────────────────────

  withGitSource(name: string, config: GitSourceConfig): this {
    this.gitSources.push({ name, config });
    return this;
  }

  withArchive(name: string, config: ArchiveConfig): this {
    this.archives.push({ name, config });
    return this;
  }

  withMockServer(config: MockServerConfig): this {
    this.mockServers.push(config);
    return this;
  }

  withMockServers(configs: MockServerConfig[]): this {
    this.mockServers.push(...configs);
    return this;
  }

  // ─────────────────────────────────────────────────────────
  // Config Configuration
  // ─────────────────────────────────────────────────────────

  withConfig(partial: Record<string, unknown>): this {
    Object.assign(this.configOverrides, partial);
    return this;
  }

  withLinks(links: Record<string, string[]>): this {
    Object.assign(this.linksConfig, links);
    return this;
  }

  withInit(options?: InitOptions): this {
    this.initOptions = options ?? {};
    return this;
  }

  // ─────────────────────────────────────────────────────────
  // Advanced Configuration
  // ─────────────────────────────────────────────────────────

  requiresNetwork(): this {
    this._requiresNetwork = true;
    return this;
  }

  withEnv(env: Record<string, string>): this {
    Object.assign(this.envVars, env);
    return this;
  }

  // ─────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────

  async setup(): Promise<E2EContext> {
    const homeDir = await createManagedTempDir();
    const projectRoot = getProjectRoot();
    const ctx = new E2EContext(homeDir, projectRoot);

    // Create agent directories
    for (const agent of this.agents) {
      const agentPath = this.getAgentPath(homeDir, agent);
      await mkdir(agentPath, { recursive: true });
    }

    // Create syncskill structure
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(skillsDir, { recursive: true });

    // Create skills
    for (const { name, content } of this.skills) {
      await createSkillDir(skillsDir, name, content);
    }

    // Create git sources
    for (const { name, config } of this.gitSources) {
      const fixture = await createGitSourceFixture(homeDir, name, config);
      ctx.registerGitSource(name, fixture);
    }

    // Create archives
    for (const { name, config } of this.archives) {
      const archivePath = await createArchive(homeDir, name, config);
      ctx.registerArchive(name, archivePath);
    }

    // Create mock servers
    for (const serverConfig of this.mockServers) {
      const server = await createMockServer(homeDir, serverConfig);
      ctx.registerMockServer(serverConfig.name, server);
    }

    // Run init if requested
    if (this.initOptions !== null) {
      const args = ['init', '-y'];
      if (this.initOptions.skipScan) args.push('--skip-scan');
      if (this.initOptions.skipSkill) args.push('--skip-skill');

      await runSyncskill(homeDir, projectRoot, args, { env: this.envVars });
    }

    // Apply config overrides and links
    if (Object.keys(this.configOverrides).length > 0 || Object.keys(this.linksConfig).length > 0) {
      const configPath = join(homeDir, '.syncskill', 'config.yaml');
      let config: Record<string, unknown> = { version: 1 };

      try {
        const existing = await ctx.readConfig();
        config = existing as Record<string, unknown>;
      } catch {
        // No existing config
      }

      Object.assign(config, this.configOverrides);
      if (Object.keys(this.linksConfig).length > 0) {
        config.links = { ...(config.links as Record<string, string[]>), ...this.linksConfig };
      }

      await writeFile(configPath, stringify(config), 'utf8');
    }

    return ctx;
  }

  // ─────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────

  private getAgentPath(homeDir: string, agent: string): string {
    const agentPaths: Record<string, string> = {
      claude: '.claude/skills',
      agents: '.agents/skills',
      cursor: '.cursor/skills',
      windsurf: '.windsurf/skills',
      codex: '.codex/skills',
      gemini: '.gemini/skills',
      kiro: '.kiro/skills',
      augment: '.augment/skills',
      amp: '.config/agents/skills',
      cline: '.cline/skills',
      opencode: '.config/opencode/skills',
      qwen: '.qwen/skills',
      openclaw: '.openclaw/skills',
      hermes: '.hermes/skills',
      qoder: '.qoder/skills',
      aone_copilot: '.aone_copilot/skills',
    };

    const relativePath = agentPaths[agent];
    if (!relativePath) {
      throw new Error(`Unknown agent: ${agent}`);
    }
    return join(homeDir, relativePath);
  }
}
```

- [ ] Run test to verify it passes

```bash
npm run build && npm run test:unit -- tests/unit/e2e-scenario.test.ts
```

Expected: PASS

- [ ] Commit

```bash
git add tests/end2end/framework/scenario.ts tests/unit/e2e-scenario.test.ts
git commit -m "feat(e2e): add E2EScenario builder"
```

---

## Task 11: E2E Test Entry Function and Setup

**Files:**
- Create: `tests/end2end/framework/e2e-test.ts`
- Create: `tests/end2end/framework/setup.ts`
- Create: `tests/end2end/framework/index.ts`
- Test: Integration test via sample e2e test

### Step 1: Create e2e-test wrapper

- [ ] Create e2e-test.ts

```typescript
// tests/end2end/framework/e2e-test.ts
import { it, describe } from 'vitest';

export interface E2ETestOptions {
  timeout?: number;
  network?: boolean;
  tags?: string[];
  skip?: boolean | (() => boolean);
  only?: boolean;
}

/**
 * E2E test entry point.
 */
export function e2eTest(
  name: string,
  fn: () => Promise<void>,
  options: E2ETestOptions = {}
): void {
  const {
    timeout = 60000,
    network = false,
    skip = false,
    only = false,
  } = options;

  const shouldSkip = typeof skip === 'function' ? skip() : skip;

  // Skip network tests if E2E_SKIP_NETWORK is set
  const skipNetwork = network && process.env.E2E_SKIP_NETWORK === '1';

  if (shouldSkip || skipNetwork) {
    it.skip(name, fn);
  } else if (only) {
    it.only(name, fn, timeout);
  } else {
    it(name, fn, timeout);
  }
}

// Convenience variants
e2eTest.network = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'network'> = {}) =>
  e2eTest(name, fn, { ...options, network: true });

e2eTest.skip = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'skip'> = {}) =>
  e2eTest(name, fn, { ...options, skip: true });

e2eTest.only = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'only'> = {}) =>
  e2eTest(name, fn, { ...options, only: true });
```

- [ ] Create setup.ts

```typescript
// tests/end2end/framework/setup.ts
import { afterEach, beforeAll } from 'vitest';
import { cleanupStaleTempDirs } from './cleanup.js';
import type { E2EContext } from './context.js';

// Global setup: cleanup stale temp directories from previous runs
beforeAll(async () => {
  await cleanupStaleTempDirs();
});

// Auto-dump diagnostics on test failure
afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    const e2eCtx = (context.task as unknown as { __e2eContext?: E2EContext }).__e2eContext;
    if (e2eCtx) {
      e2eCtx.dumpDiagnostics();
    }
  }
});
```

- [ ] Create framework/index.ts

```typescript
// tests/end2end/framework/index.ts

// Core
export { E2EGuardError, assertPathSafe, isInAllowedTempDir, getProtectedPaths } from './guard.js';
export { TEMP_PREFIX, cleanupStaleTempDirs, createManagedTempDir, removeTempDir } from './cleanup.js';
export { execCommand, runSyncskill, isVerbose, getProjectRoot, type RunResult, type RunOptions } from './runner.js';
export { E2EContext } from './context.js';
export { E2EScenario } from './scenario.js';
export { e2eTest, type E2ETestOptions } from './e2e-test.js';

// Fixtures
export * from './fixtures/index.js';
```

- [ ] Commit

```bash
git add tests/end2end/framework/e2e-test.ts tests/end2end/framework/setup.ts tests/end2end/framework/index.ts
git commit -m "feat(e2e): add e2eTest wrapper and setup module"
```

---

## Task 12: Update NPM Scripts and Vitest Config

**Files:**
- Modify: `package.json`

### Step 1: Update package.json scripts

- [ ] Edit package.json

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json && shx cp -r skills dist/",
    "dev": "tsx src/index.ts",
    "test": "vitest run tests/unit tests/integration",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/end2end/cases --exclude '**/network/**'",
    "test:e2e:network": "vitest run tests/end2end/cases/network",
    "test:e2e:all": "vitest run tests/end2end/cases",
    "test:e2e:verbose": "E2E_VERBOSE=1 vitest run tests/end2end/cases --exclude '**/network/**'",
    "test:e2e:all:verbose": "E2E_VERBOSE=1 vitest run tests/end2end/cases",
    "test:all": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] Commit

```bash
git add package.json
git commit -m "chore: update npm scripts for E2E testing"
```

---

## Task 13: Create Initial Smoke Test

**Files:**
- Create: `tests/end2end/cases/smoke/init.test.ts`

### Step 1: Create smoke test

- [ ] Create test directory and file

```typescript
// tests/end2end/cases/smoke/init.test.ts
import { describe, expect } from 'vitest';
import { e2eTest, E2EScenario } from '../../framework/index.js';

describe('E2E Smoke Tests', () => {
  e2eTest('init creates syncskill directory structure', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude')
      .setup();

    try {
      await ctx.run('syncskill', 'init', '-y', '--skip-skill');

      await ctx.assertFileExists('.syncskill/config.yaml');
      await ctx.assertFileExists('.syncskill/skills');

      const config = await ctx.readConfig() as { version: number; agents: string[] };
      expect(config.version).toBe(1);
      expect(config.agents).toContain('claude');
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('link creates symlinks in agent directories', async () => {
    const ctx = await new E2EScenario()
      .withAgents('claude', 'agents')
      .withInit({ skipScan: true, skipSkill: true })
      .withSkill('test-skill', '# Test Skill\n')
      .withLinks({ 'test-skill': ['*'] })
      .setup();

    try {
      await ctx.run('syncskill', 'link', '--all');

      await ctx.assertLinked('test-skill', ['claude', 'agents']);
    } finally {
      await ctx.cleanup();
    }
  });

  e2eTest('help command works', async () => {
    const ctx = await new E2EScenario().setup();

    try {
      const result = await ctx.run('syncskill', '--help');

      expect(result.success).toBe(true);
      ctx.assertOutputContains(result, 'Usage: syncskill');
      ctx.assertOutputContains(result, 'init');
      ctx.assertOutputContains(result, 'install');
      ctx.assertOutputContains(result, 'link');
    } finally {
      await ctx.cleanup();
    }
  });
});
```

- [ ] Run the smoke test to verify framework works

```bash
npm run build && npm run test:e2e
```

Expected: PASS

- [ ] Commit

```bash
mkdir -p tests/end2end/cases/smoke
git add tests/end2end/cases/smoke/init.test.ts
git commit -m "test(e2e): add initial smoke tests"
```

---

## Task 14: Final Integration Verification

**Files:**
- None (verification only)

### Step 1: Run full test suite

- [ ] Build and run all tests

```bash
npm run build && npm run test:all
```

Expected: All tests PASS

### Step 2: Run E2E verbose mode

- [ ] Verify verbose output works

```bash
npm run test:e2e:verbose
```

Expected: See detailed command output with timestamps

### Step 3: Verify protected path guard

- [ ] The guard should be active in tests - verify no tests touch real HOME

```bash
# E2E tests should all use temp directories
grep -r "homeDir" tests/end2end/cases/ | head -5
```

- [ ] Final commit

```bash
git add -A
git commit -m "feat(e2e): complete E2E test framework implementation"
```

---

## Summary

The E2E test framework is now complete with:

1. **Guard module** - Prevents touching real user directories
2. **Cleanup module** - Manages temp directory lifecycle
3. **Runner module** - Executes CLI commands with HOME override
4. **Fixtures** - Skill, Git, Archive, Server, GitHub config
5. **E2EContext** - Runtime context with assertions
6. **E2EScenario** - Builder for declarative test setup
7. **e2eTest wrapper** - Test entry with network/skip variants
8. **NPM scripts** - Separate commands for different test suites
9. **Smoke tests** - Initial verification tests

Next steps: Add more test cases following the patterns in `docs/e2e-test-guide.md`.
