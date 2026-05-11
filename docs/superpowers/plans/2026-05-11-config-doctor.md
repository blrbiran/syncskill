# Config Doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configuration diagnosis and repair functionality to detect and fix invalid references, paths, and stale entries in `~/.syncskill/config.yaml`.

**Architecture:** New `config-doctor.ts` module with pure diagnosis and repair functions. CLI integration via `syncskill doctor` command. Auto-check hook runs before commands, warns on issues, blocks on critical errors.

**Tech Stack:** TypeScript, vitest, @inquirer/prompts (for interactive repair)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config-doctor.ts` | Core diagnosis and repair logic |
| `tests/unit/config-doctor.test.ts` | Unit tests for diagnosis/repair functions |
| `tests/integration/doctor-cli.test.ts` | CLI integration tests |
| `src/index.ts` | Add `doctor` command, integrate auto-check hook |

---

### Task 1: Core Types and Diagnostic Codes

**Files:**
- Create: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for DiagnosticItem type shape**

```typescript
// tests/unit/config-doctor.test.ts
import { describe, expect, it } from 'vitest';

import {
  type DiagnosticItem,
  type DiagnosticReport,
  DiagnosticCode
} from '../../src/config-doctor.js';

describe('DiagnosticCode', () => {
  it('exports all expected diagnostic codes', () => {
    expect(DiagnosticCode.NO_VALID_AGENTS).toBe('NO_VALID_AGENTS');
    expect(DiagnosticCode.AGENT_PATH_INVALID).toBe('AGENT_PATH_INVALID');
    expect(DiagnosticCode.SKILL_NOT_FOUND).toBe('SKILL_NOT_FOUND');
    expect(DiagnosticCode.AGENT_NOT_CONFIGURED).toBe('AGENT_NOT_CONFIGURED');
    expect(DiagnosticCode.SOURCE_PATH_INVALID).toBe('SOURCE_PATH_INVALID');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write types and diagnostic codes**

```typescript
// src/config-doctor.ts
export const DiagnosticCode = {
  NO_VALID_AGENTS: 'NO_VALID_AGENTS',
  AGENT_PATH_INVALID: 'AGENT_PATH_INVALID',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  SOURCE_PATH_INVALID: 'SOURCE_PATH_INVALID'
} as const;

export type DiagnosticCodeType = typeof DiagnosticCode[keyof typeof DiagnosticCode];

export interface DiagnosticItem {
  code: DiagnosticCodeType;
  severity: 'error' | 'warning';
  message: string;
  path: string;
  suggestion?: string;
}

export interface DiagnosticReport {
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  isHealthy: boolean;
  canProceed: boolean;
}

export interface RepairOptions {
  removeInvalidSkillLinks: boolean;
  removeInvalidAgentLinks: boolean;
  removeInvalidAgents: boolean;
  removeInvalidSources: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add diagnostic types and codes"
```

---

### Task 2: Agent Path Validation

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for agent path validation**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkAgentPaths } from '../../src/config-doctor.js';

describe('checkAgentPaths', () => {
  const testDir = join(tmpdir(), `config-doctor-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty array when all agent paths exist', async () => {
    const agentDir = join(testDir, 'claude-skills');
    await mkdir(agentDir, { recursive: true });

    const agents = { claude: agentDir };
    const items = await checkAgentPaths(agents);

    expect(items).toEqual([]);
  });

  it('returns warning for single invalid agent path', async () => {
    const validDir = join(testDir, 'claude-skills');
    await mkdir(validDir, { recursive: true });

    const agents = {
      claude: validDir,
      hermes: join(testDir, 'nonexistent')
    };
    const items = await checkAgentPaths(agents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'AGENT_PATH_INVALID',
      severity: 'warning',
      path: 'agents.hermes'
    });
  });

  it('returns error when all agent paths are invalid', async () => {
    const agents = {
      claude: join(testDir, 'missing1'),
      hermes: join(testDir, 'missing2')
    };
    const items = await checkAgentPaths(agents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'NO_VALID_AGENTS',
      severity: 'error'
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "checkAgentPaths is not exported"

- [ ] **Step 3: Implement checkAgentPaths**

```typescript
// src/config-doctor.ts - add to existing file
import { access } from 'node:fs/promises';

export async function checkAgentPaths(
  agents: Record<string, string>
): Promise<DiagnosticItem[]> {
  const entries = Object.entries(agents);
  if (entries.length === 0) {
    return [];
  }

  const results = await Promise.all(
    entries.map(async ([name, path]) => {
      try {
        await access(path);
        return { name, path, valid: true };
      } catch {
        return { name, path, valid: false };
      }
    })
  );

  const validCount = results.filter((r) => r.valid).length;
  const invalidResults = results.filter((r) => !r.valid);

  if (validCount === 0 && entries.length > 0) {
    return [
      {
        code: DiagnosticCode.NO_VALID_AGENTS,
        severity: 'error',
        message: 'All agent paths are invalid. At least one is required.',
        path: 'agents'
      }
    ];
  }

  return invalidResults.map((r) => ({
    code: DiagnosticCode.AGENT_PATH_INVALID,
    severity: 'warning' as const,
    message: `Path does not exist: ${r.path}`,
    path: `agents.${r.name}`,
    suggestion: `Remove "${r.name}" from agents`
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add agent path validation"
```

---

### Task 3: Skill Reference Validation

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for skill reference validation**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { checkSkillReferences } from '../../src/config-doctor.js';

describe('checkSkillReferences', () => {
  it('returns empty array when all skills exist', () => {
    const links = { 'skill-a': ['claude'], 'skill-b': ['hermes'] };
    const existingSkills = new Set(['skill-a', 'skill-b']);
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toEqual([]);
  });

  it('returns warning for missing skill', () => {
    const links = { 'skill-a': ['claude'], 'missing-skill': ['claude'] };
    const existingSkills = new Set(['skill-a']);
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'SKILL_NOT_FOUND',
      severity: 'warning',
      path: 'links.missing-skill'
    });
  });

  it('skips skills with empty targets', () => {
    const links = { 'skill-a': [] };
    const existingSkills = new Set<string>();
    const items = checkSkillReferences(links, existingSkills);

    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "checkSkillReferences is not exported"

- [ ] **Step 3: Implement checkSkillReferences**

```typescript
// src/config-doctor.ts - add to existing file
export function checkSkillReferences(
  links: Record<string, string[]>,
  existingSkills: Set<string>
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  for (const [skill, targets] of Object.entries(links)) {
    if (targets.length === 0) {
      continue;
    }

    if (!existingSkills.has(skill)) {
      items.push({
        code: DiagnosticCode.SKILL_NOT_FOUND,
        severity: 'warning',
        message: `Skill "${skill}" not found in ~/.syncskill/skills/ or sources`,
        path: `links.${skill}`,
        suggestion: `Remove "${skill}" from links`
      });
    }
  }

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add skill reference validation"
```

---

### Task 4: Agent Reference Validation in Links

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for agent reference validation**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { checkAgentReferences } from '../../src/config-doctor.js';

describe('checkAgentReferences', () => {
  it('returns empty array when all agents are configured', () => {
    const links = { 'skill-a': ['claude', 'hermes'] };
    const configuredAgents = new Set(['claude', 'hermes']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toEqual([]);
  });

  it('returns warning for unconfigured agent in links', () => {
    const links = { 'skill-a': ['claude', 'missing-agent'] };
    const configuredAgents = new Set(['claude']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'AGENT_NOT_CONFIGURED',
      severity: 'warning',
      path: 'links.skill-a'
    });
    expect(items[0].message).toContain('missing-agent');
  });

  it('ignores wildcard target', () => {
    const links = { 'skill-a': ['*'] };
    const configuredAgents = new Set(['claude']);
    const items = checkAgentReferences(links, configuredAgents);

    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "checkAgentReferences is not exported"

- [ ] **Step 3: Implement checkAgentReferences**

```typescript
// src/config-doctor.ts - add to existing file
export function checkAgentReferences(
  links: Record<string, string[]>,
  configuredAgents: Set<string>
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  for (const [skill, targets] of Object.entries(links)) {
    const missingAgents = targets.filter(
      (agent) => agent !== '*' && !configuredAgents.has(agent)
    );

    for (const agent of missingAgents) {
      items.push({
        code: DiagnosticCode.AGENT_NOT_CONFIGURED,
        severity: 'warning',
        message: `Agent "${agent}" not configured in agents`,
        path: `links.${skill}`,
        suggestion: `Remove "${agent}" from links.${skill} targets`
      });
    }
  }

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add agent reference validation in links"
```

---

### Task 5: Source Path Validation

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for source path validation**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { checkSourcePaths } from '../../src/config-doctor.js';

describe('checkSourcePaths', () => {
  const testDir = join(tmpdir(), `config-doctor-source-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty array when local source path exists', async () => {
    const sourceDir = join(testDir, 'my-source');
    await mkdir(sourceDir, { recursive: true });

    const sources = {
      'my-source': { type: 'local', path: sourceDir }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toEqual([]);
  });

  it('returns warning for invalid local source path', async () => {
    const sources = {
      'my-source': { type: 'local', path: join(testDir, 'nonexistent') }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'SOURCE_PATH_INVALID',
      severity: 'warning',
      path: 'sources.my-source'
    });
  });

  it('skips non-local sources', async () => {
    const sources = {
      'git-source': { type: 'git', url: 'https://github.com/test/repo' }
    };
    const items = await checkSourcePaths(sources);

    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "checkSourcePaths is not exported"

- [ ] **Step 3: Implement checkSourcePaths**

```typescript
// src/config-doctor.ts - add to existing file
export async function checkSourcePaths(
  sources: Record<string, unknown>
): Promise<DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];

  for (const [name, sourceDef] of Object.entries(sources)) {
    if (!isRecord(sourceDef)) continue;
    if (sourceDef.type !== 'local') continue;
    if (typeof sourceDef.path !== 'string') continue;

    try {
      await access(sourceDef.path);
    } catch {
      items.push({
        code: DiagnosticCode.SOURCE_PATH_INVALID,
        severity: 'warning',
        message: `Path does not exist: ${sourceDef.path}`,
        path: `sources.${name}`,
        suggestion: `Remove "${name}" from sources`
      });
    }
  }

  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add source path validation"
```

---

### Task 6: Main diagnoseConfig Function

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for diagnoseConfig**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { diagnoseConfig } from '../../src/config-doctor.js';
import type { SyncSkillConfig } from '../../src/config.js';

describe('diagnoseConfig', () => {
  const testDir = join(tmpdir(), `config-doctor-diag-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns healthy report for valid config', async () => {
    const agentDir = join(testDir, 'claude-skills');
    const skillsDir = join(testDir, 'skills');
    const skillDir = join(skillsDir, 'my-skill');
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'my-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(true);
    expect(report.canProceed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('returns canProceed false when no valid agents', async () => {
    const skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: join(testDir, 'missing') },
      links: {},
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(false);
    expect(report.canProceed).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].code).toBe('NO_VALID_AGENTS');
  });

  it('collects warnings from all checks', async () => {
    const agentDir = join(testDir, 'claude-skills');
    const skillsDir = join(testDir, 'skills');
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });

    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'missing-skill': ['claude', 'missing-agent'] },
      servers: {},
      sources: {}
    };

    const report = await diagnoseConfig(config, skillsDir);

    expect(report.isHealthy).toBe(false);
    expect(report.canProceed).toBe(true);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "diagnoseConfig is not exported"

- [ ] **Step 3: Implement diagnoseConfig**

```typescript
// src/config-doctor.ts - add to existing file
import { readdir } from 'node:fs/promises';

import type { SyncSkillConfig } from './config.js';

export async function diagnoseConfig(
  config: SyncSkillConfig,
  skillsDir: string
): Promise<DiagnosticReport> {
  const errors: DiagnosticItem[] = [];
  const warnings: DiagnosticItem[] = [];

  const agentItems = await checkAgentPaths(config.agents);
  for (const item of agentItems) {
    if (item.severity === 'error') {
      errors.push(item);
    } else {
      warnings.push(item);
    }
  }

  const existingSkills = await discoverExistingSkills(skillsDir, config.sources);
  const skillItems = checkSkillReferences(config.links, existingSkills);
  warnings.push(...skillItems);

  const configuredAgents = new Set(Object.keys(config.agents));
  const agentRefItems = checkAgentReferences(config.links, configuredAgents);
  warnings.push(...agentRefItems);

  const sourceItems = await checkSourcePaths(config.sources);
  warnings.push(...sourceItems);

  return {
    errors,
    warnings,
    isHealthy: errors.length === 0 && warnings.length === 0,
    canProceed: errors.length === 0
  };
}

async function discoverExistingSkills(
  skillsDir: string,
  sources: Record<string, unknown>
): Promise<Set<string>> {
  const skills = new Set<string>();

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skills.add(entry.name);
      }
    }
  } catch {
    // skillsDir may not exist
  }

  for (const [name, sourceDef] of Object.entries(sources)) {
    if (!isRecord(sourceDef)) continue;
    if (typeof sourceDef.path !== 'string') continue;

    try {
      const entries = await readdir(sourceDef.path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          skills.add(entry.name);
        }
      }
    } catch {
      // source path may not exist
    }
  }

  return skills;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add main diagnoseConfig function"
```

---

### Task 7: repairConfig Function

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for repairConfig**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { repairConfig, type RepairOptions } from '../../src/config-doctor.js';

describe('repairConfig', () => {
  it('removes invalid skill from links', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid' },
      links: { 'valid-skill': ['claude'], 'invalid-skill': ['claude'] },
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.SKILL_NOT_FOUND,
          severity: 'warning',
          message: 'Skill not found',
          path: 'links.invalid-skill'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: true,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: false,
      removeInvalidSources: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.links).toEqual({ 'valid-skill': ['claude'] });
  });

  it('removes invalid agent from link targets', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid' },
      links: { 'my-skill': ['claude', 'invalid-agent'] },
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_NOT_CONFIGURED,
          severity: 'warning',
          message: 'Agent "invalid-agent" not configured',
          path: 'links.my-skill'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: true,
      removeInvalidAgents: false,
      removeInvalidSources: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.links['my-skill']).toEqual(['claude']);
  });

  it('removes invalid agent from agents', () => {
    const config: SyncSkillConfig = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: '/valid', hermes: '/invalid' },
      links: {},
      servers: {},
      sources: {}
    };

    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        {
          code: DiagnosticCode.AGENT_PATH_INVALID,
          severity: 'warning',
          message: 'Path invalid',
          path: 'agents.hermes'
        }
      ],
      isHealthy: false,
      canProceed: true
    };

    const options: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: true,
      removeInvalidSources: false
    };

    const repaired = repairConfig(config, report, options);

    expect(repaired.agents).toEqual({ claude: '/valid' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "repairConfig is not exported"

- [ ] **Step 3: Implement repairConfig**

```typescript
// src/config-doctor.ts - add to existing file
export function repairConfig(
  config: SyncSkillConfig,
  report: DiagnosticReport,
  options: RepairOptions
): SyncSkillConfig {
  let result = structuredClone(config);

  const allItems = [...report.errors, ...report.warnings];

  for (const item of allItems) {
    if (item.code === DiagnosticCode.SKILL_NOT_FOUND && options.removeInvalidSkillLinks) {
      const skillName = item.path.replace('links.', '');
      delete result.links[skillName];
    }

    if (item.code === DiagnosticCode.AGENT_NOT_CONFIGURED && options.removeInvalidAgentLinks) {
      const skillName = item.path.replace('links.', '');
      const agentMatch = item.message.match(/Agent "([^"]+)"/);
      if (agentMatch && result.links[skillName]) {
        result.links[skillName] = result.links[skillName].filter(
          (a) => a !== agentMatch[1]
        );
      }
    }

    if (item.code === DiagnosticCode.AGENT_PATH_INVALID && options.removeInvalidAgents) {
      const agentName = item.path.replace('agents.', '');
      delete result.agents[agentName];
    }

    if (item.code === DiagnosticCode.SOURCE_PATH_INVALID && options.removeInvalidSources) {
      const sourceName = item.path.replace('sources.', '');
      delete result.sources[sourceName];
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add repairConfig function"
```

---

### Task 8: Format Functions

**Files:**
- Modify: `src/config-doctor.ts`
- Test: `tests/unit/config-doctor.test.ts`

- [ ] **Step 1: Write test for format functions**

```typescript
// tests/unit/config-doctor.test.ts - add to existing file
import { formatDiagnosticReport, formatDiagnosticSummary } from '../../src/config-doctor.js';

describe('formatDiagnosticReport', () => {
  it('formats healthy report', () => {
    const report: DiagnosticReport = {
      errors: [],
      warnings: [],
      isHealthy: true,
      canProceed: true
    };

    const output = formatDiagnosticReport(report);

    expect(output).toContain('No issues found');
  });

  it('formats report with errors and warnings', () => {
    const report: DiagnosticReport = {
      errors: [
        {
          code: DiagnosticCode.NO_VALID_AGENTS,
          severity: 'error',
          message: 'All agent paths are invalid',
          path: 'agents'
        }
      ],
      warnings: [
        {
          code: DiagnosticCode.SKILL_NOT_FOUND,
          severity: 'warning',
          message: 'Skill "test" not found',
          path: 'links.test'
        }
      ],
      isHealthy: false,
      canProceed: false
    };

    const output = formatDiagnosticReport(report);

    expect(output).toContain('Error');
    expect(output).toContain('Warning');
    expect(output).toContain('1 error');
    expect(output).toContain('1 warning');
  });
});

describe('formatDiagnosticSummary', () => {
  it('formats one-line summary', () => {
    const report: DiagnosticReport = {
      errors: [],
      warnings: [
        { code: DiagnosticCode.SKILL_NOT_FOUND, severity: 'warning', message: '', path: '' },
        { code: DiagnosticCode.AGENT_PATH_INVALID, severity: 'warning', message: '', path: '' }
      ],
      isHealthy: false,
      canProceed: true
    };

    const output = formatDiagnosticSummary(report);

    expect(output).toContain('2 issues');
    expect(output).toContain('syncskill doctor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: FAIL with "formatDiagnosticReport is not exported"

- [ ] **Step 3: Implement format functions**

```typescript
// src/config-doctor.ts - add to existing file
export function formatDiagnosticReport(report: DiagnosticReport): string {
  if (report.isHealthy) {
    return '✓ No issues found. Config is healthy.';
  }

  const lines: string[] = [];
  lines.push('Config Diagnosis');
  lines.push('─'.repeat(40));
  lines.push('');

  for (const error of report.errors) {
    lines.push(`✗ Error: ${error.path}`);
    lines.push(`  ${error.message}`);
    lines.push('');
  }

  for (const warning of report.warnings) {
    lines.push(`⚠ Warning: ${warning.path}`);
    lines.push(`  ${warning.message}`);
    lines.push('');
  }

  lines.push('─'.repeat(40));

  const parts: string[] = [];
  if (report.errors.length > 0) {
    parts.push(`${report.errors.length} error${report.errors.length > 1 ? 's' : ''}`);
  }
  if (report.warnings.length > 0) {
    parts.push(`${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''}`);
  }
  lines.push(parts.join(', '));

  if (!report.canProceed) {
    lines.push('');
    lines.push('Run `syncskill doctor --fix` to repair.');
  }

  return lines.join('\n');
}

export function formatDiagnosticSummary(report: DiagnosticReport): string {
  const total = report.errors.length + report.warnings.length;
  return `⚠ Config has ${total} issue${total > 1 ? 's' : ''} (run \`syncskill doctor\` to fix)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config-doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config-doctor.ts tests/unit/config-doctor.test.ts
git commit -m "feat(doctor): add report formatting functions"
```

---

### Task 9: CLI doctor Command

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration/doctor-cli.test.ts`

- [ ] **Step 1: Write integration test for doctor command**

```typescript
// tests/integration/doctor-cli.test.ts
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

describe('syncskill doctor', () => {
  const testDir = join(tmpdir(), `doctor-cli-test-${Date.now()}`);
  const homeDir = join(testDir, 'home');
  const syncDir = join(homeDir, '.syncskill');
  const skillsDir = join(syncDir, 'skills');
  const configFile = join(syncDir, 'config.yaml');
  const cliPath = join(process.cwd(), 'dist', 'index.js');

  beforeEach(async () => {
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function runDoctor(args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const result = await execFileAsync('node', [cliPath, 'doctor', ...args], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error: unknown) {
      const execError = error as { stdout: string; stderr: string; code: number };
      return { stdout: execError.stdout || '', stderr: execError.stderr || '', code: execError.code || 1 };
    }
  }

  it('reports healthy config', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: {},
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { stdout, code } = await runDoctor();

    expect(code).toBe(0);
    expect(stdout).toContain('No issues found');
  });

  it('reports missing skill warning', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'missing-skill': ['claude'] },
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { stdout, code } = await runDoctor();

    expect(code).toBe(0);
    expect(stdout).toContain('Warning');
    expect(stdout).toContain('missing-skill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -- tests/integration/doctor-cli.test.ts`
Expected: FAIL with "unknown command 'doctor'"

- [ ] **Step 3: Implement doctor command in index.ts**

```typescript
// src/index.ts - add import at top
import {
  diagnoseConfig,
  formatDiagnosticReport,
  repairConfig,
  type RepairOptions
} from './config-doctor.js';

// src/index.ts - add command after other commands (before program.parse())
program
  .command('doctor')
  .description('Diagnose and repair config.yaml issues')
  .option('--fix', 'Interactively fix issues')
  .option('--dry-run', 'Preview fixes without applying')
  .option('-y, --yes', 'Auto-fix all issues without prompting')
  .action(async (options: { fix?: boolean; dryRun?: boolean; yes?: boolean }) => {
    const { configFile, skillsDir } = getSyncPaths(resolvedHomeDir);

    let config: SyncSkillConfig;
    try {
      config = await loadConfig(resolvedHomeDir);
    } catch (error) {
      console.error('Failed to load config:', error instanceof Error ? error.message : error);
      process.exit(1);
    }

    const report = await diagnoseConfig(config, skillsDir);

    if (!options.fix) {
      console.log(formatDiagnosticReport(report));
      process.exit(report.canProceed ? 0 : 1);
    }

    if (report.isHealthy) {
      console.log('✓ No issues found. Config is healthy.');
      return;
    }

    console.log(`Found ${report.errors.length + report.warnings.length} issues to fix:\n`);

    const repairOptions: RepairOptions = {
      removeInvalidSkillLinks: false,
      removeInvalidAgentLinks: false,
      removeInvalidAgents: false,
      removeInvalidSources: false
    };

    const allItems = [...report.errors, ...report.warnings];

    for (const item of allItems) {
      const shouldFix = options.yes || (await confirm({
        message: `${item.suggestion ?? `Fix ${item.path}`}?`,
        default: true
      }));

      if (shouldFix) {
        if (item.code === 'SKILL_NOT_FOUND') repairOptions.removeInvalidSkillLinks = true;
        if (item.code === 'AGENT_NOT_CONFIGURED') repairOptions.removeInvalidAgentLinks = true;
        if (item.code === 'AGENT_PATH_INVALID') repairOptions.removeInvalidAgents = true;
        if (item.code === 'SOURCE_PATH_INVALID') repairOptions.removeInvalidSources = true;

        if (!options.dryRun) {
          config = repairConfig(config, { errors: [], warnings: [item], isHealthy: false, canProceed: true }, repairOptions);
        }
        console.log(`✓ Fixed ${item.path}`);
      } else {
        console.log(`⊘ Skipped ${item.path}`);
      }
    }

    if (!options.dryRun) {
      await saveConfig(config, resolvedHomeDir);
      console.log('\nConfig saved.');
    } else {
      console.log('\n[dry-run] No changes written.');
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npm test -- tests/integration/doctor-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/integration/doctor-cli.test.ts
git commit -m "feat(doctor): add CLI doctor command"
```

---

### Task 10: Auto-Check Hook Integration

**Files:**
- Modify: `src/config-doctor.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/doctor-cli.test.ts`

- [ ] **Step 1: Write test for auto-check hook**

```typescript
// tests/integration/doctor-cli.test.ts - add to existing file
describe('auto-check integration', () => {
  it('warns when running link with config issues', async () => {
    const agentDir = join(homeDir, '.claude', 'skills');
    await mkdir(agentDir, { recursive: true });

    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: agentDir },
      links: { 'missing-skill': ['claude'] },
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { stderr, code } = await execFileAsync('node', [cliPath, 'link', 'list'], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    }).catch((e) => e);

    expect(stderr).toContain('Config has');
    expect(stderr).toContain('syncskill doctor');
  });

  it('blocks when no valid agents', async () => {
    const config = {
      version: 1,
      conflict_resolution: 'manual',
      agents: { claude: join(homeDir, 'nonexistent') },
      links: {},
      servers: {},
      sources: {}
    };
    await writeFile(configFile, YAML.stringify(config));

    const { code, stderr } = await execFileAsync('node', [cliPath, 'link', 'list'], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    }).catch((e) => ({ code: e.code, stderr: e.stderr }));

    expect(code).not.toBe(0);
    expect(stderr).toContain('doctor --fix');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm test -- tests/integration/doctor-cli.test.ts`
Expected: FAIL (no auto-check output)

- [ ] **Step 3: Add autoDiagnoseConfig function**

```typescript
// src/config-doctor.ts - add to existing file
export async function autoDiagnoseConfig(
  config: SyncSkillConfig,
  skillsDir: string
): Promise<void> {
  const report = await diagnoseConfig(config, skillsDir);

  if (report.isHealthy) {
    return;
  }

  console.error(formatDiagnosticSummary(report));

  if (!report.canProceed) {
    console.error('Run `syncskill doctor --fix` to repair.');
    process.exit(1);
  }
}
```

- [ ] **Step 4: Integrate auto-check hook in index.ts**

```typescript
// src/index.ts - add import
import { autoDiagnoseConfig } from './config-doctor.js';

// src/index.ts - modify the pre-action hook (find the existing hook pattern)
// Add this after loadConfig but before autoRefreshManifests in commands that need it

// For commands that should auto-check (link, push, pull, sync, etc.),
// add this line after loading config:
//   await autoDiagnoseConfig(config, skillsDir);

// Example modification for link command's action:
// Before:
//   const config = await loadConfig(resolvedHomeDir);
//   await autoRefreshManifests(resolvedHomeDir, !options.noRefresh);
//
// After:
//   const config = await loadConfig(resolvedHomeDir);
//   const { skillsDir } = getSyncPaths(resolvedHomeDir);
//   await autoDiagnoseConfig(config, skillsDir);
//   await autoRefreshManifests(resolvedHomeDir, !options.noRefresh);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && npm test -- tests/integration/doctor-cli.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config-doctor.ts src/index.ts tests/integration/doctor-cli.test.ts
git commit -m "feat(doctor): add auto-check hook integration"
```

---

### Task 11: Final Integration and Documentation

**Files:**
- Modify: `docs/usage-guide.md`

- [ ] **Step 1: Add doctor command to usage guide**

```markdown
<!-- docs/usage-guide.md - add new section -->

## Config Doctor

The `doctor` command diagnoses and repairs issues in your `~/.syncskill/config.yaml`.

### Diagnosis Only

```bash
syncskill doctor
```

Outputs a report of all issues found without making changes.

### Interactive Repair

```bash
syncskill doctor --fix
```

Prompts for each issue, asking whether to fix it.

### Auto-Repair All

```bash
syncskill doctor --fix -y
```

Automatically fixes all issues without prompting.

### Preview Mode

```bash
syncskill doctor --fix --dry-run
```

Shows what would be fixed without actually modifying config.

### Auto-Check

All commands automatically check config health on startup:
- Warnings are printed but don't block execution
- Critical errors (like no valid agents) block execution and prompt you to run `doctor --fix`
```

- [ ] **Step 2: Run all tests**

Run: `npm run build && npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add docs/usage-guide.md
git commit -m "docs: add config doctor section to usage guide"
```

- [ ] **Step 4: Final verification**

Run: `npm run build && npm link && syncskill doctor`
Expected: Shows diagnosis report (healthy or with issues depending on your config)
