# Config UI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the config UI with matrix editor, direct CLI entry commands, server management, remote skill mapping, Esc navigation, and git branch auto-detection.

**Architecture:** Add a reusable matrix editor component using `@inquirer/core` createPrompt. Wrap all select prompts with Esc handling via `ExitPromptError`. Add three direct CLI entry points (`config link/server/remote`) that bypass the main menu. Enhance source.ts with git branch auto-detection before cloning.

**Tech Stack:** TypeScript, `@inquirer/core` (createPrompt, useKeypress, useState), `@inquirer/prompts`, commander

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/matrix-editor.ts` (create) | Reusable 2D grid editor component using `@inquirer/core` |
| `src/config-ui.ts` (modify) | Add safeSelect, editServers, editRemote, update editLinks to use matrix, update menu |
| `src/index.ts` (modify) | Add `config link`, `config server`, `config remote` CLI subcommands |
| `src/source.ts` (modify) | Add git branch auto-detection via `git ls-remote --symref` |
| `tests/unit/matrix-editor.test.ts` (create) | Unit tests for matrix editor |
| `tests/integration/config-ui.test.ts` (modify) | Integration tests for new UI features |

---

### Task 1: Git Branch Auto-Detection

**Files:**
- Modify: `src/source.ts`
- Test: `tests/unit/source.test.ts`

- [ ] **Step 1: Write failing test for branch detection**

```typescript
// tests/unit/source.test.ts - add to existing file
describe('detectGitDefaultBranch', () => {
  it('detects main branch from ls-remote output', async () => {
    const result = await detectGitDefaultBranch('https://github.com/example/repo.git');
    expect(result).toBe('main');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/source.test.ts -t "detectGitDefaultBranch"`
Expected: FAIL with "detectGitDefaultBranch is not defined"

- [ ] **Step 3: Implement detectGitDefaultBranch**

```typescript
// src/source.ts - add export
export async function detectGitDefaultBranch(url: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', url, 'HEAD']);
  const match = stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  return match?.[1] ?? 'main';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/source.test.ts -t "detectGitDefaultBranch"`
Expected: PASS

- [ ] **Step 5: Update materializeGitSource to use auto-detection**

```typescript
// src/source.ts - modify materializeGitSource
async function materializeGitSource(source: SourceDefinition, targetPath: string): Promise<void> {
  const branch = source.ref ?? await detectGitDefaultBranch(source.url);
  await execFileAsync('git', ['clone', '--single-branch', '--depth', '1', '--branch', branch, source.url, targetPath]);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/source.ts tests/unit/source.test.ts
git commit -m "feat(source): auto-detect git default branch via ls-remote"
```

---

### Task 2: Matrix Editor Component

**Files:**
- Create: `src/matrix-editor.ts`
- Create: `tests/unit/matrix-editor.test.ts`

- [ ] **Step 1: Write failing test for matrix editor types**

```typescript
// tests/unit/matrix-editor.test.ts
import { describe, it, expect } from 'vitest';
import type { MatrixEditorConfig, MatrixEditorResult } from '../src/matrix-editor.js';

describe('MatrixEditor types', () => {
  it('defines MatrixEditorConfig interface', () => {
    const config: MatrixEditorConfig = {
      title: 'Test Matrix',
      rows: ['skill-a', 'skill-b'],
      columns: ['claude', 'hermes'],
      selected: { 'skill-a': ['claude'] }
    };
    expect(config.rows).toHaveLength(2);
  });

  it('defines MatrixEditorResult interface', () => {
    const result: MatrixEditorResult = {
      cancelled: false,
      selected: { 'skill-a': ['claude', 'hermes'] }
    };
    expect(result.cancelled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/matrix-editor.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create matrix-editor.ts with types**

```typescript
// src/matrix-editor.ts
export interface MatrixEditorConfig {
  title: string;
  rows: string[];
  columns: string[];
  selected: Record<string, string[]>;
  pageSize?: number;
}

export interface MatrixEditorResult {
  cancelled: boolean;
  selected: Record<string, string[]>;
}
```

- [ ] **Step 4: Run test to verify types pass**

Run: `npm test -- tests/unit/matrix-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for renderMatrixLine helper**

```typescript
// tests/unit/matrix-editor.test.ts - add test
import { renderMatrixLine } from '../src/matrix-editor.js';

describe('renderMatrixLine', () => {
  it('renders row with checkmarks for selected columns', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], false, 0, 10);
    expect(line).toContain('skill-a');
    expect(line).toContain('[✓]');
    expect(line).toContain('[ ]');
  });

  it('highlights active cell when row is active', () => {
    const line = renderMatrixLine('skill-a', ['claude', 'hermes'], ['claude'], true, 1, 10);
    expect(line).toContain('[ ✓ ]').toBe(false);
    expect(line).toMatch(/\[.+\]/);
  });
});
```

- [ ] **Step 6: Implement renderMatrixLine**

```typescript
// src/matrix-editor.ts - add function
export function renderMatrixLine(
  rowName: string,
  columns: string[],
  selectedColumns: string[],
  isActiveRow: boolean,
  activeCol: number,
  rowNameWidth: number
): string {
  const paddedName = rowName.padEnd(rowNameWidth);
  const prefix = isActiveRow ? '→ ' : '  ';

  const cells = columns.map((col, idx) => {
    const isSelected = selectedColumns.includes(col);
    const isActive = isActiveRow && idx === activeCol;
    const check = isSelected ? '✓' : ' ';

    if (isActive) {
      return `[ ${check} ]`;
    }
    return isSelected ? '[✓]' : '[ ]';
  });

  return `${prefix}${paddedName}  ${cells.join('  ')}`;
}
```

- [ ] **Step 7: Run test to verify renderMatrixLine passes**

Run: `npm test -- tests/unit/matrix-editor.test.ts -t "renderMatrixLine"`
Expected: PASS

- [ ] **Step 8: Write test for createMatrixEditor**

```typescript
// tests/unit/matrix-editor.test.ts - add test
import { createMatrixEditor } from '../src/matrix-editor.js';

describe('createMatrixEditor', () => {
  it('returns a function that can be called as a prompt', () => {
    const editor = createMatrixEditor();
    expect(typeof editor).toBe('function');
  });
});
```

- [ ] **Step 9: Implement createMatrixEditor using @inquirer/core**

```typescript
// src/matrix-editor.ts - add imports and function
import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';

export const createMatrixEditor = () =>
  createPrompt<MatrixEditorResult, MatrixEditorConfig>((config, done) => {
    const { title, rows, columns, selected: initialSelected, pageSize = 25 } = config;
    const [cursorRow, setCursorRow] = useState(0);
    const [cursorCol, setCursorCol] = useState(0);
    const [currentPage, setCurrentPage] = useState(0);
    const [selected, setSelected] = useState<Record<string, string[]>>({ ...initialSelected });

    const totalPages = Math.ceil(rows.length / pageSize);
    const pageStart = currentPage * pageSize;
    const pageEnd = Math.min(pageStart + pageSize, rows.length);
    const pageRows = rows.slice(pageStart, pageEnd);

    useKeypress((key) => {
      if (key.name === 'escape') {
        done({ cancelled: true, selected: initialSelected });
        return;
      }

      if (isEnterKey(key)) {
        done({ cancelled: false, selected });
        return;
      }

      if (key.name === 'up') {
        setCursorRow(Math.max(0, cursorRow - 1));
      } else if (key.name === 'down') {
        setCursorRow(Math.min(pageRows.length - 1, cursorRow + 1));
      } else if (key.name === 'left') {
        setCursorCol(Math.max(0, cursorCol - 1));
      } else if (key.name === 'right') {
        setCursorCol(Math.min(columns.length - 1, cursorCol + 1));
      } else if (key.name === 'space' || key.name === 'tab') {
        const rowName = pageRows[cursorRow];
        const colName = columns[cursorCol];
        const current = selected[rowName] ?? [];
        const updated = current.includes(colName)
          ? current.filter((c) => c !== colName)
          : [...current, colName];
        setSelected({ ...selected, [rowName]: updated });

        if (key.name === 'tab') {
          setCursorCol((cursorCol + 1) % columns.length);
        }
      } else if (key.name === 'a') {
        const rowName = pageRows[cursorRow];
        const current = selected[rowName] ?? [];
        const allSelected = columns.every((c) => current.includes(c));
        setSelected({ ...selected, [rowName]: allSelected ? [] : [...columns] });
      } else if (key.name === 'pagedown' || key.name === 'n') {
        if (currentPage < totalPages - 1) {
          setCurrentPage(currentPage + 1);
          setCursorRow(0);
        }
      } else if (key.name === 'pageup' || key.name === 'p') {
        if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
          setCursorRow(0);
        }
      }
    });

    const rowNameWidth = Math.max(...rows.map((r) => r.length), 10);
    const headerPadding = ''.padEnd(rowNameWidth + 4);
    const header = `${headerPadding}${columns.join('  '.padEnd(6))}`;
    const separator = '─'.repeat(header.length);

    const pageInfo = totalPages > 1 ? `  Page ${currentPage + 1}/${totalPages}` : '';
    const titleLine = chalk.bold(`${title}${pageInfo}`) + '  ↑↓←→ navigate  Space: toggle  Tab: next  a: toggle row  Enter: save  Esc: back';

    const lines = pageRows.map((rowName, idx) => {
      const rowSelected = selected[rowName] ?? [];
      return renderMatrixLine(rowName, columns, rowSelected, idx === cursorRow, cursorCol, rowNameWidth);
    });

    return `${titleLine}\n\n${header}\n${separator}\n${lines.join('\n')}`;
  });
```

- [ ] **Step 10: Run all matrix editor tests**

Run: `npm test -- tests/unit/matrix-editor.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/matrix-editor.ts tests/unit/matrix-editor.test.ts
git commit -m "feat(config-ui): add matrix editor component"
```

---

### Task 3: Safe Select Wrapper with Esc Handling

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/config-ui.test.ts`

- [ ] **Step 1: Write failing test for safeSelect**

```typescript
// tests/integration/config-ui.test.ts - add test
describe('safeSelect', () => {
  it('returns selected value on normal selection', async () => {
    const prompts = createTestPromptApi(['agents']);
    const result = await safeSelect(prompts, {
      message: 'Choose',
      choices: [{ name: 'agents', value: 'agents' }]
    });
    expect(result).toEqual({ escaped: false, value: 'agents' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-ui.test.ts -t "safeSelect"`
Expected: FAIL with "safeSelect is not defined"

- [ ] **Step 3: Implement safeSelect**

```typescript
// src/config-ui.ts - add type and function
import { ExitPromptError } from '@inquirer/core';

export interface SafeSelectResult<T> {
  escaped: boolean;
  value?: T;
}

export async function safeSelect<T>(
  prompts: PromptApi,
  options: { message: string; choices: Array<{ name: string; value: T }> }
): Promise<SafeSelectResult<T>> {
  try {
    const value = await prompts.select(options);
    return { escaped: false, value };
  } catch (error) {
    if (error instanceof ExitPromptError) {
      return { escaped: true };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/config-ui.test.ts -t "safeSelect"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-ui.ts tests/integration/config-ui.test.ts
git commit -m "feat(config-ui): add safeSelect with Esc handling"
```

---

### Task 4: Update editLinks to Use Matrix Editor

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/config-ui.test.ts`

- [ ] **Step 1: Write test for matrix-based editLinks**

```typescript
// tests/integration/config-ui.test.ts - add test
describe('editLinks with matrix', () => {
  it('updates config.links from matrix selection', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills', hermes: '~/.hermes/skills' },
      links: { 'skill-a': ['claude'] },
      servers: {},
      sources: {}
    };
    
    // Mock matrix editor to select skill-a -> both agents
    const matrixResult = { cancelled: false, selected: { 'skill-a': ['claude', 'hermes'] } };
    
    await editLinksWithMatrix(config, matrixResult);
    
    expect(config.links['skill-a']).toEqual(['claude', 'hermes']);
  });

  it('saves wildcard when all agents selected', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills', hermes: '~/.hermes/skills' },
      links: {},
      servers: {},
      sources: {}
    };
    
    const matrixResult = { cancelled: false, selected: { 'skill-a': ['claude', 'hermes'] } };
    
    await editLinksWithMatrix(config, matrixResult);
    
    expect(config.links['skill-a']).toEqual(['*']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editLinks with matrix"`
Expected: FAIL

- [ ] **Step 3: Implement editLinksWithMatrix**

```typescript
// src/config-ui.ts - add function
import { createMatrixEditor, type MatrixEditorResult } from './matrix-editor.js';
import { listLocalSkillNames } from './linker.js';

export function applyMatrixToLinks(
  config: SyncSkillConfig,
  result: MatrixEditorResult
): void {
  if (result.cancelled) {
    return;
  }

  const allAgents = Object.keys(config.agents).sort();

  for (const [skill, agents] of Object.entries(result.selected)) {
    if (agents.length === 0) {
      delete config.links[skill];
    } else if (agents.length === allAgents.length && allAgents.every((a) => agents.includes(a))) {
      config.links[skill] = ['*'];
    } else {
      config.links[skill] = agents.sort();
    }
  }
}

export async function editLinksMatrix(
  config: SyncSkillConfig,
  homeDir: string
): Promise<MatrixEditorResult> {
  const skills = await listLocalSkillNames(homeDir);
  const agents = Object.keys(config.agents).sort();

  const selected: Record<string, string[]> = {};
  for (const skill of skills) {
    const targets = config.links[skill] ?? [];
    selected[skill] = targets.includes('*') ? [...agents] : targets.filter((t) => agents.includes(t));
  }

  const matrixEditor = createMatrixEditor();
  return matrixEditor({
    title: 'Skills → Agent Assignment',
    rows: skills,
    columns: agents,
    selected
  });
}
```

- [ ] **Step 4: Update editLinks to use matrix editor**

```typescript
// src/config-ui.ts - replace editLinks function
export async function editLinks(
  config: SyncSkillConfig,
  homeDir: string
): Promise<void> {
  const result = await editLinksMatrix(config, homeDir);
  applyMatrixToLinks(config, result);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editLinks with matrix"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config-ui.ts tests/integration/config-ui.test.ts
git commit -m "feat(config-ui): update editLinks to use matrix editor with wildcard optimization"
```

---

### Task 5: Add editServers Function

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/config-ui.test.ts`

- [ ] **Step 1: Write test for editServers**

```typescript
// tests/integration/config-ui.test.ts - add test
describe('editServers', () => {
  it('adds a new server to config', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: {},
      links: {},
      servers: {},
      sources: {}
    };

    const prompts = createTestPromptApi([
      'add',           // action
      'myserver',      // name
      'example.com',   // host
      'root',          // user
      '22',            // port
      '',              // identity_file (empty)
      'back'           // exit
    ]);

    await editServers(config, prompts);

    expect(config.servers['myserver']).toEqual({
      host: 'example.com',
      user: 'root',
      port: 22,
      remote_agents: {}
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editServers"`
Expected: FAIL with "editServers is not defined"

- [ ] **Step 3: Implement editServers**

```typescript
// src/config-ui.ts - add function
export async function editServers(config: SyncSkillConfig, prompts: PromptApi): Promise<void> {
  while (true) {
    const serverNames = Object.keys(config.servers).sort();
    const choices = [
      { name: '+ Add server', value: 'add' as const },
      ...serverNames.map((name) => ({ name, value: name })),
      { name: '← Back', value: 'back' as const }
    ];

    const result = await safeSelect(prompts, { message: 'Manage servers', choices });

    if (result.escaped || result.value === 'back') {
      return;
    }

    if (result.value === 'add') {
      const name = await prompts.input({ message: 'Server name' });
      const host = await prompts.input({ message: 'Host' });
      const user = await prompts.input({ message: 'User', default: 'root' });
      const portStr = await prompts.input({ message: 'Port', default: '22' });
      const identityFile = await prompts.input({ message: 'Identity file (optional)' });

      const server: Record<string, unknown> = {
        host,
        user,
        port: parseInt(portStr, 10),
        remote_agents: {}
      };

      if (identityFile) {
        server.identity_file = identityFile;
      }

      config.servers[name] = server;
      continue;
    }

    await editSingleServer(config, result.value, prompts);
  }
}

async function editSingleServer(
  config: SyncSkillConfig,
  serverName: string,
  prompts: PromptApi
): Promise<void> {
  while (true) {
    const result = await safeSelect(prompts, {
      message: `Edit server: ${serverName}`,
      choices: [
        { name: 'Edit connection', value: 'edit' as const },
        { name: 'Configure remote agents', value: 'agents' as const },
        { name: 'Remove server', value: 'remove' as const },
        { name: '← Back', value: 'back' as const }
      ]
    });

    if (result.escaped || result.value === 'back') {
      return;
    }

    const server = config.servers[serverName] as Record<string, unknown>;

    if (result.value === 'remove') {
      const confirmed = await prompts.confirm({ message: `Remove ${serverName}?`, default: false });
      if (confirmed) {
        delete config.servers[serverName];
        return;
      }
      continue;
    }

    if (result.value === 'edit') {
      server.host = await prompts.input({ message: 'Host', default: server.host as string });
      server.user = await prompts.input({ message: 'User', default: (server.user as string) ?? 'root' });
      const portStr = await prompts.input({ message: 'Port', default: String(server.port ?? 22) });
      server.port = parseInt(portStr, 10);
      const identityFile = await prompts.input({
        message: 'Identity file',
        default: (server.identity_file as string) ?? ''
      });
      if (identityFile) {
        server.identity_file = identityFile;
      } else {
        delete server.identity_file;
      }
      continue;
    }

    if (result.value === 'agents') {
      await editRemoteAgents(server, prompts);
    }
  }
}

async function editRemoteAgents(
  server: Record<string, unknown>,
  prompts: PromptApi
): Promise<void> {
  const remoteAgents = (server.remote_agents as Record<string, string>) ?? {};
  server.remote_agents = remoteAgents;

  while (true) {
    const agentNames = Object.keys(remoteAgents).sort();
    const choices = [
      { name: '+ Add agent', value: 'add' as const },
      ...agentNames.map((name) => ({ name: `${name}: ${remoteAgents[name]}`, value: name })),
      { name: '← Back', value: 'back' as const }
    ];

    const result = await safeSelect(prompts, { message: 'Remote agents', choices });

    if (result.escaped || result.value === 'back') {
      return;
    }

    if (result.value === 'add') {
      const name = await prompts.input({ message: 'Agent name' });
      const path = await prompts.input({ message: 'Agent directory' });
      remoteAgents[name] = path;
      continue;
    }

    const agentToEdit = result.value;
    const editResult = await safeSelect(prompts, {
      message: `Edit agent: ${agentToEdit}`,
      choices: [
        { name: 'Edit path', value: 'edit' as const },
        { name: 'Remove', value: 'remove' as const },
        { name: '← Back', value: 'back' as const }
      ]
    });

    if (editResult.escaped || editResult.value === 'back') {
      continue;
    }

    if (editResult.value === 'remove') {
      delete remoteAgents[agentToEdit];
    } else if (editResult.value === 'edit') {
      remoteAgents[agentToEdit] = await prompts.input({
        message: 'Agent directory',
        default: remoteAgents[agentToEdit]
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editServers"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-ui.ts tests/integration/config-ui.test.ts
git commit -m "feat(config-ui): add editServers with remote agents configuration"
```

---

### Task 6: Add editRemote Function (Skills × Servers Matrix)

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/config-ui.test.ts`

- [ ] **Step 1: Write test for editRemote**

```typescript
// tests/integration/config-ui.test.ts - add test
describe('editRemote', () => {
  it('updates server skills.include from matrix selection', async () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '~/.claude/skills' },
      links: { 'skill-a': ['*'], 'skill-b': ['*'] },
      servers: {
        server1: { host: 'a.com', remote_agents: {} },
        server2: { host: 'b.com', remote_agents: {} }
      },
      sources: {}
    };

    const matrixResult = {
      cancelled: false,
      selected: { 'skill-a': ['server1', 'server2'], 'skill-b': ['server1'] }
    };

    applyMatrixToRemote(config, matrixResult);

    expect((config.servers.server1 as Record<string, unknown>).skills).toEqual({ include: ['skill-a', 'skill-b'] });
    expect((config.servers.server2 as Record<string, unknown>).skills).toEqual({ include: ['skill-a'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editRemote"`
Expected: FAIL

- [ ] **Step 3: Implement applyMatrixToRemote and editRemoteMatrix**

```typescript
// src/config-ui.ts - add functions
export function applyMatrixToRemote(
  config: SyncSkillConfig,
  result: MatrixEditorResult
): void {
  if (result.cancelled) {
    return;
  }

  const serverSkills: Record<string, string[]> = {};

  for (const [skill, servers] of Object.entries(result.selected)) {
    for (const server of servers) {
      if (!serverSkills[server]) {
        serverSkills[server] = [];
      }
      serverSkills[server].push(skill);
    }
  }

  for (const serverName of Object.keys(config.servers)) {
    const server = config.servers[serverName] as Record<string, unknown>;
    const skills = serverSkills[serverName]?.sort() ?? [];

    if (skills.length > 0) {
      server.skills = { include: skills };
    } else {
      delete server.skills;
    }
  }
}

export async function editRemoteMatrix(
  config: SyncSkillConfig,
  homeDir: string
): Promise<MatrixEditorResult> {
  const skills = await listLocalSkillNames(homeDir);
  const servers = Object.keys(config.servers).sort();

  const selected: Record<string, string[]> = {};

  for (const skill of skills) {
    selected[skill] = [];
    for (const serverName of servers) {
      const server = config.servers[serverName] as Record<string, unknown>;
      const serverSkills = server.skills as { include?: string[] } | undefined;
      if (serverSkills?.include?.includes(skill)) {
        selected[skill].push(serverName);
      }
    }
  }

  const matrixEditor = createMatrixEditor();
  return matrixEditor({
    title: 'Skills → Server Sync Mapping',
    rows: skills,
    columns: servers,
    selected
  });
}

export async function editRemote(config: SyncSkillConfig, homeDir: string): Promise<void> {
  const servers = Object.keys(config.servers);

  if (servers.length === 0) {
    console.log('No servers configured. Add servers first with "config server".');
    return;
  }

  const result = await editRemoteMatrix(config, homeDir);
  applyMatrixToRemote(config, result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/config-ui.test.ts -t "editRemote"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-ui.ts tests/integration/config-ui.test.ts
git commit -m "feat(config-ui): add editRemote for skills × servers matrix"
```

---

### Task 7: Update Main Config Menu

**Files:**
- Modify: `src/config-ui.ts`
- Test: `tests/integration/config-ui.test.ts`

- [ ] **Step 1: Write test for updated menu**

```typescript
// tests/integration/config-ui.test.ts - add test
describe('runConfigUi menu', () => {
  it('includes servers and remote options', async () => {
    const prompts = createTestPromptApi(['done']);
    const menuChoices: string[] = [];
    
    const originalSelect = prompts.select;
    prompts.select = async (options) => {
      if (options.message === 'Choose a config section') {
        menuChoices.push(...options.choices.map(c => c.name));
      }
      return originalSelect(options);
    };

    await runConfigUi(homeDir, prompts);

    expect(menuChoices).toContain('servers');
    expect(menuChoices).toContain('remote');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-ui.test.ts -t "runConfigUi menu"`
Expected: FAIL (servers and remote not in menu)

- [ ] **Step 3: Update runConfigUi with new menu options**

```typescript
// src/config-ui.ts - update runConfigUi function
export async function runConfigUi(
  homeDir: string,
  prompts: PromptApi = createPromptApi(),
  options: { directEntry?: 'link' | 'server' | 'remote' } = {}
): Promise<void> {
  const config = await loadConfig(homeDir);

  if (options.directEntry === 'link') {
    await editLinks(config, homeDir);
    await saveConfig(config, homeDir);
    return;
  }

  if (options.directEntry === 'server') {
    await editServers(config, prompts);
    await saveConfig(config, homeDir);
    return;
  }

  if (options.directEntry === 'remote') {
    await editRemote(config, homeDir);
    await saveConfig(config, homeDir);
    return;
  }

  while (true) {
    const result = await safeSelect(prompts, {
      message: 'Choose a config section',
      choices: [
        { name: 'agents', value: 'agents' as const },
        { name: 'links', value: 'links' as const },
        { name: 'servers', value: 'servers' as const },
        { name: 'sources', value: 'sources' as const },
        { name: 'remote', value: 'remote' as const },
        { name: 'conflict_resolution', value: 'conflict_resolution' as const },
        { name: 'done', value: 'done' as const }
      ]
    });

    if (result.escaped || result.value === 'done') {
      break;
    }

    if (result.value === 'agents') {
      await editAgents(config, prompts);
      continue;
    }

    if (result.value === 'links') {
      await editLinks(config, homeDir);
      continue;
    }

    if (result.value === 'servers') {
      await editServers(config, prompts);
      continue;
    }

    if (result.value === 'remote') {
      await editRemote(config, homeDir);
      continue;
    }

    if (result.value === 'conflict_resolution') {
      await editConflictResolution(config, prompts);
    }
  }

  const shouldSave = await prompts.confirm({ message: 'Save changes?', default: true });
  if (shouldSave) {
    await saveConfig(config, homeDir);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/config-ui.test.ts -t "runConfigUi menu"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-ui.ts tests/integration/config-ui.test.ts
git commit -m "feat(config-ui): add servers and remote to main menu"
```

---

### Task 8: Add CLI Direct Entry Commands

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration/config-cli.test.ts`

- [ ] **Step 1: Write test for config link command**

```typescript
// tests/integration/config-cli.test.ts - add test
describe('config link command', () => {
  it('invokes runConfigUi with directEntry=link', async () => {
    // Mock stdin to simulate matrix editor behavior
    const result = await runCli(['config', 'link']);
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/config-cli.test.ts -t "config link"`
Expected: FAIL with "Unknown command"

- [ ] **Step 3: Add config link, server, remote commands to CLI**

```typescript
// src/index.ts - add to configCommand section, after 'config set'
configCommand
  .command('link')
  .description('Edit skill → agent links (matrix editor)')
  .action(async () => {
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'link' });
  });

configCommand
  .command('server')
  .description('Manage remote servers')
  .action(async () => {
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'server' });
  });

configCommand
  .command('remote')
  .description('Edit skill → server sync mapping (matrix editor)')
  .action(async () => {
    await runConfigUi(resolvedHomeDir, createPromptApi(), { directEntry: 'remote' });
  });
```

- [ ] **Step 4: Update shouldSkipAutoRefresh for new commands**

```typescript
// src/index.ts - update shouldSkipAutoRefresh function
function shouldSkipAutoRefresh(command: Command): boolean {
  const commandPath: string[] = [];
  let current: Command | null = command;

  while (current && current.parent) {
    commandPath.unshift(current.name());
    current = current.parent;

    if (!current.parent) {
      break;
    }
  }

  const skipCommands = [
    'init',
    'config',
    'config show',
    'config set',
    'config link',
    'config server',
    'config remote',
    'refresh'
  ];

  return skipCommands.includes(commandPath.join(' '));
}
```

- [ ] **Step 5: Update imports in index.ts**

```typescript
// src/index.ts - update import
import { createPromptApi, runConfigUi } from './config-ui.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/integration/config-cli.test.ts -t "config link"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/integration/config-cli.test.ts
git commit -m "feat(cli): add config link/server/remote direct entry commands"
```

---

### Task 9: Add @inquirer/core Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install @inquirer/core**

```bash
npm install @inquirer/core
```

- [ ] **Step 2: Verify package.json updated**

Run: `grep "@inquirer/core" package.json`
Expected: Shows version in dependencies

- [ ] **Step 3: Run all tests to ensure nothing broke**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @inquirer/core dependency"
```

---

### Task 10: Integration Testing and Final Verification

**Files:**
- Test: All test files

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Manual smoke test of config link**

Run: `npm run dev -- config link`
Expected: Matrix editor appears with skills × agents grid

- [ ] **Step 4: Manual smoke test of config server**

Run: `npm run dev -- config server`
Expected: Server management menu appears

- [ ] **Step 5: Manual smoke test of config remote**

Run: `npm run dev -- config remote`
Expected: Matrix editor appears with skills × servers grid (or message if no servers)

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration test adjustments"
```

---

## Summary

| Task | Component | Files |
|------|-----------|-------|
| 1 | Git branch auto-detection | source.ts |
| 2 | Matrix editor component | matrix-editor.ts |
| 3 | Safe select wrapper | config-ui.ts |
| 4 | Update editLinks to matrix | config-ui.ts |
| 5 | Add editServers | config-ui.ts |
| 6 | Add editRemote | config-ui.ts |
| 7 | Update main menu | config-ui.ts |
| 8 | CLI direct commands | index.ts |
| 9 | Install dependency | package.json |
| 10 | Integration testing | all |

Total estimated time: 45-60 minutes of implementation
