# E2E 测试编写指南

本指南介绍如何为 syncskill 编写 End-to-End 测试。

## 快速开始

### 最小测试示例

```typescript
// tests/end2end/cases/install/install-basic.test.ts
import { e2eTest, E2EScenario } from '../../framework/index.js';

e2eTest("init creates config file", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .setup();
  
  await ctx.run("syncskill", "init", "-y", "--skip-skill");
  await ctx.assertFileExists(".syncskill/config.yaml");
});
```

### 运行测试

```bash
# 日常开发（跳过 E2E）
npm test

# 运行 E2E 测试（不含网络）
npm run test:e2e

# 运行 E2E 网络测试
npm run test:e2e:network

# 全量 E2E
npm run test:e2e:all

# 详细输出模式
npm run test:e2e:verbose

# 运行单个测试文件
npx vitest run tests/end2end/cases/install/install-basic.test.ts
```

## API 参考

### E2EScenario (Builder)

用于配置测试环境。所有 `with*` 方法返回 `this`，支持链式调用。

#### Agent 配置

```typescript
// 添加单个 agent
new E2EScenario().withAgent("claude")

// 添加多个 agents
new E2EScenario().withAgents("claude", "agents", "qwen")
```

#### Skill 配置

```typescript
// 创建手动 skill（默认内容）
new E2EScenario().withSkill("my-skill")

// 创建手动 skill（自定义内容）
new E2EScenario().withSkill("my-skill", "# My Skill\n\nDescription here.")

// 创建多个 skills
new E2EScenario().withSkills(["skill-a", "skill-b", "skill-c"])
```

#### Source 配置

```typescript
// Git source（本地 bare repo）
new E2EScenario().withGitSource("my-repo", {
  skills: ["skill-a", "skill-b"],
  branch: "main",  // 可选，默认 "main"
})

// HTTP source（本地 http server）
new E2EScenario().withHttpSource("my-pack", {
  skills: ["skill-x", "skill-y"],
  format: "zip",  // 可选，默认 "zip"
})

// Local source
new E2EScenario().withLocalSource("local-tools", {
  skills: ["tool-a", "tool-b"],
})

// 压缩包文件
new E2EScenario().withArchive("pack.tar.gz", {
  skills: ["skill-1", "skill-2"],
  format: "tar.gz",
})
```

#### Config 配置

```typescript
// 预设 config（与默认合并）
new E2EScenario().withConfig({
  conflict_resolution: "keep-local",
})

// 预设 links
new E2EScenario().withLinks({
  "skill-a": ["claude", "agents"],
  "skill-b": ["*"],
})

// 先执行 init
new E2EScenario().withInit()
new E2EScenario().withInit({ skipScan: true, skipSkill: true })
```

#### 模拟服务器

```typescript
// 单个服务器
new E2EScenario().withMockServer({
  name: "dev-server",
  skills: ["skill-a"],  // 预装 skills
  agents: { claude: "~/.claude/skills" },
})

// 多个服务器
new E2EScenario().withMockServers([
  { name: "dev" },
  { name: "staging" },
  { name: "prod" },
])
```

#### 高级配置

```typescript
// 标记为网络测试
new E2EScenario().requiresNetwork()

// 设置环境变量
new E2EScenario().withEnv({ DEBUG: "1" })
```

### E2EContext (Runtime)

`setup()` 返回的运行时上下文。

#### 命令执行

```typescript
// 执行 syncskill 命令
const result = await ctx.run("syncskill", "init", "-y");

// 带选项执行
const result = await ctx.run("syncskill", ["install", url], {
  timeout: 60000,
  expectedExitCode: 0,
});

// 期望失败的命令
const result = await ctx.runExpectFail("syncskill", "install", "invalid-url");

// 执行其他命令
const result = await ctx.exec("git", ["status"]);
```

#### 文件操作

```typescript
// 读取文件
const content = await ctx.readFile(".syncskill/config.yaml");

// 写入文件
await ctx.writeFile(".syncskill/skills/my-skill/SKILL.md", "# Updated\n");

// 检查存在性
const exists = await ctx.exists(".syncskill/skills/my-skill");

// 读取 symlink target
const target = await ctx.readlink(".claude/skills/my-skill");

// 列出目录
const files = await ctx.readdir(".syncskill/skills");

// 读取 config
const config = await ctx.readConfig();

// 读取 registry
const registry = await ctx.readRegistry();
```

#### 获取路径

```typescript
// 获取绝对路径
const absPath = ctx.getPath(".syncskill", "skills", "my-skill");

// 获取 Git source URL
const url = ctx.getGitSourceUrl("my-repo");

// 获取 HTTP source URL
const url = ctx.getHttpSourceUrl("my-pack");

// 获取压缩包路径
const archivePath = ctx.getArchivePath("pack.tar.gz");
```

#### 模拟服务器操作

```typescript
// 修改服务器上的 skill
await ctx.modifyServerSkill("dev", "my-skill", "# New content\n");

// 添加 skill 到服务器
await ctx.addServerSkill("dev", "new-skill", "# New skill\n");

// 删除服务器上的 skill
await ctx.removeServerSkill("dev", "old-skill");

// 读取服务器上的 skill
const content = await ctx.readServerSkill("dev", "my-skill");
```

#### 断言

```typescript
// 链接状态
await ctx.assertLinked("my-skill", ["claude", "agents"]);
await ctx.assertNotLinked("my-skill", ["qwen"]);

// 文件类型
await ctx.assertIsSymlink("my-skill", "claude");
await ctx.assertIsRealDir("my-skill", "claude");

// 文件存在性
await ctx.assertFileExists(".syncskill/config.yaml");
await ctx.assertFileNotExists(".syncskill/skills/deleted");

// 文件内容
await ctx.assertFileContains(".syncskill/config.yaml", "version: 1");

// Config 状态
await ctx.assertSourceExists("my-repo");
await ctx.assertLinksConfig("my-skill", ["claude"]);

// 服务器状态
await ctx.assertServerHasSkill("dev", "my-skill");
await ctx.assertServerSkillContent("dev", "my-skill", "# Expected\n");

// 命令输出
ctx.assertOutputContains(result, "✓ Installed");
ctx.assertOutputMatches(result, /Found \d+ skills/);
```

## 常见测试模式

### 测试 init

```typescript
e2eTest("init creates default structure", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "agents")
    .setup();
  
  await ctx.run("syncskill", "init", "-y", "--skip-skill");
  
  await ctx.assertFileExists(".syncskill/config.yaml");
  await ctx.assertFileExists(".syncskill/skills");
  
  const config = await ctx.readConfig();
  expect(config.agents).toContain("claude");
});
```

### 测试 install

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

### 测试 link

```typescript
e2eTest("link --all creates all links", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "agents", "qwen")
    .withInit()
    .withSkills(["skill-a", "skill-b"])
    .withLinks({
      "skill-a": ["*"],
      "skill-b": ["claude"],
    })
    .setup();
  
  await ctx.run("syncskill", "link", "--all");
  
  await ctx.assertLinked("skill-a", ["claude", "agents", "qwen"]);
  await ctx.assertLinked("skill-b", ["claude"]);
  await ctx.assertNotLinked("skill-b", ["agents", "qwen"]);
});

e2eTest("link --all reconciles stale links", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude", "qwen")
    .withInit()
    .withSkill("my-skill")
    .withLinks({ "my-skill": ["*"] })
    .setup();
  
  // 创建所有链接
  await ctx.run("syncskill", "link", "--all");
  await ctx.assertLinked("my-skill", ["claude", "qwen"]);
  
  // 修改 config：只保留 claude
  const config = await ctx.readConfig();
  config.links["my-skill"] = ["claude"];
  await ctx.writeFile(".syncskill/config.yaml", stringify(config));
  
  // 再次 link --all，应该清理 stale
  await ctx.run("syncskill", "link", "--all", "-y");
  
  await ctx.assertLinked("my-skill", ["claude"]);
  await ctx.assertNotLinked("my-skill", ["qwen"]);
});
```

### 测试 source update

```typescript
e2eTest("source update pulls latest changes", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withGitSource("my-repo", { skills: ["skill-a"] })
    .setup();
  
  // 安装
  await ctx.run("syncskill", "install", ctx.getGitSourceUrl("my-repo"), "-y");
  
  // 远程添加新 skill
  await ctx.addSkillToGitSource("my-repo", "skill-b");
  
  // 更新
  await ctx.run("syncskill", "update", "my-repo", "-y");
  
  // 新 skill 应该可用
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
  
  // 本地修改
  await ctx.writeFile(".syncskill/sources/my-repo/skill-a/SKILL.md", "# Modified\n");
  
  // 远程也修改
  await ctx.modifyGitSourceSkill("my-repo", "skill-a", "# Remote change\n");
  
  // update 应该提示 dirty
  const result = await ctx.run("syncskill", "update", "my-repo", { expectedExitCode: null });
  ctx.assertOutputContains(result, "dirty");
});
```

### 测试 push/pull/sync

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
  
  // 先 push 建立同步
  await ctx.run("syncskill", "push", "dev", "-y");
  
  // 远程修改
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
  
  // 本地改 a，远程改 b
  await ctx.writeFile(".syncskill/skills/skill-a/SKILL.md", "# Local\n");
  await ctx.modifyServerSkill("prod", "skill-b", "# Remote\n");
  
  await ctx.run("syncskill", "sync", "prod", "-y");
  
  // a 推送到远程
  await ctx.assertServerSkillContent("prod", "skill-a", "# Local\n");
  // b 拉取到本地
  const contentB = await ctx.readFile(".syncskill/skills/skill-b/SKILL.md");
  expect(contentB).toBe("# Remote\n");
});
```

### 测试错误场景

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

## 共享 Fixture 与快照

### 何时使用

- **独立 Scenario**：简单测试，完全隔离
- **Shared Fixture**：同一 describe 内多个断言，避免重复 setup
- **Snapshot**：复杂分支测试，需要从同一起点测试不同路径

### Shared Fixture 示例

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

### Snapshot 示例

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
    // 独立副本
    await ctx.run("syncskill", "link", "a", "--agents", "claude");
  });
  
  it("branch B: update source", async () => {
    const ctx = await E2EScenario.fromSnapshot(baseCtx, "installed").setup();
    // 另一个独立副本
    await ctx.run("syncskill", "update", "-y");
  });
});
```

## 网络测试

### 标记为网络测试

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

### 使用测试仓库

```typescript
import { TEST_REPO } from '../../framework/index.js';

// 预定义的 URL
TEST_REPO.urls.root           // 整个仓库
TEST_REPO.urls.skills         // skills/ 子目录
TEST_REPO.urls.singleSkill    // 单个 skill
TEST_REPO.urls.examples       // examples/ 子目录

// 预期结果
TEST_REPO.expectedSkills.root   // ['syncskill_test', 'skill-alpha', ...]
TEST_REPO.expectedSkills.skills // ['skill-alpha', 'skill-beta']
```

## 调试技巧

### Verbose 模式

```bash
# 环境变量
E2E_VERBOSE=1 npm run test:e2e

# 或使用 verbose script
npm run test:e2e:verbose
```

### 诊断输出

测试失败时自动输出：
- Home 目录路径
- 命令执行历史
- 最后的 stderr

### 保留 temp 目录调试

```typescript
e2eTest("debug this test", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .setup();
  
  console.log("Temp dir:", ctx.homeDir);  // 打印路径
  
  // 测试逻辑...
  
  // 在这里设断点或 sleep，手动检查目录内容
  // await new Promise(r => setTimeout(r, 60000));
});
```

### 单独运行一个测试

```typescript
// 使用 .only
e2eTest.only("focus on this", async () => {
  // ...
});
```

```bash
# 或命令行指定
npx vitest run tests/end2end/cases/install/install-basic.test.ts
```
