# syncskill Ship Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing `syncskill` CLI into a documented, installable, and verifiable deliverable without adding commands or changing sync behavior.

**Architecture:** Keep this milestone focused on productization rather than feature work. Documentation files explain the current command surface and workflows, `package.json` and `src/index.ts` align runtime entrypoints and help text with those docs, and the test tree is split into `unit`, `integration`, and `end2end` tiers so the default gate stays lightweight.

**Tech Stack:** TypeScript, Node 20 ESM, commander, yaml, vitest, npm scripts, Markdown docs

---

## File Map

**Create:**
- `README.md` — top-level project overview, install/build instructions, quick start, command map, docs links
- `docs/config-guide.md` — config reference and minimal examples for agents, links, servers, sources, and conflict policy
- `docs/usage-guide.md` — first-run flow, local workflow, source workflow, reconciliation workflow, and remote sync workflow
- `docs/design-guide.md` — high-level architecture and module-boundary guide for maintainers
- `tests/unit/README.md` — short note for what belongs in unit tests and the default gate
- `tests/integration/README.md` — short note for integration-test scope and invocation
- `tests/end2end/README.md` — short note for end2end-test scope and invocation
- `tests/unit/config.test.ts` — moved unit test for config helpers
- `tests/unit/conflict.test.ts` — moved unit test for conflict resolution
- `tests/unit/linker.test.ts` — moved unit test for local linking logic
- `tests/unit/manifest.test.ts` — moved unit test for manifest helpers
- `tests/unit/refresh.test.ts` — moved unit test for refresh orchestration helpers
- `tests/unit/source.test.ts` — moved unit test for source materialization logic
- `tests/integration/config-cli.test.ts` — moved integration test for config CLI wiring
- `tests/integration/config-ui.test.ts` — moved integration test for config UI flow
- `tests/integration/reconciliation-cli.test.ts` — moved integration test for status/diff/resolve CLI wiring
- `tests/integration/repo.test.ts` — moved integration test for init/repo filesystem behavior
- `tests/integration/scan.test.ts` — moved integration test for scan command behavior
- `tests/integration/source-cli.test.ts` — moved integration test for source CLI wiring
- `tests/integration/sync-cli.test.ts` — moved integration test for sync CLI output and ordering
- `tests/integration/sync-engine.test.ts` — moved integration test for orchestration behavior
- `tests/integration/transport.test.ts` — moved integration test for receiver and transport boundaries
- `tests/end2end/smoke.test.ts` — build/run smoke test for the shipped CLI entrypoint

**Modify:**
- `package.json` — add explicit scripts for `test:unit`, `test:integration`, `test:end2end`, and make `test` point at the unit tier
- `src/index.ts` — tighten descriptions/help text so CLI help matches README and usage docs
- `config.example.yaml` — expand into a credible example config that docs can quote directly

**Do not modify in this milestone unless a failing ship-readiness check requires it:**
- `src/manifest.ts`
- `src/conflict.ts`
- `src/source.ts`
- `src/transport.ts`
- `src/sync_engine.ts`
- `src/receiver/*`

## Delivery Contract

This milestone does **not** add commands. It documents and packages the existing contract:

```text
init
config
config show
config set
link
scan
status
diff <server>
resolve <skill> --take local|remote
refresh [--local | --remote | --status] [server]
source add
source update
source list
push [--all | <server>]
pull <server>
sync [--all | <server>]
```

## Test Tier Contract

The repository must expose three explicit test tiers:

- `unit test` — default required pass gate
- `integration test` — separate, opt-in workflow validation
- `end2end test` — separate, high-confidence shipped-CLI validation

The default mandatory checks for implementation tasks in this milestone are:

- `npm run test`
- `npm run build`

At the end of the milestone, the broader non-default checks should also be runnable:

- `npm run test:integration`
- `npm run test:end2end`

### Task 1: Add the documentation set

**Files:**
- Create: `README.md`
- Create: `docs/config-guide.md`
- Create: `docs/usage-guide.md`
- Create: `docs/design-guide.md`

- [ ] **Step 1: Write the failing documentation smoke test**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = new URL('..', import.meta.url).pathname;

describe('ship-readiness docs', () => {
  it('top-level docs exist and link the expected entrypoints', async () => {
    const [readme, configGuide, usageGuide, designGuide] = await Promise.all([
      readFile(join(rootDir, 'README.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'config-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'usage-guide.md'), 'utf8'),
      readFile(join(rootDir, 'docs', 'design-guide.md'), 'utf8')
    ]);

    expect(readme).toContain('# syncskill');
    expect(readme).toContain('## Quick start');
    expect(readme).toContain('docs/config-guide.md');
    expect(readme).toContain('docs/usage-guide.md');
    expect(readme).toContain('docs/design-guide.md');

    expect(configGuide).toContain('# Configuration Guide');
    expect(configGuide).toContain('conflict_resolution');
    expect(configGuide).toContain('servers:');

    expect(usageGuide).toContain('# Usage Guide');
    expect(usageGuide).toContain('syncskill init');
    expect(usageGuide).toContain('syncskill sync --all');

    expect(designGuide).toContain('# Design Guide');
    expect(designGuide).toContain('src/index.ts');
    expect(designGuide).toContain('src/sync_engine.ts');
  });
});
```

- [ ] **Step 2: Run the failing documentation smoke test**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: FAIL because `README.md`, `docs/config-guide.md`, `docs/usage-guide.md`, and `docs/design-guide.md` do not exist yet.

- [ ] **Step 3: Add the minimal top-level README**

```md
# syncskill

`syncskill` manages AI Agent skills across local agent directories and remote servers.

## Install

```bash
npm install
npm run build
```

## Quick start

```bash
node dist/index.js init
node dist/index.js config show
node dist/index.js status
```

## Commands

- local setup: `init`, `config`, `link`, `scan`
- reconciliation: `status`, `diff`, `resolve`, `refresh`
- sources: `source add`, `source update`, `source list`
- remote sync: `push`, `pull`, `sync`

## Docs

- [Configuration Guide](docs/config-guide.md)
- [Usage Guide](docs/usage-guide.md)
- [Design Guide](docs/design-guide.md)
```

- [ ] **Step 4: Add the minimal configuration guide**

```md
# Configuration Guide

`syncskill` stores runtime data under `~/.syncskill/`.

## Example

```yaml
version: 1
conflict_resolution: manual
agents:
  claude: ~/.claude/skills
links:
  welcome:
    - claude
servers:
  alpha:
    host: alpha.example.com
    remote_agents:
      claude: ~/.claude/skills
sources:
  docs:
    type: git
    url: https://example.com/skills.git
    store: vendor/docs
```

## Fields

- `conflict_resolution`: `manual`, `keep-local`, or `keep-remote`
- `agents`: local agent skill directories
- `links`: local skill-to-agent mapping
- `servers`: remote sync targets
- `sources`: external materialized sources
```

- [ ] **Step 5: Add the minimal usage guide**

```md
# Usage Guide

## First run

```bash
syncskill init
syncskill config show
syncskill scan --all-agents
syncskill link --all
```

## Reconciliation workflow

```bash
syncskill status
syncskill diff alpha
syncskill resolve welcome --take local
```

## Remote sync workflow

```bash
syncskill push alpha
syncskill pull alpha
syncskill sync --all
```
```

- [ ] **Step 6: Add the minimal design guide**

```md
# Design Guide

## Module boundaries

- `src/index.ts` — CLI registration and help text
- `src/config.ts` — config loading, saving, and path helpers
- `src/repo.ts` — local repository initialization
- `src/manifest.ts` — manifest persistence and hashing helpers
- `src/conflict.ts` — reconciliation policy
- `src/source.ts` — external source materialization
- `src/transport.ts` — SSH/rsync transport primitives
- `src/sync_engine.ts` — push/pull/sync orchestration

## Sync model

Local state is stored under `~/.syncskill/`. Remote synchronization exchanges manifest state plus skill trees; transport and sync policy remain separate modules.
```

- [ ] **Step 7: Run the documentation smoke test to verify it passes**

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: PASS with all four documentation entrypoints present and containing the expected headings and command references.

- [ ] **Step 8: Commit the documentation set**

```bash
git add README.md docs/config-guide.md docs/usage-guide.md docs/design-guide.md tests/unit/docs.test.ts
git commit -m "docs: add ship readiness guides"
```

### Task 2: Introduce explicit test tiers and scripts

**Files:**
- Create: `tests/unit/README.md`
- Create: `tests/integration/README.md`
- Create: `tests/end2end/README.md`
- Create: `tests/end2end/smoke.test.ts`
- Create: `tests/unit/docs.test.ts`
- Create: `tests/unit/config.test.ts`
- Create: `tests/unit/conflict.test.ts`
- Create: `tests/unit/linker.test.ts`
- Create: `tests/unit/manifest.test.ts`
- Create: `tests/unit/refresh.test.ts`
- Create: `tests/unit/source.test.ts`
- Create: `tests/integration/config-cli.test.ts`
- Create: `tests/integration/config-ui.test.ts`
- Create: `tests/integration/reconciliation-cli.test.ts`
- Create: `tests/integration/repo.test.ts`
- Create: `tests/integration/scan.test.ts`
- Create: `tests/integration/source-cli.test.ts`
- Create: `tests/integration/sync-cli.test.ts`
- Create: `tests/integration/sync-engine.test.ts`
- Create: `tests/integration/transport.test.ts`
- Modify: `package.json`
- Modify: `tests/` existing paths by moving files into their new tier directories

- [ ] **Step 1: Write the failing script-and-layout test**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = new URL('..', import.meta.url).pathname;

describe('test tier layout', () => {
  it('package scripts and tier directories expose unit, integration, and end2end suites', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:unit']).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:integration']).toBe('vitest run tests/integration');
    expect(packageJson.scripts['test:end2end']).toBe('vitest run tests/end2end');

    await expect(readFile(join(rootDir, 'tests', 'unit', 'README.md'), 'utf8')).resolves.toContain('default required pass gate');
    await expect(readFile(join(rootDir, 'tests', 'integration', 'README.md'), 'utf8')).resolves.toContain('not part of the default mandatory pass gate');
    await expect(readFile(join(rootDir, 'tests', 'end2end', 'README.md'), 'utf8')).resolves.toContain('realistic user paths');
  });
});
```

- [ ] **Step 2: Run the failing script-and-layout test**

Run: `npx vitest run tests/unit/test-tiers.test.ts`
Expected: FAIL because the tier directories and scripts do not exist yet.

- [ ] **Step 3: Add explicit test-tier scripts**

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run tests/unit",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:end2end": "vitest run tests/end2end",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 4: Add the tier README files**

```md
# Unit Tests

Files in this directory are the default required pass gate. They should stay fast, isolated, and focused on module behavior.
```

```md
# Integration Tests

Files in this directory validate module collaboration and CLI wiring. They are not part of the default mandatory pass gate.
```

```md
# End2end Tests

Files in this directory validate realistic user paths through the shipped CLI. They are intentionally separate from the default mandatory pass gate.
```

- [ ] **Step 5: Move the existing tests into the new tier directories**

```text
tests/config.test.ts                -> tests/unit/config.test.ts
tests/conflict.test.ts              -> tests/unit/conflict.test.ts
tests/linker.test.ts                -> tests/unit/linker.test.ts
tests/manifest.test.ts              -> tests/unit/manifest.test.ts
tests/refresh.test.ts               -> tests/unit/refresh.test.ts
tests/source.test.ts                -> tests/unit/source.test.ts

tests/config-cli.test.ts            -> tests/integration/config-cli.test.ts
tests/config-ui.test.ts             -> tests/integration/config-ui.test.ts
tests/reconciliation-cli.test.ts    -> tests/integration/reconciliation-cli.test.ts
tests/repo.test.ts                  -> tests/integration/repo.test.ts
tests/scan.test.ts                  -> tests/integration/scan.test.ts
tests/source-cli.test.ts            -> tests/integration/source-cli.test.ts
tests/sync-cli.test.ts              -> tests/integration/sync-cli.test.ts
tests/sync-engine.test.ts           -> tests/integration/sync-engine.test.ts
tests/transport.test.ts             -> tests/integration/transport.test.ts
```

- [ ] **Step 6: Add the unit-tier docs and test-tier smoke tests**

```ts
// tests/unit/test-tiers.test.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = new URL('..', import.meta.url).pathname;

describe('test tier layout', () => {
  it('package scripts and tier directories expose unit, integration, and end2end suites', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:unit']).toBe('vitest run tests/unit');
    expect(packageJson.scripts['test:integration']).toBe('vitest run tests/integration');
    expect(packageJson.scripts['test:end2end']).toBe('vitest run tests/end2end');
  });
});
```

- [ ] **Step 7: Add the end2end smoke test**

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shipped cli smoke test', () => {
  it('prints top-level help from the built entrypoint', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-e2e-'));
    tempDirs.push(homeDir);

    const { stdout } = await execFileAsync('node', ['dist/index.js', '--help'], {
      cwd: join(new URL('..', import.meta.url).pathname),
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    expect(stdout).toContain('Usage: syncskill');
    expect(stdout).toContain('init');
    expect(stdout).toContain('sync');
  });
});
```

- [ ] **Step 8: Run the default gate and the separated suites**

Run: `npm run test`
Expected: PASS and only the `tests/unit` suite runs.

Run: `npm run test:integration`
Expected: PASS and only the `tests/integration` suite runs.

Run: `npm run test:end2end`
Expected: FAIL until the built-entrypoint and docs wiring task is completed.

- [ ] **Step 9: Commit the test-tier split**

```bash
git add package.json tests
git commit -m "test: split ship readiness test tiers"
```

### Task 3: Align packaging, example config, and CLI help text

**Files:**
- Modify: `package.json`
- Modify: `config.example.yaml`
- Modify: `src/index.ts`
- Test: `tests/unit/package.test.ts`
- Test: `tests/integration/help-output.test.ts`

- [ ] **Step 1: Write the failing package/help tests**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = new URL('..', import.meta.url).pathname;

describe('package metadata', () => {
  it('exposes a public-facing description, bin, and tiered scripts', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      private?: boolean;
      description?: string;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.description).toContain('Skill');
    expect(packageJson.bin?.syncskill).toBe('dist/index.js');
    expect(packageJson.scripts?.build).toBe('tsc -p tsconfig.build.json');
    expect(packageJson.scripts?.test).toBe('vitest run tests/unit');
  });
});
```

```ts
import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

describe('help output', () => {
  it('describes the shipped commands in install-facing language', () => {
    const help = createProgram('/tmp').helpInformation();

    expect(help).toContain('Multi-device AI Agent Skill sync tool');
    expect(help).toContain('init');
    expect(help).toContain('source');
    expect(help).toContain('push');
    expect(help).toContain('sync');
  });
});
```

- [ ] **Step 2: Run the failing package/help tests**

Run: `npx vitest run tests/unit/package.test.ts tests/integration/help-output.test.ts`
Expected: FAIL because package metadata and test paths do not yet match the ship-readiness contract.

- [ ] **Step 3: Update the example config**

```yaml
version: 1
conflict_resolution: manual
agents:
  claude: ~/.claude/skills
links:
  welcome:
    - claude
servers:
  alpha:
    host: alpha.example.com
    remote_agents:
      claude: ~/.claude/skills
sources:
  docs:
    type: git
    url: https://example.com/skills.git
    store: vendor/docs
```

- [ ] **Step 4: Update package metadata for local delivery**

```json
{
  "name": "syncskill",
  "version": "0.1.0",
  "description": "Multi-device AI Agent Skill sync tool",
  "type": "module",
  "bin": {
    "syncskill": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run tests/unit",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:end2end": "vitest run tests/end2end",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 5: Tighten the top-level command descriptions**

```ts
const program = new Command()
  .name('syncskill')
  .description('Multi-device AI Agent Skill sync tool')
  .option('--no-refresh', 'Skip automatic manifest refresh before commands');

program
  .command('init')
  .description('Initialize the local syncskill repository');

program
  .command('push [server]')
  .description('Push local skill changes to one server or all configured servers');

program
  .command('pull <server>')
  .description('Pull remote skill changes from one server');

program
  .command('sync [server]')
  .description('Pull then push changes for one server or all configured servers');
```

- [ ] **Step 6: Run the package/help tests to verify they pass**

Run: `npx vitest run tests/unit/package.test.ts tests/integration/help-output.test.ts`
Expected: PASS with package metadata, example config, and help text aligned.

- [ ] **Step 7: Commit the packaging and help-text alignment**

```bash
git add package.json config.example.yaml src/index.ts tests/unit/package.test.ts tests/integration/help-output.test.ts
git commit -m "docs: align ship readiness entrypoints"
```

### Task 4: Add shipped-CLI smoke coverage and milestone verification commands

**Files:**
- Modify: `README.md`
- Modify: `docs/usage-guide.md`
- Modify: `tests/end2end/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke-workflow assertion**

```ts
expect(stdout).toContain('Usage: syncskill');
expect(stdout).toContain('config');
expect(stdout).toContain('sync');
```

```md
## Verification

Default gate:

```bash
npm run test
npm run build
```

Additional checks:

```bash
npm run test:integration
npm run test:end2end
node dist/index.js --help
```
```

- [ ] **Step 2: Run the end2end smoke suite to verify the current failure or gap**

Run: `npm run test:end2end`
Expected: FAIL until the docs and built-entrypoint workflow text are aligned with the shipped binary path.

- [ ] **Step 3: Add the verification sections to README and usage docs**

```md
## Verification

Default required gate:

```bash
npm run test
npm run build
```

Additional suites:

```bash
npm run test:integration
npm run test:end2end
```

Built CLI sanity:

```bash
node dist/index.js --help
```
```

- [ ] **Step 4: Finalize the smoke test around the built entrypoint**

```ts
expect(stdout).toContain('Usage: syncskill');
expect(stdout).toContain('init');
expect(stdout).toContain('sync');
```

- [ ] **Step 5: Run the milestone verification set**

Run: `npm run test`
Expected: PASS for the default unit gate.

Run: `npm run build`
Expected: PASS and `dist/index.js` is emitted.

Run: `npm run test:integration`
Expected: PASS for the integration tier.

Run: `npm run test:end2end`
Expected: PASS for the shipped CLI smoke path.

Run: `node dist/index.js --help`
Expected: PASS with the documented command list visible.

- [ ] **Step 6: Commit the ship-readiness verification path**

```bash
git add README.md docs/usage-guide.md tests/end2end/smoke.test.ts
git commit -m "test: add ship readiness smoke checks"
```

## Self-Review

- Spec coverage check: Task 1 covers the documentation deliverables; Task 2 covers explicit unit/integration/end2end tiering and default gate changes; Task 3 covers packaging, example config, and help text alignment; Task 4 covers the shipped-CLI verification path and milestone-level validation commands.
- Placeholder scan: no unfinished placeholder steps remain; each task includes concrete file paths, code snippets, commands, and expected outcomes.
- Type consistency check: the plan consistently uses `tests/unit`, `tests/integration`, and `tests/end2end` directories, and the script names remain `test`, `test:unit`, `test:integration`, and `test:end2end` throughout.
