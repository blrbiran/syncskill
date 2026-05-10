# Install Command and Syncskill Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `syncskill install` / `syncskill i` command and create the embedded syncskill skill that AI agents can use to manage skills.

**Architecture:** The install command has two modes: (1) no args installs the embedded syncskill skill from `dist/skills/syncskill/` to `~/.syncskill/skills/`, (2) with URL/path delegates to existing `addSourceFromUrl` logic. The skill file is packaged in the npm distribution and copied at runtime.

**Tech Stack:** TypeScript, Commander.js, @inquirer/prompts, shx (build tool)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/syncskill/SKILL.md` | Create | Syncskill skill definition for AI agents |
| `src/install.ts` | Create | Install command logic (embedded skill + URL/path) |
| `src/index.ts` | Modify | Register `install` / `i` command |
| `src/repo.ts` | Modify | Add skill installation prompt to `init` |
| `package.json` | Modify | Add shx, files field, update build script |
| `tests/unit/install.test.ts` | Create | Unit tests for install module |
| `tests/integration/install-cli.test.ts` | Create | CLI integration tests |

---

### Task 1: Create syncskill SKILL.md

**Files:**
- Create: `skills/syncskill/SKILL.md`

> **Note:** User requested using `skill-creator` skill for this task. Invoke `skill-creator` with the skill content from the design spec.

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p skills/syncskill
```

- [ ] **Step 2: Create SKILL.md file**

```markdown
---
name: syncskill
description: Manage and sync AI agent skills across multiple agents (Claude, Hermes, Qoder, etc.) and devices. Install skills from GitHub/local sources, link to agents, bidirectional sync with remote servers. Also enables AI to self-install skills on demand.
---

# syncskill

Use this skill when:
- User wants to install, add, or manage AI skills
- User mentions syncskill, skill sync, or skill management
- User wants to add skills from GitHub or other sources
- User wants to sync skills to remote servers
- User wants to link/unlink skills to AI agents
- User asks about skill status or configuration

## Commands Reference

### Installation
- `syncskill init` — Initialize ~/.syncskill/ directory
- `syncskill install` / `syncskill i` — Install syncskill skill itself
- `syncskill install <url-or-path>` — Install skill from URL or local path

### Source Management
- `source add <url> [--name <n>] [--path <p>]` — Add external source
- `source update [--all | <name>]` — Update sources
- `source list` — List configured sources
- `source remove <name>` — Remove a source

### Link Management
- `link` — Interactive matrix editor for skill→agent mapping
- `link list` / `link ls` — Show link status
- `link <skill>` — Link specific skill to agents
- `unlink <skill>` — Remove skill links
- `scan [--migrate]` — Scan for new/unmanaged skills

### Sync Operations
- `push [<server>] [--all] [--dry-run]` — Push to remote
- `pull [<server>] [--all] [--dry-run]` — Pull from remote
- `sync [<server>] [--all] [--dry-run]` — Full sync (pull then push)
- `status` — Show sync status
- `diff <server>` — Show pending changes
- `resolve <skill> [--local|--remote] [--diff]` — Resolve conflicts
- `refresh [--local|--remote|--all|--status]` — Refresh manifests

### Configuration
- `config` — Interactive config editor
- `config show` — Print current config
- `config set <key> <value>` — Set config value
- `server` — Manage servers
- `server probe <name>` — Diagnose server status
- `remote` — Manage skill→server mappings

## Usage Examples

### Install a skill from GitHub
```bash
syncskill i https://github.com/user/skills-repo
```

### Sync skills to all servers
```bash
syncskill sync --all
```

### Check what needs to be synced
```bash
syncskill status
```
```

- [ ] **Step 3: Commit**

```bash
git add skills/syncskill/SKILL.md
git commit -m "feat: add syncskill skill definition"
```

---

### Task 2: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Write failing test for build script**

Create `tests/unit/package.test.ts` addition:

```typescript
// Add to existing tests/unit/package.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package.json build configuration', () => {
  const rootDir = join(import.meta.dirname, '../..');
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

  it('should have shx in devDependencies', () => {
    expect(pkg.devDependencies.shx).toBeDefined();
  });

  it('should have files field including skills', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('skills');
  });

  it('should copy skills in build script', () => {
    expect(pkg.scripts.build).toContain('shx cp -r skills dist/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/unit/package.test.ts
```

Expected: FAIL (shx not in devDependencies, no files field, build script doesn't copy skills)

- [ ] **Step 3: Install shx**

```bash
npm install --save-dev shx
```

- [ ] **Step 4: Update package.json**

Edit `package.json`:

```json
{
  "name": "syncskill",
  "version": "0.1.0",
  "description": "Multi-device AI Agent Skill sync tool",
  "type": "module",
  "bin": {
    "syncskill": "dist/index.js"
  },
  "files": [
    "dist",
    "skills"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json && shx cp -r skills dist/",
    "dev": "tsx src/index.ts",
    "test": "vitest run tests/unit",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:end2end": "vitest run tests/end2end",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@inquirer/core": "^11.1.9",
    "@inquirer/prompts": "^7.5.1",
    "commander": "^14.0.0",
    "yaml": "^2.8.1"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "shx": "^0.3.4",
    "tsx": "^4.19.3",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- --run tests/unit/package.test.ts
```

Expected: PASS

- [ ] **Step 6: Verify build works**

```bash
npm run build
ls dist/skills/syncskill/SKILL.md
```

Expected: File exists

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tests/unit/package.test.ts
git commit -m "build: add shx and configure skill packaging"
```

---

### Task 3: Create install.ts module

**Files:**
- Create: `src/install.ts`
- Create: `tests/unit/install.test.ts`

- [ ] **Step 1: Write failing test for getEmbeddedSkillPath**

Create `tests/unit/install.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEmbeddedSkillPath, installSyncskillSkill } from '../src/install.js';

describe('install module', () => {
  describe('getEmbeddedSkillPath', () => {
    it('should return path to dist/skills/syncskill', () => {
      const path = getEmbeddedSkillPath();
      expect(path).toContain('skills');
      expect(path).toContain('syncskill');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --run tests/unit/install.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Create install.ts with getEmbeddedSkillPath**

Create `src/install.ts`:

```typescript
import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSyncPaths, loadConfig, saveConfig } from './config.js';
import { linkConfiguredSkills } from './linker.js';
import { addSourceFromUrl, DiscoveredSkill } from './source.js';

/**
 * Get the path to the embedded syncskill skill in dist/skills/syncskill/
 */
export function getEmbeddedSkillPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);
  return join(distDir, 'skills', 'syncskill');
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface InstallSyncskillSkillResult {
  alreadyInstalled: boolean;
  installedPath?: string;
  linkedAgents?: string[];
}

/**
 * Install the embedded syncskill skill to ~/.syncskill/skills/syncskill/
 */
export async function installSyncskillSkill(homeDir: string): Promise<InstallSyncskillSkillResult> {
  const { skillsDir } = getSyncPaths(homeDir);
  const targetPath = join(skillsDir, 'syncskill');

  // Check if already installed
  if (await pathExists(targetPath)) {
    return { alreadyInstalled: true };
  }

  // Get embedded skill path
  const sourcePath = getEmbeddedSkillPath();

  // Verify source exists
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Embedded syncskill skill not found at: ${sourcePath}`);
  }

  // Ensure target directory exists
  await mkdir(skillsDir, { recursive: true });

  // Copy skill
  await cp(sourcePath, targetPath, { recursive: true });

  // Update config to add link
  const config = await loadConfig(homeDir);
  if (!config.links['syncskill']) {
    config.links['syncskill'] = ['*'];
    await saveConfig(config, homeDir);
  }

  // Link to all agents
  await linkConfiguredSkills(homeDir, { all: false, skillName: 'syncskill' });

  // Get linked agents
  const linkedAgents = Object.keys(config.agents);

  return {
    alreadyInstalled: false,
    installedPath: targetPath,
    linkedAgents
  };
}

export interface InstallFromSourceOptions {
  name?: string;
  store?: string;
  skillSubdir?: string;
  ref?: string;
  skipPrompt?: boolean;
  onSelectSkills?: (skills: DiscoveredSkill[], existingSkills: Set<string>) => Promise<string[]>;
}

export interface InstallFromSourceResult {
  sourceName: string;
  installedSkills: string[];
  linkedAgents: string[];
}

/**
 * Install skills from a URL or local path (delegates to source add + link)
 */
export async function installFromSource(
  homeDir: string,
  urlOrPath: string,
  options: InstallFromSourceOptions = {}
): Promise<InstallFromSourceResult> {
  // Add source (this handles git clone, http download, or local path)
  const result = await addSourceFromUrl(homeDir, urlOrPath, {
    name: options.name,
    store: options.store,
    skillSubdir: options.skillSubdir,
    ref: options.ref,
    skipPrompt: options.skipPrompt,
    onSelectSkills: options.onSelectSkills
  });

  // Get config to find linked agents
  const config = await loadConfig(homeDir);
  const linkedAgents = Object.keys(config.agents);

  // Link all skills from this source to all agents
  const installedSkills: string[] = [];
  for (const [skillName, agents] of Object.entries(config.links)) {
    if (agents.length > 0) {
      await linkConfiguredSkills(homeDir, { all: false, skillName });
      installedSkills.push(skillName);
    }
  }

  return {
    sourceName: result.name,
    installedSkills,
    linkedAgents
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --run tests/unit/install.test.ts
```

Expected: PASS

- [ ] **Step 5: Add test for installSyncskillSkill**

Add to `tests/unit/install.test.ts`:

```typescript
describe('installSyncskillSkill', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = join(import.meta.dirname, `../../.test-tmp-${Date.now()}`);
    homeDir = join(tempDir, 'home');
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    
    // Create minimal config
    const configPath = join(homeDir, '.syncskill', 'config.yaml');
    await writeFile(configPath, 'version: 1\nagents:\n  claude: ~/.claude/skills\nlinks: {}\nservers: {}\nsources: {}\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return alreadyInstalled: true if skill exists', async () => {
    // Create existing skill
    await mkdir(join(homeDir, '.syncskill', 'skills', 'syncskill'), { recursive: true });
    await writeFile(join(homeDir, '.syncskill', 'skills', 'syncskill', 'SKILL.md'), '# test');

    const result = await installSyncskillSkill(homeDir);
    expect(result.alreadyInstalled).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests**

```bash
npm test -- --run tests/unit/install.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/install.ts tests/unit/install.test.ts
git commit -m "feat(install): add install module with embedded skill support"
```

---

### Task 4: Add install command to CLI

**Files:**
- Modify: `src/index.ts:1-10` (imports)
- Modify: `src/index.ts:160-162` (after init command)

- [ ] **Step 1: Write failing integration test**

Create `tests/integration/install-cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('install CLI command', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = join(import.meta.dirname, `../../.test-tmp-${Date.now()}`);
    homeDir = join(tempDir, 'home');
    await mkdir(join(homeDir, '.syncskill', 'skills'), { recursive: true });
    
    // Create minimal config
    const configPath = join(homeDir, '.syncskill', 'config.yaml');
    await writeFile(configPath, 'version: 1\nagents:\n  claude: ~/.claude/skills\nlinks: {}\nservers: {}\nsources: {}\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should show install command in help', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('install');
  });

  it('should accept i as alias for install', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'i', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('Install');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:integration -- --run tests/integration/install-cli.test.ts
```

Expected: FAIL (install command not found)

- [ ] **Step 3: Add import to index.ts**

Add to imports in `src/index.ts` (after line 8):

```typescript
import { installSyncskillSkill, installFromSource, DiscoveredSkill } from './install.js';
```

- [ ] **Step 4: Add install command**

Add after the `init` command (around line 162) in `src/index.ts`:

```typescript
  program
    .command('install [urlOrPath]')
    .alias('i')
    .description('Install skill(s). No args: install syncskill skill; with URL/path: install from source')
    .option('--name <name>', 'Source name (for URL/path)')
    .option('--path <path>', 'Storage path for source files')
    .option('--skill-subdir <dir>', 'Subdirectory within source containing skills')
    .option('--ref <ref>', 'Git ref (branch/tag)')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (urlOrPath: string | undefined, options: {
      name?: string;
      path?: string;
      skillSubdir?: string;
      ref?: string;
      yes?: boolean;
    }) => {
      if (!urlOrPath) {
        // Install syncskill skill itself
        const result = await installSyncskillSkill(resolvedHomeDir);
        
        if (result.alreadyInstalled) {
          console.log('syncskill skill already installed');
          return;
        }

        console.log(`✓ Installed syncskill skill to ${result.installedPath}`);
        if (result.linkedAgents && result.linkedAgents.length > 0) {
          console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
        }
        return;
      }

      // Install from URL/path
      const result = await installFromSource(resolvedHomeDir, urlOrPath, {
        name: options.name,
        store: options.path,
        skillSubdir: options.skillSubdir,
        ref: options.ref,
        skipPrompt: options.yes,
        onSelectSkills: async (skills: DiscoveredSkill[], existingSkills: Set<string>) => {
          const available = skills.filter(s => !existingSkills.has(s.name));
          
          if (available.length === 0) {
            console.log('All skills from this source already exist.');
            return [];
          }

          if (options.yes) {
            return available.map(s => s.name);
          }

          console.log(`\nFound ${skills.length} skill(s):\n`);
          
          const selected = await checkbox({
            message: 'Select skills to install:',
            choices: available.map(s => ({
              name: `${s.name} (${s.relativePath})`,
              value: s.name,
              checked: true
            }))
          });

          return selected;
        }
      });

      if (result.installedSkills.length === 0) {
        console.log('No skills installed.');
        return;
      }

      console.log(`✓ Installed ${result.installedSkills.length} skill(s)`);
      if (result.linkedAgents.length > 0) {
        console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
      }
    });
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:integration -- --run tests/integration/install-cli.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/integration/install-cli.test.ts
git commit -m "feat(cli): add install/i command"
```

---

### Task 5: Update init to prompt for skill installation

**Files:**
- Modify: `src/repo.ts`
- Modify: `tests/integration/repo.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/integration/repo.test.ts`:

```typescript
describe('init --skip-skill', () => {
  it('should skip skill installation prompt with --skip-skill', async () => {
    // Test that --skip-skill flag is accepted
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/index.ts', 'init', '--skip-skill', '--help'], {
      env: { ...process.env, HOME: homeDir }
    });
    expect(stdout).toContain('skip-skill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:integration -- --run tests/integration/repo.test.ts
```

Expected: FAIL (--skip-skill not recognized)

- [ ] **Step 3: Update InitializeRepoOptions interface**

In `src/repo.ts`, update the interface:

```typescript
export interface InitializeRepoOptions {
  skipSources?: boolean;
  skipSkill?: boolean;
  yes?: boolean;
}
```

- [ ] **Step 4: Add skill installation prompt to initializeRepo**

In `src/repo.ts`, add import and update function:

```typescript
import { confirm } from '@inquirer/prompts';
import { installSyncskillSkill } from './install.js';
```

Add at the end of `initializeRepo` function (before the server count check):

```typescript
  // Prompt to install syncskill skill
  if (!options.skipSkill) {
    const { skillsDir } = getSyncPaths(homeDir);
    const syncskillPath = join(skillsDir, 'syncskill');
    
    const alreadyExists = await exists(syncskillPath);
    
    if (!alreadyExists) {
      let shouldInstall = options.yes ?? false;
      
      if (!options.yes) {
        shouldInstall = await confirm({
          message: 'Would you like to install the syncskill skill?\nThis skill helps AI agents manage skills using syncskill commands.',
          default: true
        });
      }

      if (shouldInstall) {
        const result = await installSyncskillSkill(homeDir);
        if (!result.alreadyInstalled) {
          console.log(`✓ Installed syncskill skill`);
          if (result.linkedAgents && result.linkedAgents.length > 0) {
            console.log(`✓ Linked to: ${result.linkedAgents.join(', ')}`);
          }
        }
      } else {
        console.log('You can install later with: syncskill install');
      }
    }
  }
```

- [ ] **Step 5: Update init command in index.ts**

In `src/index.ts`, update the init command options:

```typescript
  program
    .command('init')
    .description('Initialize the local syncskill repository')
    .option('--skip-sources', 'Skip migrating skills from detected source directories')
    .option('--skip-skill', 'Skip installing syncskill skill')
    .option('-y, --yes', 'Accept all defaults')
    .action(async (options: { skipSources?: boolean; skipSkill?: boolean; yes?: boolean }) => {
      await initializeRepo(resolvedHomeDir, {
        skipSources: Boolean(options.skipSources),
        skipSkill: Boolean(options.skipSkill),
        yes: Boolean(options.yes)
      });
    });
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npm run test:integration -- --run tests/integration/repo.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/repo.ts src/index.ts tests/integration/repo.test.ts
git commit -m "feat(init): add --skip-skill flag and skill installation prompt"
```

---

### Task 6: Final verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

```bash
npm test
npm run test:integration
```

Expected: All tests PASS

- [ ] **Step 2: Build and test manually**

```bash
npm run build
npm link
syncskill --help
syncskill install --help
syncskill i --help
```

Expected: Commands shown correctly

- [ ] **Step 3: Test install command**

```bash
# Create a fresh test environment
rm -rf /tmp/test-syncskill-home
HOME=/tmp/test-syncskill-home syncskill init -y
ls /tmp/test-syncskill-home/.syncskill/skills/syncskill/
```

Expected: SKILL.md exists

- [ ] **Step 4: Update anatomy.md**

Record new files in `.wolf/anatomy.md`

- [ ] **Step 5: Final commit if any changes**

```bash
git status
# If any uncommitted changes, commit them
```

---

## Summary

| Task | Description | Estimated Time |
|------|-------------|----------------|
| 1 | Create SKILL.md | 5 min |
| 2 | Update package.json | 10 min |
| 3 | Create install.ts | 15 min |
| 4 | Add CLI command | 10 min |
| 5 | Update init prompt | 10 min |
| 6 | Final verification | 10 min |

**Total estimated time:** ~60 minutes
