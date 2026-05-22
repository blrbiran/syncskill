# E2E Test Writing Guide

This guide explains how to write End-to-End tests for syncskill.

## Quick Start

### Minimal Test Example

```typescript
// tests/end2end/cases/install/install-basic.test.ts
import { e2eTest, E2EScenario } from '../../framework/index.js';

e2eTest("init creates config file", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .setup();

  await ctx.run("syncskill", "init", "-y", "--skip-self");
  await ctx.assertFileExists(".syncskill/config.yaml");
});
```

### Running Tests

```bash
# Daily development (skips E2E)
npm test

# Run E2E tests (no network)
npm run test:e2e

# Run E2E network tests
npm run test:e2e:network

# Full E2E suite
npm run test:e2e:all

# Verbose output mode
npm run test:e2e:verbose

# Run a single test file
npx vitest run tests/end2end/cases/install/install-basic.test.ts
```

## API Reference

### E2EScenario (Builder)

Configures the test environment. All `with*` methods return `this` for chaining.

#### Agent Configuration

```typescript
// Add a single agent
new E2EScenario().withAgent("claude")

// Add multiple agents
new E2EScenario().withAgents("claude", "agents", "qwen")
```

#### Skill Configuration

```typescript
// Create a manual skill (default content)
new E2EScenario().withSkill("my-skill")

// Create a manual skill (custom content)
new E2EScenario().withSkill("my-skill", "# My Skill\n\nDescription here.")

// Create multiple skills
new E2EScenario().withSkills(["skill-a", "skill-b", "skill-c"])
```

#### Source Configuration

```typescript
// Git source (local bare repo)
new E2EScenario().withGitSource("my-repo", {
  skills: ["skill-a", "skill-b"],
  branch: "main",  // optional, defaults to "main"
})

// HTTP source (local http server)
new E2EScenario().withHttpSource("my-pack", {
  skills: ["skill-x", "skill-y"],
  format: "zip",  // optional, defaults to "zip"
})

// Local source
new E2EScenario().withLocalSource("local-tools", {
  skills: ["tool-a", "tool-b"],
})

// Archive file
new E2EScenario().withArchive("pack.tar.gz", {
  skills: ["skill-1", "skill-2"],
  format: "tar.gz",
})
```

#### Config Configuration

```typescript
// Preset config (merged with defaults)
new E2EScenario().withConfig({
  conflict_resolution: "keep-local",
})

// Preset links
new E2EScenario().withLinks({
  "skill-a": ["claude", "agents"],
  "skill-b": ["*"],
})

// Run init first
new E2EScenario().withInit()
new E2EScenario().withInit({ skipScan: true, skipSelf: true })
```

#### Mock Server Configuration

```typescript
// Single server
new E2EScenario().withMockServer({
  name: "dev-server",
  skills: ["skill-a"],  // pre-installed skills
  agents: { claude: "~/.claude/skills" },
})

// Multiple servers
new E2EScenario().withMockServers([
  { name: "dev" },
  { name: "staging" },
  { name: "prod" },
])
```

#### Advanced Configuration

```typescript
// Mark as network test
new E2EScenario().requiresNetwork()

// Set environment variables
new E2EScenario().withEnv({ DEBUG: "1" })
```

### E2EContext (Runtime)

The runtime context returned by `setup()`.

#### Command Execution

```typescript
// Run syncskill command
const result = await ctx.run("syncskill", "init", "-y");

// Run with options
const result = await ctx.run("syncskill", ["install", url], {
  timeout: 60000,
  expectedExitCode: 0,
});

// Expect command to fail
const result = await ctx.runExpectFail("syncskill", "install", "invalid-url");

// Run other commands
const result = await ctx.exec("git", ["status"]);
```

#### File Operations

```typescript
// Read file
const content = await ctx.readFile(".syncskill/config.yaml");

// Write file
await ctx.writeFile(".syncskill/skills/my-skill/SKILL.md", "# Updated\n");

// Check existence
const exists = await ctx.exists(".syncskill/skills/my-skill");

// Read symlink target
const target = await ctx.readlink(".claude/skills/my-skill");

// List directory
const files = await ctx.readdir(".syncskill/skills");

// Read config
const config = await ctx.readConfig();

// Read registry
const registry = await ctx.readRegistry();
```

#### Path Access

```typescript
// Get absolute path
const absPath = ctx.getPath(".syncskill", "skills", "my-skill");

// Get Git source URL
const url = ctx.getGitSourceUrl("my-repo");

// Get HTTP source URL
const url = ctx.getHttpSourceUrl("my-pack");

// Get archive path
const archivePath = ctx.getArchivePath("pack.tar.gz");
```

#### Mock Server Operations

```typescript
// Modify skill on server
await ctx.modifyServerSkill("dev", "my-skill", "# New content\n");

// Add skill to server
await ctx.addServerSkill("dev", "new-skill", "# New skill\n");

// Remove skill from server
await ctx.removeServerSkill("dev", "old-skill");

// Read skill from server
const content = await ctx.readServerSkill("dev", "my-skill");
```

#### Assertions

```typescript
// Link status
await ctx.assertLinked("my-skill", ["claude", "agents"]);
await ctx.assertNotLinked("my-skill", ["qwen"]);

// File type
await ctx.assertIsSymlink("my-skill", "claude");
await ctx.assertIsRealDir("my-skill", "claude");

// File existence
await ctx.assertFileExists(".syncskill/config.yaml");
await ctx.assertFileNotExists(".syncskill/skills/deleted");

// File content
await ctx.assertFileContains(".syncskill/config.yaml", "version: 1");

// Config state
await ctx.assertSourceExists("my-repo");
await ctx.assertLinksConfig("my-skill", ["claude"]);

// Server state
await ctx.assertServerHasSkill("dev", "my-skill");
await ctx.assertServerSkillContent("dev", "my-skill", "# Expected\n");

// Command output
ctx.assertOutputContains(result, "✓ Installed");
ctx.assertOutputMatches(result, /Found \d+ skills/);
```

## Common Test Patterns

### Testing init

```typescript
e2eTest("init creates default structure", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "agents")
    .setup();

  await ctx.run("syncskill", "init", "-y", "--skip-self");

  await ctx.assertFileExists(".syncskill/config.yaml");
  await ctx.assertFileExists(".syncskill/skills");

  const config = await ctx.readConfig();
  expect(config.agents).toContain("claude");
});
```

### Testing install

```typescript
e2eTest("install from git source", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withGitSource("test-repo", { skills: ["skill-a", "skill-b"] })
    .setup();

  await ctx.run("syncskill", "install", ctx.getGitSourceUrl("test-repo"), "-y");

  await ctx.assertLinked("skill-a", ["claude"]);
  await ctx.assertLinked("skill-b", ["claude"]);
  await ctx.assertSourceExists("test-repo");
});

e2eTest("install local archive", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withArchive("skills.zip", { skills: ["my-skill"] })
    .setup();

  await ctx.run("syncskill", "install", ctx.getArchivePath("skills.zip"), "-y");

  await ctx.assertLinked("my-skill", ["claude"]);
});
```

### Testing link

```typescript
e2eTest("link --apply creates all links", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "agents", "qwen")
    .withInit()
    .withSkills(["skill-a", "skill-b"])
    .withLinks({
      "skill-a": ["*"],
      "skill-b": ["claude"],
    })
    .setup();

  await ctx.run("syncskill", "link", "--apply");

  await ctx.assertLinked("skill-a", ["claude", "agents", "qwen"]);
  await ctx.assertLinked("skill-b", ["claude"]);
  await ctx.assertNotLinked("skill-b", ["agents", "qwen"]);
});

e2eTest("link --apply reconciles stale links", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "qwen")
    .withInit()
    .withSkill("my-skill")
    .withLinks({ "my-skill": ["*"] })
    .setup();

  // Create all links
  await ctx.run("syncskill", "link", "--apply");
  await ctx.assertLinked("my-skill", ["claude", "qwen"]);

  // Modify config: keep only claude
  const config = await ctx.readConfig();
  config.links["my-skill"] = ["claude"];
  await ctx.writeFile(".syncskill/config.yaml", stringify(config));

  // Run link --apply again, should clean up stale links
  await ctx.run("syncskill", "link", "--apply", "-y");

  await ctx.assertLinked("my-skill", ["claude"]);
  await ctx.assertNotLinked("my-skill", ["qwen"]);
});
```

### Testing source update

```typescript
e2eTest("source update pulls latest changes", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withGitSource("my-repo", { skills: ["skill-a"] })
    .setup();

  // Install
  await ctx.run("syncskill", "install", ctx.getGitSourceUrl("my-repo"), "-y");

  // Add new skill to remote
  await ctx.addSkillToGitSource("my-repo", "skill-b");

  // Update
  await ctx.run("syncskill", "update", "my-repo", "-y");

  // New skill should be available
  const result = await ctx.run("syncskill", "link", "skill-b");
  expect(result.success).toBe(true);
});

e2eTest("source update detects dirty state", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withGitSource("my-repo", { skills: ["skill-a"] })
    .setup();

  await ctx.run("syncskill", "install", ctx.getGitSourceUrl("my-repo"), "-y");

  // Local modification
  await ctx.writeFile(".syncskill/sources/my-repo/skill-a/SKILL.md", "# Modified\n");

  // Remote also modified
  await ctx.modifyGitSourceSkill("my-repo", "skill-a", "# Remote change\n");

  // Update should warn about dirty state
  const result = await ctx.run("syncskill", "update", "my-repo", { expectedExitCode: null });
  ctx.assertOutputContains(result, "dirty");
});
```

### Testing push/pull/sync

```typescript
e2eTest("push sends skill to server", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkill("my-skill", "# Local content\n")
    .withMockServer({ name: "dev" })
    .setup();

  await ctx.run("syncskill", "push", "dev", "-y");

  await ctx.assertServerHasSkill("dev", "my-skill");
  await ctx.assertServerSkillContent("dev", "my-skill", "# Local content\n");
});

e2eTest("pull fetches remote changes", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkill("my-skill", "# V1\n")
    .withMockServer({ name: "dev", skills: ["my-skill"] })
    .setup();

  // Push first to establish sync
  await ctx.run("syncskill", "push", "dev", "-y");

  // Remote modification
  await ctx.modifyServerSkill("dev", "my-skill", "# V2\n");

  // Pull
  await ctx.run("syncskill", "pull", "dev", "-y");

  const content = await ctx.readFile(".syncskill/skills/my-skill/SKILL.md");
  expect(content).toBe("# V2\n");
});

e2eTest("sync handles bidirectional changes", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkills(["skill-a", "skill-b"])
    .withMockServer({ name: "prod", skills: ["skill-a", "skill-b"] })
    .setup();

  await ctx.run("syncskill", "sync", "prod", "-y");

  // Local modifies a, remote modifies b
  await ctx.writeFile(".syncskill/skills/skill-a/SKILL.md", "# Local\n");
  await ctx.modifyServerSkill("prod", "skill-b", "# Remote\n");

  await ctx.run("syncskill", "sync", "prod", "-y");

  // a pushed to remote
  await ctx.assertServerSkillContent("prod", "skill-a", "# Local\n");
  // b pulled to local
  const contentB = await ctx.readFile(".syncskill/skills/skill-b/SKILL.md");
  expect(contentB).toBe("# Remote\n");
});
```

### Testing Error Scenarios

```typescript
e2eTest("install invalid url fails gracefully", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .setup();

  const result = await ctx.runExpectFail("syncskill", "install", "not-a-valid-url");

  ctx.assertOutputContains(result, "Error");
});
```

## Shared Fixtures and Snapshots

### When to Use

- **Independent Scenario**: Simple tests, fully isolated
- **Shared Fixture**: Multiple assertions in the same describe block, avoid repeated setup
- **Snapshot**: Complex branching tests, need to test different paths from the same starting point

### Shared Fixture Example

```typescript
describe("git source operations", () => {
  let sharedCtx: E2EContext;

  beforeAll(async () => {
    sharedCtx = await new E2EScenario()
      .withAgents("claude")
      .withInit()
      .withGitSource("shared-repo", { skills: ["a", "b", "c"] })
      .setup();

    await sharedCtx.run("syncskill", "install", sharedCtx.getGitSourceUrl("shared-repo"), "-y");
  });

  afterAll(async () => {
    await sharedCtx.cleanup();
  });

  it("all skills linked", async () => {
    await sharedCtx.assertLinked("a", ["claude"]);
    await sharedCtx.assertLinked("b", ["claude"]);
    await sharedCtx.assertLinked("c", ["claude"]);
  });

  it("source recorded in config", async () => {
    await sharedCtx.assertSourceExists("shared-repo");
  });
});
```

### Snapshot Example

```typescript
describe("branching tests", () => {
  let baseCtx: E2EContext;

  beforeAll(async () => {
    baseCtx = await new E2EScenario()
      .withAgents("claude", "agents")
      .withInit()
      .withGitSource("repo", { skills: ["a", "b"] })
      .setup();

    await baseCtx.run("syncskill", "install", baseCtx.getGitSourceUrl("repo"), "-y");
    await baseCtx.saveSnapshot("installed");
  });

  it("branch A: modify links", async () => {
    const ctx = await E2EScenario.fromSnapshot(baseCtx, "installed").setup();
    // Independent copy
    await ctx.run("syncskill", "link", "a", "--agents", "claude");
  });

  it("branch B: update source", async () => {
    const ctx = await E2EScenario.fromSnapshot(baseCtx, "installed").setup();
    // Another independent copy
    await ctx.run("syncskill", "update", "-y");
  });
});
```

## Network Tests

### Marking as Network Test

```typescript
import { TEST_REPO } from '../../framework/index.js';

e2eTest.network("clone real github repo", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .setup();

  await ctx.run("syncskill", "install", TEST_REPO.urls.root, "-y");

  for (const skill of TEST_REPO.expectedSkills.root) {
    await ctx.assertLinked(skill, ["claude"]);
  }
});
```

### Using the Test Repository

```typescript
import { TEST_REPO } from '../../framework/index.js';

// Predefined URLs
TEST_REPO.urls.root           // entire repo
TEST_REPO.urls.skills         // skills/ subdirectory
TEST_REPO.urls.singleSkill    // single skill
TEST_REPO.urls.examples       // examples/ subdirectory

// Expected results
TEST_REPO.expectedSkills.root   // ['syncskill_test', 'skill-alpha', ...]
TEST_REPO.expectedSkills.skills // ['skill-alpha', 'skill-beta']
```

## Debugging Tips

### Verbose Mode

```bash
# Environment variable
E2E_VERBOSE=1 npm run test:e2e

# Or use verbose script
npm run test:e2e:verbose
```

### Diagnostic Output

On test failure, the framework automatically outputs:
- Home directory path
- Command execution history
- Last stderr content

### Preserving Temp Directory for Debugging

```typescript
e2eTest("debug this test", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .setup();

  console.log("Temp dir:", ctx.homeDir);  // Print path

  // Test logic...

  // Set breakpoint or sleep here to manually inspect directory
  // await new Promise(r => setTimeout(r, 60000));
});
```

### Running a Single Test

```typescript
// Use .only
e2eTest.only("focus on this", async () => {
  // ...
});
```

```bash
# Or specify on command line
npx vitest run tests/end2end/cases/install/install-basic.test.ts
```
