# syncskill Local Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 1 of `syncskill`: `init`, `config`, `config show`, `config set`, `link`, and `scan`, with all local state rooted at `~/.syncskill/`.

**Architecture:** Keep `src/index.ts` as thin commander wiring. Put path/config logic in `src/config.ts`, repo initialization in `src/repo.ts`, link and scan behavior in `src/linker.ts`, and prompt-driven local config editing in `src/config-ui.ts`. For this milestone, the interactive `config` UI only covers `agents`, `links`, and `conflict_resolution`; `servers` and `sources` move to later milestone plans with their owning domains.

**Tech Stack:** TypeScript, Node 20 ESM, commander, yaml, @inquirer/prompts, vitest

---

## File Map

**Create:**
- `package.json`
- `tsconfig.json`
- `config.example.yaml`
- `src/index.ts`
- `src/config.ts`
- `src/repo.ts`
- `src/linker.ts`
- `src/config-ui.ts`
- `tests/config.test.ts`
- `tests/config-cli.test.ts`
- `tests/repo.test.ts`
- `tests/linker.test.ts`
- `tests/scan.test.ts`
- `tests/config-ui.test.ts`

**Modify:**
- `.gitignore`

**Companion plans to write later:**
- `docs/superpowers/plans/2026-04-30-syncskill-state-and-reconciliation.md`
- `docs/superpowers/plans/2026-04-30-syncskill-sources.md`
- `docs/superpowers/plans/2026-04-30-syncskill-remote-sync.md`

### Task 1: Bootstrap the TypeScript CLI workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `config.example.yaml`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `tests/config.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Create the toolchain files before writing production behavior**

```json
{
  "name": "syncskill",
  "version": "1.0.0",
  "description": "Multi-device AI Agent Skill sync tool",
  "type": "module",
  "bin": {
    "syncskill": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@inquirer/prompts": "^7.0.0",
    "commander": "^12.0.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

```yaml
version: 1
conflict_resolution: manual
agents: {}
links: {}
servers: {}
sources: {}
```

```gitignore
dist/
node_modules/
coverage/
*.log
.DS_Store
.env
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` is created and npm exits successfully.

- [ ] **Step 3: Write the failing path-helper test**

```ts
import { describe, expect, test } from 'vitest';
import { getSyncDir, getSyncPaths } from '../src/config.js';

describe('config paths', () => {
  test('getSyncDir nests .syncskill under the supplied home directory', () => {
    expect(getSyncDir('/tmp/demo-home')).toBe('/tmp/demo-home/.syncskill');
  });

  test('getSyncPaths derives child paths from the sync directory', () => {
    expect(getSyncPaths('/tmp/demo-home')).toEqual({
      syncDir: '/tmp/demo-home/.syncskill',
      configFile: '/tmp/demo-home/.syncskill/config.yaml',
      skillsDir: '/tmp/demo-home/.syncskill/skills',
      manifestsDir: '/tmp/demo-home/.syncskill/manifests',
      tempDir: '/tmp/demo-home/.syncskill/.tmp',
      historyFile: '/tmp/demo-home/.syncskill/manifest_history.json'
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails for the expected reason**

Run: `npx vitest run tests/config.test.ts -t "getSyncDir nests .syncskill under the supplied home directory"`
Expected: FAIL with a module-resolution error for `../src/config.js` or a missing export.

- [ ] **Step 5: Write the minimal path implementation and CLI bootstrap**

```ts
import os from 'node:os';
import path from 'node:path';

export interface SyncPaths {
  syncDir: string;
  configFile: string;
  skillsDir: string;
  manifestsDir: string;
  tempDir: string;
  historyFile: string;
}

export function getSyncDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.syncskill');
}

export function getSyncPaths(homeDir: string = os.homedir()): SyncPaths {
  const syncDir = getSyncDir(homeDir);

  return {
    syncDir,
    configFile: path.join(syncDir, 'config.yaml'),
    skillsDir: path.join(syncDir, 'skills'),
    manifestsDir: path.join(syncDir, 'manifests'),
    tempDir: path.join(syncDir, '.tmp'),
    historyFile: path.join(syncDir, 'manifest_history.json')
  };
}
```

```ts
#!/usr/bin/env node
import { Command } from 'commander';

export function createProgram(): Command {
  return new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  await createProgram().parseAsync(process.argv);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 7: Commit the workspace bootstrap**

```bash
git add .gitignore package.json package-lock.json tsconfig.json config.example.yaml src/index.ts src/config.ts tests/config.test.ts
git commit -m "feat: bootstrap syncskill local CLI foundation"
```

### Task 2: Implement config loading, saving, validation, and agent detection

**Files:**
- Modify: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Replace `tests/config.test.ts` with failing tests for config I/O and agent detection**

```ts
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createDefaultConfig,
  detectAgents,
  expandTargetAgents,
  loadConfig,
  saveConfig,
  validateConfig
} from '../src/config.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('config module', () => {
  test('detectAgents returns only known agent directories that exist', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    await mkdir(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    await mkdir(path.join(homeDir, '.qoder', 'skills'), { recursive: true });

    await expect(detectAgents(homeDir)).resolves.toEqual({
      claude: path.join(homeDir, '.claude', 'skills'),
      qoder: path.join(homeDir, '.qoder', 'skills')
    });
  });

  test('saveConfig and loadConfig round-trip a valid config file', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, {
      claude: path.join(homeDir, '.claude', 'skills')
    });
    config.links.welcome = ['*'];

    await saveConfig(config, homeDir);

    await expect(loadConfig(homeDir)).resolves.toEqual(config);
  });

  test('validateConfig rejects configs that omit required top-level keys', () => {
    expect(() => validateConfig({ version: 1, agents: {} })).toThrow('Invalid config: missing links');
  });

  test('expandTargetAgents expands wildcard links to all configured agents', () => {
    const config = createDefaultConfig('/tmp/demo-home', {
      claude: '/tmp/demo-home/.claude/skills',
      qoder: '/tmp/demo-home/.qoder/skills'
    });

    expect(expandTargetAgents(config, ['*'])).toEqual(['claude', 'qoder']);
    expect(expandTargetAgents(config, ['claude'])).toEqual(['claude']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because the functions do not exist yet**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL with missing exports such as `createDefaultConfig`, `detectAgents`, `loadConfig`, or `saveConfig`.

- [ ] **Step 3: Implement the config model and helpers in `src/config.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export type ConflictResolution = 'manual' | 'keep-local' | 'keep-remote';

export interface SyncSkillConfig {
  version: number;
  conflict_resolution: ConflictResolution;
  agents: Record<string, string>;
  links: Record<string, string[]>;
  servers: Record<string, unknown>;
  sources: Record<string, unknown>;
}

export interface SyncPaths {
  syncDir: string;
  configFile: string;
  skillsDir: string;
  manifestsDir: string;
  tempDir: string;
  historyFile: string;
}

const KNOWN_AGENT_DIRS: Record<string, string> = {
  claude: '.claude/skills',
  agents: '.agents/skills',
  hermes: '.hermes/skills',
  qwen: '.qwen/skills',
  qoder: '.qoder/skills',
  aone_copilot: '.aone_copilot/skills'
};

export function getSyncDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.syncskill');
}

export function getSyncPaths(homeDir: string = os.homedir()): SyncPaths {
  const syncDir = getSyncDir(homeDir);

  return {
    syncDir,
    configFile: path.join(syncDir, 'config.yaml'),
    skillsDir: path.join(syncDir, 'skills'),
    manifestsDir: path.join(syncDir, 'manifests'),
    tempDir: path.join(syncDir, '.tmp'),
    historyFile: path.join(syncDir, 'manifest_history.json')
  };
}

export function createDefaultConfig(
  homeDir: string = os.homedir(),
  agents: Record<string, string> = {}
): SyncSkillConfig {
  return {
    version: 1,
    conflict_resolution: 'manual',
    agents,
    links: {},
    servers: {},
    sources: {}
  };
}

export async function detectAgents(homeDir: string = os.homedir()): Promise<Record<string, string>> {
  const fs = await import('node:fs/promises');
  const found: Record<string, string> = {};

  for (const [name, relativeDir] of Object.entries(KNOWN_AGENT_DIRS)) {
    const fullPath = path.join(homeDir, relativeDir);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        found[name] = fullPath;
      }
    } catch {
      continue;
    }
  }

  return found;
}

export function validateConfig(value: unknown): SyncSkillConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid config: expected object');
  }

  const config = value as Record<string, unknown>;

  for (const key of ['version', 'agents', 'links']) {
    if (!(key in config)) {
      throw new Error(`Invalid config: missing ${key}`);
    }
  }

  return {
    version: Number(config.version),
    conflict_resolution: (config.conflict_resolution as ConflictResolution | undefined) ?? 'manual',
    agents: (config.agents as Record<string, string>) ?? {},
    links: (config.links as Record<string, string[]>) ?? {},
    servers: (config.servers as Record<string, unknown>) ?? {},
    sources: (config.sources as Record<string, unknown>) ?? {}
  };
}

export async function loadConfig(homeDir: string = os.homedir()): Promise<SyncSkillConfig> {
  const { configFile } = getSyncPaths(homeDir);
  const raw = await readFile(configFile, 'utf8');
  return validateConfig(YAML.parse(raw));
}

export async function saveConfig(config: SyncSkillConfig, homeDir: string = os.homedir()): Promise<void> {
  const { syncDir, configFile } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  await writeFile(configFile, YAML.stringify(config), 'utf8');
}

export function expandTargetAgents(config: SyncSkillConfig, targets: string[]): string[] {
  if (targets.includes('*')) {
    return Object.keys(config.agents).sort();
  }

  return [...new Set(targets)].sort();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit the config core**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config model and agent detection"
```

### Task 3: Wire `config show` and `config set`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Create: `tests/config-cli.test.ts`

- [ ] **Step 1: Write failing tests for `config show` and `config set`**

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDefaultConfig, saveConfig } from '../src/config.js';
import { createProgram } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('config CLI', () => {
  test('config show prints pretty JSON for the current config', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') });
    config.links.welcome = ['*'];
    await saveConfig(config, homeDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'config', 'show'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(config, null, 2));
  });

  test('config set updates a dotted path and parses JSON arrays', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await createProgram(homeDir).parseAsync(
      ['node', 'syncskill', 'config', 'set', 'links.welcome', '["claude","qoder"]'],
      { from: 'user' }
    );

    const raw = await readFile(path.join(homeDir, '.syncskill', 'config.yaml'), 'utf8');

    expect(raw).toContain('welcome:');
    expect(raw).toContain('- claude');
    expect(raw).toContain('- qoder');
  });
});
```

- [ ] **Step 2: Run the CLI tests to verify they fail**

Run: `npx vitest run tests/config-cli.test.ts`
Expected: FAIL because `createProgram` does not register `config show` or `config set`, and helper functions for dotted updates do not exist.

- [ ] **Step 3: Extend `src/config.ts` with dotted-path setters and value parsing**

```ts
export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return '';
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function setConfigValue(
  config: SyncSkillConfig,
  dottedPath: string,
  value: unknown
): SyncSkillConfig {
  const next = structuredClone(config) as Record<string, unknown>;
  const segments = dottedPath.split('.');
  let cursor: Record<string, unknown> = next;

  while (segments.length > 1) {
    const segment = segments.shift() as string;
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[0] as string] = value;
  return validateConfig(next);
}
```

- [ ] **Step 4: Register the `config show` and `config set` commands in `src/index.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, parseConfigValue, saveConfig, setConfigValue } from './config.js';

export function createProgram(homeDir?: string): Command {
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');

  const configCommand = program.command('config').description('Manage configuration');

  configCommand
    .command('show')
    .description('Print the current config as JSON')
    .action(async () => {
      const config = await loadConfig(homeDir);
      console.log(JSON.stringify(config, null, 2));
    });

  configCommand
    .command('set <key> <value>')
    .description('Set a single dotted-path config value')
    .action(async (key: string, value: string) => {
      const current = await loadConfig(homeDir);
      const next = setConfigValue(current, key, parseConfigValue(value));
      await saveConfig(next, homeDir);
    });

  return program;
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  await createProgram().parseAsync(process.argv);
}
```

- [ ] **Step 5: Run the tests to verify the CLI commands pass**

Run: `npx vitest run tests/config-cli.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 6: Commit the config CLI commands**

```bash
git add src/config.ts src/index.ts tests/config-cli.test.ts
git commit -m "feat: add config show and set commands"
```

### Task 4: Implement `init` and migration into `~/.syncskill/`

**Files:**
- Create: `src/repo.ts`
- Modify: `src/index.ts`
- Create: `tests/repo.test.ts`

- [ ] **Step 1: Write failing tests for repository initialization and skill migration**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initializeRepo } from '../src/repo.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('initializeRepo', () => {
  test('creates the syncskill directory structure and config file', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    await initializeRepo(homeDir, { skipSources: true });

    await expect(import('node:fs/promises').then((fs) => fs.stat(path.join(homeDir, '.syncskill', 'skills')))).resolves.toBeDefined();
    await expect(import('node:fs/promises').then((fs) => fs.stat(path.join(homeDir, '.syncskill', 'manifests')))).resolves.toBeDefined();
    await expect(import('node:fs/promises').then((fs) => fs.stat(path.join(homeDir, '.syncskill', '.tmp')))).resolves.toBeDefined();
    await expect(import('node:fs/promises').then((fs) => fs.stat(path.join(homeDir, '.syncskill', 'config.yaml')))).resolves.toBeDefined();
  });

  test('migrates existing skills with claude taking precedence over agents for name collisions', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    await mkdir(path.join(homeDir, '.claude', 'skills', 'welcome'), { recursive: true });
    await mkdir(path.join(homeDir, '.agents', 'skills', 'welcome'), { recursive: true });
    await mkdir(path.join(homeDir, '.agents', 'skills', 'ops'), { recursive: true });

    await writeFile(path.join(homeDir, '.claude', 'skills', 'welcome', 'SKILL.md'), 'claude version', 'utf8');
    await writeFile(path.join(homeDir, '.agents', 'skills', 'welcome', 'SKILL.md'), 'agents version', 'utf8');
    await writeFile(path.join(homeDir, '.agents', 'skills', 'ops', 'SKILL.md'), 'ops version', 'utf8');

    await initializeRepo(homeDir, { skipSources: false });

    await expect(readFile(path.join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'utf8')).resolves.toBe('claude version');
    await expect(readFile(path.join(homeDir, '.syncskill', 'skills', 'ops', 'SKILL.md'), 'utf8')).resolves.toBe('ops version');

    const rawConfig = await readFile(path.join(homeDir, '.syncskill', 'config.yaml'), 'utf8');
    expect(rawConfig).toContain('welcome:');
    expect(rawConfig).toContain('ops:');
    expect(rawConfig).toContain('- "*"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because `initializeRepo` is missing**

Run: `npx vitest run tests/repo.test.ts`
Expected: FAIL with a missing module or export for `initializeRepo`.

- [ ] **Step 3: Implement `src/repo.ts` with directory creation, config creation, and migration**

```ts
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, detectAgents, getSyncPaths, loadConfig, saveConfig } from './config.js';

export interface InitOptions {
  skipSources: boolean;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listSkillDirectories(root: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function initializeRepo(
  homeDir: string,
  options: InitOptions = { skipSources: false }
): Promise<void> {
  const paths = getSyncPaths(homeDir);

  await mkdir(paths.syncDir, { recursive: true });
  await mkdir(paths.skillsDir, { recursive: true });
  await mkdir(paths.manifestsDir, { recursive: true });
  await mkdir(paths.tempDir, { recursive: true });

  const detectedAgents = await detectAgents(homeDir);
  const config = (await exists(paths.configFile))
    ? await loadConfig(homeDir)
    : createDefaultConfig(homeDir, detectedAgents);

  const templatePath = fileURLToPath(new URL('../config.example.yaml', import.meta.url));
  const templateTarget = path.join(paths.syncDir, 'config.example.yaml');
  if (!(await exists(templateTarget))) {
    await writeFile(templateTarget, await readFile(templatePath, 'utf8'), 'utf8');
  }

  if (!options.skipSources) {
    for (const sourceRoot of [
      path.join(homeDir, '.claude', 'skills'),
      path.join(homeDir, '.agents', 'skills')
    ]) {
      for (const skillName of await listSkillDirectories(sourceRoot)) {
        const targetDir = path.join(paths.skillsDir, skillName);
        if (await exists(targetDir)) {
          continue;
        }

        await cp(path.join(sourceRoot, skillName), targetDir, { recursive: true });
        if (!config.links[skillName]) {
          config.links[skillName] = ['*'];
        }
      }
    }
  }

  for (const [agentName, agentPath] of Object.entries(detectedAgents)) {
    if (!config.agents[agentName]) {
      config.agents[agentName] = agentPath;
    }
  }

  await saveConfig(config, homeDir);
}
```

- [ ] **Step 4: Wire `init [--skip-sources]` in `src/index.ts`**

```ts
import { initializeRepo } from './repo.js';

program
  .command('init')
  .description('Create ~/.syncskill and bootstrap local config')
  .option('--skip-sources', 'Skip migrating skills from existing agent directories')
  .action(async (options: { skipSources?: boolean }) => {
    await initializeRepo(homeDir ?? process.env.HOME ?? '', {
      skipSources: Boolean(options.skipSources)
    });
  });
```

- [ ] **Step 5: Run the repo tests to verify they pass**

Run: `npx vitest run tests/repo.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 6: Commit the init implementation**

```bash
git add src/repo.ts src/index.ts tests/repo.test.ts
git commit -m "feat: add syncskill init and skill migration"
```

### Task 5: Implement `scan` to discover local skills and update `links`

**Files:**
- Modify: `src/linker.ts`
- Modify: `src/index.ts`
- Create: `tests/scan.test.ts`

- [ ] **Step 1: Write failing tests for scan behavior**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { scanSkills } from '../src/linker.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('scanSkills', () => {
  test('adds missing discovered skills with empty targets by default', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    const config = createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') });
    config.links.existing = ['claude'];
    await saveConfig(config, homeDir);

    await mkdir(path.join(homeDir, '.syncskill', 'skills', 'existing'), { recursive: true });
    await mkdir(path.join(homeDir, '.syncskill', 'skills', 'new-skill'), { recursive: true });
    await writeFile(path.join(homeDir, '.syncskill', 'skills', 'new-skill', 'SKILL.md'), 'hello', 'utf8');

    await scanSkills(homeDir, { allAgents: false });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        existing: ['claude'],
        'new-skill': []
      }
    });
  });

  test('adds wildcard targets when --all-agents is used', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') }), homeDir);
    await mkdir(path.join(homeDir, '.syncskill', 'skills', 'new-skill'), { recursive: true });

    await scanSkills(homeDir, { allAgents: true });

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      links: {
        'new-skill': ['*']
      }
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because `scanSkills` does not exist yet**

Run: `npx vitest run tests/scan.test.ts`
Expected: FAIL with a missing module or export for `scanSkills`.

- [ ] **Step 3: Create `src/linker.ts` with local-skill discovery and scan behavior**

```ts
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getSyncPaths, loadConfig, saveConfig } from './config.js';

export interface ScanOptions {
  allAgents: boolean;
}

export async function listLocalSkills(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);
  await mkdir(skillsDir, { recursive: true });
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function scanSkills(
  homeDir: string,
  options: ScanOptions = { allAgents: false }
): Promise<string[]> {
  const config = await loadConfig(homeDir);
  const discovered = await listLocalSkills(homeDir);
  const added: string[] = [];

  for (const skillName of discovered) {
    if (config.links[skillName]) {
      continue;
    }

    config.links[skillName] = options.allAgents ? ['*'] : [];
    added.push(skillName);
  }

  await saveConfig(config, homeDir);
  return added;
}
```

- [ ] **Step 4: Wire `scan [--all-agents]` in `src/index.ts`**

```ts
import { scanSkills } from './linker.js';

program
  .command('scan')
  .description('Scan local skills and add missing config.links entries')
  .option('--all-agents', 'Assign wildcard targets to newly discovered skills')
  .action(async (options: { allAgents?: boolean }) => {
    const added = await scanSkills(homeDir ?? process.env.HOME ?? '', {
      allAgents: Boolean(options.allAgents)
    });

    for (const skillName of added) {
      console.log(skillName);
    }
  });
```

- [ ] **Step 5: Run the tests to verify the scan behavior passes**

Run: `npx vitest run tests/scan.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 6: Commit the scan behavior**

```bash
git add src/linker.ts src/index.ts tests/scan.test.ts
git commit -m "feat: add local skill scanning"
```

### Task 6: Implement `link`, `unlink`, `--all`, and `--status`

**Files:**
- Modify: `src/linker.ts`
- Modify: `src/index.ts`
- Create: `tests/linker.test.ts`

- [ ] **Step 1: Write failing tests for linking, unlinking, status, and fallback copy behavior**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDefaultConfig, saveConfig } from '../src/config.js';
import { collectLinkStatus, linkConfiguredSkills, unlinkSkill } from '../src/linker.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('linkConfiguredSkills', () => {
  test('creates links for a configured skill in each target agent directory', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    const syncSkillDir = path.join(homeDir, '.syncskill', 'skills', 'welcome');
    await mkdir(syncSkillDir, { recursive: true });
    await writeFile(path.join(syncSkillDir, 'SKILL.md'), 'hello', 'utf8');
    await mkdir(path.join(homeDir, '.claude', 'skills'), { recursive: true });

    const config = createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') });
    config.links.welcome = ['claude'];
    await saveConfig(config, homeDir);

    await linkConfiguredSkills(homeDir, { all: false, skillName: 'welcome' });

    const linkedFile = path.join(homeDir, '.claude', 'skills', 'welcome', 'SKILL.md');
    await expect(readFile(linkedFile, 'utf8')).resolves.toBe('hello');
  });

  test('removes linked directories with unlinkSkill', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    await mkdir(path.join(homeDir, '.claude', 'skills', 'welcome'), { recursive: true });
    await writeFile(path.join(homeDir, '.claude', 'skills', 'welcome', 'SKILL.md'), 'hello', 'utf8');

    const config = createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') });
    config.links.welcome = ['claude'];
    await saveConfig(config, homeDir);

    await unlinkSkill(homeDir, 'welcome');

    const status = await collectLinkStatus(homeDir);
    expect(status).toEqual([
      { skill: 'welcome', agent: 'claude', state: 'missing' }
    ]);
  });

  test('falls back to copy when symlink creation fails twice', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    const syncSkillDir = path.join(homeDir, '.syncskill', 'skills', 'copied');
    await mkdir(syncSkillDir, { recursive: true });
    await writeFile(path.join(syncSkillDir, 'SKILL.md'), 'copy me', 'utf8');
    await mkdir(path.join(homeDir, '.claude', 'skills'), { recursive: true });

    const config = createDefaultConfig(homeDir, { claude: path.join(homeDir, '.claude', 'skills') });
    config.links.copied = ['claude'];
    await saveConfig(config, homeDir);

    const fsModule = await import('node:fs/promises');
    vi.spyOn(fsModule, 'symlink').mockRejectedValueOnce(new Error('symlink failed')).mockRejectedValueOnce(new Error('junction failed'));

    await linkConfiguredSkills(homeDir, { all: false, skillName: 'copied' });

    await expect(readFile(path.join(homeDir, '.claude', 'skills', 'copied', 'SKILL.md'), 'utf8')).resolves.toBe('copy me');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because the new linker functions are missing**

Run: `npx vitest run tests/linker.test.ts`
Expected: FAIL with missing exports such as `linkConfiguredSkills`, `unlinkSkill`, or `collectLinkStatus`.

- [ ] **Step 3: Extend `src/linker.ts` with link creation, unlinking, and status reporting**

```ts
import { cp, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { expandTargetAgents, getSyncPaths, loadConfig } from './config.js';

export interface LinkRequest {
  all: boolean;
  skillName?: string;
}

export interface LinkStatus {
  skill: string;
  agent: string;
  state: 'linked' | 'missing' | 'copied';
}

async function ensureLinkedDirectory(sourceDir: string, targetDir: string): Promise<'linked' | 'copied'> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });

  try {
    await symlink(sourceDir, targetDir);
    return 'linked';
  } catch {
    try {
      await symlink(sourceDir, targetDir, 'junction');
      return 'linked';
    } catch {
      await cp(sourceDir, targetDir, { recursive: true });
      return 'copied';
    }
  }
}

export async function linkConfiguredSkills(homeDir: string, request: LinkRequest): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const skillNames = request.all ? Object.keys(config.links).sort() : [request.skillName].filter(Boolean) as string[];
  const results: LinkStatus[] = [];

  for (const skillName of skillNames) {
    const sourceDir = path.join(skillsDir, skillName);
    const targetAgents = expandTargetAgents(config, config.links[skillName] ?? []);

    for (const agent of targetAgents) {
      const targetDir = path.join(config.agents[agent], skillName);
      const state = await ensureLinkedDirectory(sourceDir, targetDir);
      results.push({ skill: skillName, agent, state });
    }
  }

  return results;
}

export async function unlinkSkill(homeDir: string, skillName: string): Promise<void> {
  const config = await loadConfig(homeDir);
  const targetAgents = expandTargetAgents(config, config.links[skillName] ?? []);

  for (const agent of targetAgents) {
    await rm(path.join(config.agents[agent], skillName), { recursive: true, force: true });
  }
}

export async function collectLinkStatus(homeDir: string): Promise<LinkStatus[]> {
  const config = await loadConfig(homeDir);
  const statuses: LinkStatus[] = [];

  for (const skillName of Object.keys(config.links).sort()) {
    for (const agent of expandTargetAgents(config, config.links[skillName])) {
      const targetDir = path.join(config.agents[agent], skillName);
      try {
        const stats = await lstat(targetDir);
        if (stats.isSymbolicLink()) {
          await readlink(targetDir);
          statuses.push({ skill: skillName, agent, state: 'linked' });
        } else {
          statuses.push({ skill: skillName, agent, state: 'copied' });
        }
      } catch {
        statuses.push({ skill: skillName, agent, state: 'missing' });
      }
    }
  }

  return statuses;
}
```

- [ ] **Step 4: Wire the `link` command in `src/index.ts`**

```ts
import { collectLinkStatus, linkConfiguredSkills, unlinkSkill } from './linker.js';

program
  .command('link')
  .description('Create, inspect, or remove skill links')
  .argument('[skill]')
  .option('--all', 'Link every configured skill')
  .option('--status', 'Print the current link state')
  .option('--unlink <skill>', 'Remove links for one configured skill')
  .action(async (skill: string | undefined, options: { all?: boolean; status?: boolean; unlink?: string }) => {
    const resolvedHome = homeDir ?? process.env.HOME ?? '';

    if (options.status) {
      const statuses = await collectLinkStatus(resolvedHome);
      for (const item of statuses) {
        console.log(`${item.skill}\t${item.agent}\t${item.state}`);
      }
      return;
    }

    if (options.unlink) {
      await unlinkSkill(resolvedHome, options.unlink);
      return;
    }

    if (options.all) {
      await linkConfiguredSkills(resolvedHome, { all: true });
      return;
    }

    if (!skill) {
      throw new Error('link requires <skill>, --all, --status, or --unlink <skill>');
    }

    await linkConfiguredSkills(resolvedHome, { all: false, skillName: skill });
  });
```

- [ ] **Step 5: Run the linker tests to verify they pass**

Run: `npx vitest run tests/linker.test.ts`
Expected: PASS with 3 passing tests.

- [ ] **Step 6: Commit the linking behavior**

```bash
git add src/linker.ts src/index.ts tests/linker.test.ts
git commit -m "feat: add skill linking and status commands"
```

### Task 7: Add the interactive local `config` UI

**Files:**
- Create: `src/config-ui.ts`
- Modify: `src/index.ts`
- Create: `tests/config-ui.test.ts`

- [ ] **Step 1: Write failing tests for the local interactive config flows**

```ts
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createDefaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { runConfigUi, type PromptApi } from '../src/config-ui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

function createPromptStub(values: unknown[]): PromptApi {
  const queue = [...values];
  return {
    select: async () => queue.shift(),
    input: async () => queue.shift(),
    checkbox: async () => queue.shift(),
    confirm: async () => queue.shift()
  } as PromptApi;
}

describe('runConfigUi', () => {
  test('adds a local agent entry and saves the config', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await runConfigUi(
      homeDir,
      createPromptStub([
        'agents',
        'add',
        'claude',
        path.join(homeDir, '.claude', 'skills'),
        'back',
        true
      ])
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      agents: {
        claude: path.join(homeDir, '.claude', 'skills')
      }
    });
  });

  test('updates conflict resolution and writes it back to config', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'syncskill-home-'));
    tempDirs.push(homeDir);

    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await runConfigUi(
      homeDir,
      createPromptStub([
        'conflict_resolution',
        'keep-local',
        true
      ])
    );

    await expect(loadConfig(homeDir)).resolves.toMatchObject({
      conflict_resolution: 'keep-local'
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail because the UI module does not exist yet**

Run: `npx vitest run tests/config-ui.test.ts`
Expected: FAIL with a missing module or export for `runConfigUi`.

- [ ] **Step 3: Implement `src/config-ui.ts` with `agents`, `links`, and `conflict_resolution` flows**

```ts
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { loadConfig, saveConfig, type SyncSkillConfig } from './config.js';

export interface PromptApi {
  select<T>(config: { message: string; choices: { name: string; value: T }[] }): Promise<T>;
  input(config: { message: string; default?: string }): Promise<string>;
  checkbox<T>(config: { message: string; choices: { name: string; value: T; checked?: boolean }[] }): Promise<T[]>;
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
}

export function createPromptApi(): PromptApi {
  return {
    select,
    input,
    checkbox,
    confirm
  };
}

async function editAgents(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: 'Manage agents',
      choices: [
        { name: 'Add', value: 'add' },
        { name: 'Remove', value: 'remove' },
        { name: 'Back', value: 'back' }
      ]
    });

    if (action === 'back') {
      return;
    }

    if (action === 'add') {
      const name = await prompts.input({ message: 'Agent name' });
      const dir = await prompts.input({ message: 'Agent skills directory' });
      config.agents[name] = dir;
      continue;
    }

    const name = await prompts.select({
      message: 'Remove which agent?',
      choices: Object.keys(config.agents).sort().map((agent) => ({ name: agent, value: agent }))
    });
    delete config.agents[name];
  }
}

async function editLinks(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const action = await prompts.select({
      message: 'Manage links',
      choices: [
        { name: 'Add or edit', value: 'edit' },
        { name: 'Remove', value: 'remove' },
        { name: 'Back', value: 'back' }
      ]
    });

    if (action === 'back') {
      return;
    }

    if (action === 'edit') {
      const skill = await prompts.input({ message: 'Skill name' });
      const targets = await prompts.checkbox({
        message: 'Target agents',
        choices: [
          { name: '*', value: '*' },
          ...Object.keys(config.agents).sort().map((agent) => ({ name: agent, value: agent }))
        ]
      });
      config.links[skill] = targets;
      continue;
    }

    const skill = await prompts.select({
      message: 'Remove which skill mapping?',
      choices: Object.keys(config.links).sort().map((name) => ({ name, value: name }))
    });
    delete config.links[skill];
  }
}

async function editConflictResolution(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  config.conflict_resolution = await prompts.select({
    message: 'Conflict resolution',
    choices: [
      { name: 'manual', value: 'manual' },
      { name: 'keep-local', value: 'keep-local' },
      { name: 'keep-remote', value: 'keep-remote' }
    ]
  });
}

export async function runConfigUi(homeDir: string, prompts: PromptApi = createPromptApi()): Promise<void> {
  const config = await loadConfig(homeDir);

  while (true) {
    const section = await prompts.select({
      message: 'Configuration',
      choices: [
        { name: 'agents', value: 'agents' },
        { name: 'links', value: 'links' },
        { name: 'conflict_resolution', value: 'conflict_resolution' },
        { name: 'done', value: 'done' }
      ]
    });

    if (section === 'done') {
      break;
    }

    if (section === 'agents') {
      await editAgents(config, prompts);
      continue;
    }

    if (section === 'links') {
      await editLinks(config, prompts);
      continue;
    }

    await editConflictResolution(config, prompts);
  }

  const shouldSave = await prompts.confirm({ message: 'Save changes?', default: true });
  if (shouldSave) {
    await saveConfig(config, homeDir);
  }
}
```

- [ ] **Step 4: Route bare `config` to the interactive UI in `src/index.ts`**

```ts
import { runConfigUi } from './config-ui.js';

const configCommand = program.command('config').description('Manage configuration');

configCommand.action(async () => {
  await runConfigUi(homeDir ?? process.env.HOME ?? '');
});
```

- [ ] **Step 5: Run the config UI tests to verify they pass**

Run: `npx vitest run tests/config-ui.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 6: Commit the interactive local config UI**

```bash
git add src/config-ui.ts src/index.ts tests/config-ui.test.ts
git commit -m "feat: add interactive local config editor"
```

### Task 8: Run the full Milestone 1 suite and do one CLI smoke pass

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/config-cli.test.ts`

- [ ] **Step 1: Add one failing smoke test that exercises `init`, `scan`, and `link --status` through the commander entrypoint**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProgram } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))));
  tempDirs.length = 0;
});

describe('milestone 1 smoke flow', () => {
  test('init, scan, and link --status work together for one local skill', async () => {
    const homeDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'syncskill-home-')));
    tempDirs.push(homeDir);

    await mkdir(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'init', '--skip-sources'], { from: 'user' });

    await mkdir(path.join(homeDir, '.syncskill', 'skills', 'welcome'), { recursive: true });
    await writeFile(path.join(homeDir, '.syncskill', 'skills', 'welcome', 'SKILL.md'), 'hello', 'utf8');

    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'scan', '--all-agents'], { from: 'user' });
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--all'], { from: 'user' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram(homeDir).parseAsync(['node', 'syncskill', 'link', '--status'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith('welcome\tclaude\tlinked');
  });
});
```

- [ ] **Step 2: Run the smoke test to verify it fails before the last wiring adjustments**

Run: `npx vitest run tests/config-cli.test.ts -t "init, scan, and link --status work together for one local skill"`
Expected: FAIL because one of the commands is not fully wired together yet.

- [ ] **Step 3: Make the final commander wiring adjustments in `src/index.ts`**

```ts
export function createProgram(homeDir?: string): Command {
  const resolvedHome = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  const program = new Command()
    .name('syncskill')
    .description('Multi-device AI Agent Skill sync tool');

  program
    .command('init')
    .description('Create ~/.syncskill and bootstrap local config')
    .option('--skip-sources', 'Skip migrating skills from existing agent directories')
    .action(async (options: { skipSources?: boolean }) => {
      await initializeRepo(resolvedHome, { skipSources: Boolean(options.skipSources) });
    });

  program
    .command('scan')
    .description('Scan local skills and add missing config.links entries')
    .option('--all-agents', 'Assign wildcard targets to newly discovered skills')
    .action(async (options: { allAgents?: boolean }) => {
      await scanSkills(resolvedHome, { allAgents: Boolean(options.allAgents) });
    });

  program
    .command('link')
    .description('Create, inspect, or remove skill links')
    .argument('[skill]')
    .option('--all', 'Link every configured skill')
    .option('--status', 'Print the current link state')
    .option('--unlink <skill>', 'Remove links for one configured skill')
    .action(async (skill: string | undefined, options: { all?: boolean; status?: boolean; unlink?: string }) => {
      if (options.status) {
        for (const item of await collectLinkStatus(resolvedHome)) {
          console.log(`${item.skill}\t${item.agent}\t${item.state}`);
        }
        return;
      }

      if (options.unlink) {
        await unlinkSkill(resolvedHome, options.unlink);
        return;
      }

      await linkConfiguredSkills(resolvedHome, {
        all: Boolean(options.all),
        skillName: options.all ? undefined : skill
      });
    });

  return program;
}
```

- [ ] **Step 4: Run the full Milestone 1 suite**

Run: `npm test`
Expected: PASS with all tests green.

- [ ] **Step 5: Build the CLI and run one manual smoke command**

Run: `npm run build && node dist/index.js --help`
Expected: TypeScript compiles successfully and commander prints the top-level help text with `init`, `config`, `scan`, and `link`.

- [ ] **Step 6: Commit the completed Milestone 1 slice**

```bash
git add package.json package-lock.json tsconfig.json config.example.yaml src tests .gitignore
git commit -m "feat: deliver syncskill local foundation milestone"
```

## Self-Review

**Spec coverage:**
- `init`: covered in Task 4
- `config show` and `config set`: covered in Task 3
- interactive `config` for the local milestone: covered in Task 7
- `scan`: covered in Task 5
- `link`: covered in Task 6
- Milestone 1 integration verification: covered in Task 8

**Intentional deferrals to companion plans:**
- `status`, `diff`, `resolve`, `refresh`: next plan
- `source add/update/list`: source plan
- `push`, `pull`, `sync`, receiver deployment: remote sync plan
- interactive `config` menus for `servers` and `sources`: land with the plans that implement those domains

**Placeholder scan:**
- No `TODO`, `TBD`, or “similar to Task N” shortcuts remain.
- Every code-changing step includes concrete code or command content.

**Type consistency:**
- `SyncSkillConfig`, `getSyncPaths`, `initializeRepo`, `scanSkills`, `linkConfiguredSkills`, `unlinkSkill`, `collectLinkStatus`, and `runConfigUi` are named consistently across all tasks.
