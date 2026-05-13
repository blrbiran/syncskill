# E2E 测试框架设计

> 状态：草稿
> 创建日期：2026-05-13

## 1. 概述

`syncskill` 的 End-to-End 测试框架，用于模拟用户全流程操作，验证功能完整性，防止新功能开发导致基本功能回退。

**设计目标**：
- 模拟真实用户工作流（init → install → link → sync）
- 完全隔离，不触碰真实用户目录（`~/.syncskill/`, `~/.claude/` 等）
- 支持网络测试（真实 GitHub clone）与离线测试（本地模拟）混合模式
- 便于通过 AI agent 工具添加测试用例
- 接受较慢的执行速度，主要用于发布前验收

**设计约束**：
- 基于 vitest 统一管理，通过 tag/project 区分测试类型
- Builder 模式组织测试场景，职责清晰
- 多层安全保护，防止意外修改真实目录

## 2. 项目结构

```
tests/
├── end2end/
│   ├── framework/                    # E2E 测试框架核心
│   │   ├── index.ts                  # 统一导出
│   │   ├── scenario.ts               # E2EScenario builder
│   │   ├── context.ts                # E2EContext runtime
│   │   ├── runner.ts                 # CLI 执行器
│   │   ├── guard.ts                  # 安全保护（防止触碰真实目录）
│   │   ├── cleanup.ts                # 清理机制
│   │   ├── setup.ts                  # vitest setup
│   │   └── fixtures/                 # 测试数据生成
│   │       ├── git.ts                # Git 仓库 fixture
│   │       ├── archive.ts            # 压缩包 fixture
│   │       ├── skill.ts              # Skill 文件 fixture
│   │       ├── server.ts             # 模拟远程服务器
│   │       └── github.ts             # GitHub 测试仓库配置
│   │
│   ├── cases/                        # 测试用例（按功能分组）
│   │   ├── install/
│   │   │   ├── install-builtin.test.ts
│   │   │   ├── install-local-archive.test.ts
│   │   │   └── install-git-source.test.ts
│   │   ├── link/
│   │   │   ├── link-all.test.ts
│   │   │   └── link-reconcile.test.ts
│   │   ├── source/
│   │   │   ├── source-add.test.ts
│   │   │   └── source-update.test.ts
│   │   ├── sync/
│   │   │   ├── push-pull.test.ts
│   │   │   └── conflict.test.ts
│   │   └── network/                  # 需要真实网络的测试
│   │       └── github-clone.test.ts
│   │
│   ├── fixtures/
│   │   └── syncskill_test/           # Git submodule（测试仓库）
│   │
│   └── smoke.test.ts                 # 现有的 smoke test（保留）
│
├── integration/                      # 现有集成测试（不变）
├── unit/                             # 现有单元测试（不变）
└── helpers/                          # 共享 helper
    └── temp-dir.ts
```

## 3. 核心组件

### 3.1 E2EScenario (Builder)

Builder 模式的场景配置器，用于声明式定义测试环境。

```typescript
interface GitSourceConfig {
  skills: string[];
  branch?: string;                     // 默认 "main"
  skillContents?: Record<string, string>;
}

interface HttpSourceConfig {
  skills: string[];
  format?: 'zip' | 'tar.gz';           // 默认 "zip"
}

interface LocalSourceConfig {
  skills: string[];
  path?: string;
}

interface MockServerConfig {
  name: string;
  skills?: string[];
  agents?: Record<string, string>;
}

class E2EScenario {
  constructor();

  // Agent 配置
  withAgent(name: string): this;
  withAgents(...names: string[]): this;

  // Skill 配置（手动 skill）
  withSkill(name: string, content?: string): this;
  withSkills(names: string[]): this;

  // Source 配置
  withGitSource(name: string, config: GitSourceConfig): this;
  withHttpSource(name: string, config: HttpSourceConfig): this;
  withLocalSource(name: string, config: LocalSourceConfig): this;
  withArchive(name: string, config: { skills: string[]; format?: 'zip' | 'tar.gz' }): this;
  withGitSourceFromTemplate(name: string, config: { templatePath: string; skills: string[] }): this;

  // Config 配置
  withConfig(partial: Partial<SyncSkillConfig>): this;
  withLinks(links: Record<string, string[]>): this;
  withInit(options?: { skipScan?: boolean; skipSkill?: boolean }): this;

  // 模拟服务器
  withMockServer(config: MockServerConfig): this;
  withMockServers(configs: MockServerConfig[]): this;

  // 高级配置
  requiresNetwork(): this;
  withEnv(env: Record<string, string>): this;

  // 从快照创建（用于共享 fixture）
  static fromSnapshot(ctx: E2EContext, snapshotName?: string): E2EScenario;

  // 执行 setup
  async setup(): Promise<E2EContext>;
}
```

### 3.2 E2EContext (Runtime)

运行时操作上下文，提供命令执行、文件操作、断言等能力。

```typescript
interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

interface RunOptions {
  expectedExitCode?: number | null;    // 默认 0
  timeout?: number;                    // 默认 30000
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  verbose?: boolean;
}

class E2EContext {
  // 路径访问
  readonly homeDir: string;
  readonly syncskillDir: string;
  getPath(...segments: string[]): string;
  getGitSourceUrl(name: string): string;
  getHttpSourceUrl(name: string): string;
  getArchivePath(name: string): string;
  getMockServerPath(name: string): string;

  // 命令执行
  async run(cmd: "syncskill", ...args: string[]): Promise<RunResult>;
  async run(cmd: "syncskill", args: string[], options?: RunOptions): Promise<RunResult>;
  async exec(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>;
  async runExpectFail(cmd: "syncskill", ...args: string[]): Promise<RunResult>;

  // 文件操作
  async readFile(relativePath: string): Promise<string>;
  async writeFile(relativePath: string, content: string): Promise<void>;
  async exists(relativePath: string): Promise<boolean>;
  async readlink(relativePath: string): Promise<string>;
  async readdir(relativePath: string): Promise<string[]>;
  async readConfig(): Promise<SyncSkillConfig>;
  async readRegistry(): Promise<SkillsRegistry>;

  // Fixture 动态创建
  async createArchive(name: string, skills: string[], options?: { format?: 'zip' | 'tar.gz' }): Promise<string>;
  async addSkillToGitSource(sourceName: string, skillName: string): Promise<void>;
  async removeSkillFromGitSource(sourceName: string, skillName: string): Promise<void>;
  async modifyGitSourceSkill(sourceName: string, skillName: string, newContent: string): Promise<void>;

  // 模拟服务器操作
  async modifyServerSkill(serverName: string, skillName: string, content: string): Promise<void>;
  async removeServerSkill(serverName: string, skillName: string): Promise<void>;
  async addServerSkill(serverName: string, skillName: string, content?: string): Promise<void>;
  async readServerSkill(serverName: string, skillName: string): Promise<string>;
  async readServerManifest(serverName: string): Promise<ServerManifest>;

  // 断言
  async assertLinked(skill: string, agents: string[]): Promise<void>;
  async assertNotLinked(skill: string, agents: string[]): Promise<void>;
  async assertIsRealDir(skill: string, agent: string): Promise<void>;
  async assertIsSymlink(skill: string, agent: string): Promise<void>;
  async assertFileExists(relativePath: string): Promise<void>;
  async assertFileNotExists(relativePath: string): Promise<void>;
  async assertFileContains(relativePath: string, substring: string): Promise<void>;
  async assertSourceExists(name: string): Promise<void>;
  async assertLinksConfig(skill: string, expectedAgents: string[]): Promise<void>;
  async assertServerHasSkill(serverName: string, skillName: string): Promise<void>;
  async assertServerSkillContent(serverName: string, skillName: string, expectedContent: string): Promise<void>;
  assertOutputContains(result: RunResult, substring: string): void;
  assertOutputMatches(result: RunResult, pattern: RegExp): void;

  // 生命周期
  async saveSnapshot(name: string): Promise<void>;
  async cleanup(): Promise<void>;
  dumpDiagnostics(): void;
}
```

### 3.3 安全保护机制

**⚠️ 重要：这是 E2E 测试框架的核心安全设计，必须严格遵守。**

E2E 测试绝对不能修改真实用户目录。框架采用多层防护策略：

#### 3.3.1 受保护的路径

以下路径在 E2E 测试中**绝对禁止触碰**：

```typescript
const PROTECTED_PATHS = [
  process.env.HOME,                    // 真实 HOME
  `${process.env.HOME}/.syncskill`,
  `${process.env.HOME}/.claude`,
  `${process.env.HOME}/.agents`,
  `${process.env.HOME}/.cursor`,
  `${process.env.HOME}/.windsurf`,
  `${process.env.HOME}/.codex`,
  `${process.env.HOME}/.gemini`,
  `${process.env.HOME}/.kiro`,
  `${process.env.HOME}/.augment`,
  `${process.env.HOME}/.config/agents`,
  `${process.env.HOME}/.cline`,
  `${process.env.HOME}/.config/opencode`,
  `${process.env.HOME}/.qwen`,
  `${process.env.HOME}/.openclaw`,
  `${process.env.HOME}/.hermes`,
  `${process.env.HOME}/.qoder`,
  `${process.env.HOME}/.aone_copilot`,
];
```

#### 3.3.2 四层防护

| 层次 | 机制 | 时机 | 作用 |
|------|------|------|------|
| L1 | HOME 环境变量重定向 | 命令执行时 | 让 syncskill 使用假 HOME |
| L2 | 路径校验 | 文件操作时 | 阻止写入真实路径 |
| L3 | 快照对比 | 命令执行前后 | 检测意外修改 |
| L4 | 全局 beforeEach | 每个测试开始 | 预警 HOME 未重定向 |

#### 3.3.3 Guard 实现

```typescript
class E2EGuardError extends Error {
  constructor(attemptedPath: string, reason: string);
}

function assertPathSafe(path: string): void;
function isInTempDir(path: string, allowedTempDir: string): boolean;
async function captureProtectedSnapshot(): Promise<DirectorySnapshot[]>;
async function verifyProtectedUnchanged(before: DirectorySnapshot[]): Promise<void>;
```

#### 3.3.4 Context 集成

```typescript
class E2EContext {
  constructor(homeDir: string) {
    // 确保 homeDir 是 temp 目录
    if (!homeDir.includes('/tmp/') && !homeDir.includes(tmpdir())) {
      throw new E2EGuardError(homeDir, 'homeDir must be in system temp directory');
    }
    this.guard = new E2EGuard(homeDir);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const absPath = this.getPath(relativePath);
    this.guard.assertSafe(absPath);  // 写入前校验
    await fs.writeFile(absPath, content);
  }

  async run(cmd: "syncskill", ...args: string[]): Promise<RunResult> {
    const snapshot = await captureProtectedSnapshot();  // 执行前快照
    const result = await this.executeCommand(cmd, args);
    await verifyProtectedUnchanged(snapshot);           // 执行后校验
    return result;
  }
}
```

### 3.4 清理机制

```typescript
const TEMP_PREFIX = 'syncskill-e2e-';

// 清理策略
// - 正常结束：afterEach hook 自动清理
// - 测试失败：afterEach hook 自动清理
// - 进程崩溃：下次测试启动时扫描并清理残留 temp 目录

async function cleanupStaleTempDirs(): Promise<void>;
function registerCleanupHooks(tempDir: string): void;
```

**vitest setup：**

```typescript
// tests/end2end/framework/setup.ts
beforeAll(async () => {
  await cleanupStaleTempDirs();  // 清理上次崩溃残留
});

afterEach(async (context) => {
  // 测试失败时自动 dump 诊断信息
  if (context.task.result?.state === 'fail') {
    const e2eCtx = (context as any).__e2eContext as E2EContext | undefined;
    if (e2eCtx) {
      e2eCtx.dumpDiagnostics();
    }
  }
});
```

### 3.5 共享 Fixture 与快照

对于需要复用环境的测试（避免重复 git clone 等耗时操作）：

**方式 A：Shared Fixture（同一 describe 块内共享）**

```typescript
describe("git source operations", () => {
  let sharedCtx: E2EContext;

  beforeAll(async () => {
    sharedCtx = await new E2EScenario()
      .withAgents("claude")
      .withInit()
      .withGitSource("shared-repo", { skills: ["skill-a", "skill-b"] })
      .setup();

    const repoUrl = sharedCtx.getGitSourceUrl("shared-repo");
    await sharedCtx.run("syncskill", "install", repoUrl, "-y");
  });

  afterAll(async () => {
    await sharedCtx.cleanup();
  });

  it("skill-a is linked", async () => {
    await sharedCtx.assertLinked("skill-a", ["claude"]);
  });

  it("skill-b is linked", async () => {
    await sharedCtx.assertLinked("skill-b", ["claude"]);
  });
});
```

**方式 B：Snapshot（复杂分支测试）**

```typescript
describe("complex workflow", () => {
  let baseCtx: E2EContext;

  beforeAll(async () => {
    baseCtx = await new E2EScenario()
      .withAgents("claude", "agents")
      .withInit()
      .withGitSource("big-repo", { skills: ["a", "b", "c", "d", "e"] })
      .setup();

    await baseCtx.run("syncskill", "install", baseCtx.getGitSourceUrl("big-repo"), "-y");
    await baseCtx.saveSnapshot("after-install");
  });

  it("test branch A", async () => {
    const ctx = await E2EScenario.fromSnapshot(baseCtx, "after-install").setup();
    // 独立副本，不影响其他测试
  });

  it("test branch B", async () => {
    const ctx = await E2EScenario.fromSnapshot(baseCtx, "after-install").setup();
    // 独立副本
  });
});
```

## 4. 测试执行

### 4.1 测试入口函数

```typescript
function e2eTest(
  name: string,
  fn: () => Promise<void>,
  options?: E2ETestOptions
): void;

interface E2ETestOptions {
  timeout?: number;        // 默认 60000ms
  network?: boolean;       // 需要网络，会被 test:e2e:local 跳过
  tags?: string[];
  skip?: boolean | (() => boolean);
  only?: boolean;
}

// 便捷变体
e2eTest.network = (name, fn) => e2eTest(name, fn, { network: true });
e2eTest.skip = (name, fn) => e2eTest(name, fn, { skip: true });
e2eTest.only = (name, fn) => e2eTest(name, fn, { only: true });
```

### 4.2 Vitest 配置

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    exclude: ['**/end2end/cases/**', '**/node_modules/**'],

    projects: [
      {
        name: 'unit',
        include: ['tests/unit/**/*.test.ts'],
      },
      {
        name: 'integration',
        include: ['tests/integration/**/*.test.ts'],
      },
      {
        name: 'e2e',
        include: ['tests/end2end/cases/**/*.test.ts'],
        exclude: ['**/network/**'],
        testTimeout: 60000,
        hookTimeout: 30000,
        setupFiles: ['tests/end2end/framework/setup.ts'],
      },
      {
        name: 'e2e-network',
        include: ['tests/end2end/cases/network/**/*.test.ts'],
        testTimeout: 120000,
        setupFiles: ['tests/end2end/framework/setup.ts'],
      },
    ],
  },
});
```

### 4.3 NPM Scripts

```json
{
  "scripts": {
    "test": "vitest run --project unit --project integration",
    "test:e2e": "vitest run --project e2e",
    "test:e2e:network": "vitest run --project e2e-network",
    "test:e2e:all": "vitest run --project e2e --project e2e-network",
    "test:e2e:verbose": "E2E_VERBOSE=1 vitest run --project e2e",
    "test:e2e:all:verbose": "E2E_VERBOSE=1 vitest run --project e2e --project e2e-network",
    "test:all": "vitest run",
    "test:e2e:grep": "vitest run --project e2e --grep"
  }
}
```

### 4.4 Verbose 模式

通过环境变量 `E2E_VERBOSE=1` 启用详细输出：

```bash
# 详细模式
npm run test:e2e:verbose

# 或
E2E_VERBOSE=1 npm run test:e2e
```

**Verbose 输出示例：**

```
────────────────────────────────────────────────────────────
▶ syncskill install https://github.com/blrbiran/syncskill_test -y
  cwd: /tmp/syncskill-e2e-abc123
────────────────────────────────────────────────────────────
📤 stdout:
    Cloning https://github.com/blrbiran/syncskill_test...
    Found 5 skills: syncskill_test, skill-alpha, skill-beta, example-one, example-two
    ✓ Installed 5 skills
📥 stderr:
    (none)
⏹ exit: 0
```

**测试失败时自动输出诊断：**

```
═══════════════════════════════════════════════════════════
📋 E2E TEST DIAGNOSTICS
═══════════════════════════════════════════════════════════

📁 Home directory: /tmp/syncskill-e2e-abc123
📁 Syncskill dir: /tmp/syncskill-e2e-abc123/.syncskill

📜 Command history:
  [2026-05-13T10:30:45.123Z]
    $ syncskill init -y --skip-skill
    exit: 0
  [2026-05-13T10:30:46.456Z]
    $ syncskill install https://github.com/blrbiran/syncskill_test -y
    exit: 1
    stderr: Error: Failed to clone repository...

═══════════════════════════════════════════════════════════
```

## 5. 测试仓库

### 5.1 syncskill_test 仓库结构

官方测试仓库：`git@github.com:blrbiran/syncskill_test.git`

```
syncskill_test/
├── SKILL.md                           # 根目录 skill
├── skills/
│   ├── skill-alpha/
│   │   └── SKILL.md
│   └── skill-beta/
│       └── SKILL.md
├── examples/
│   ├── example-one/
│   │   └── SKILL.md
│   └── example-two/
│       └── SKILL.md
└── README.md
```

**测试场景覆盖：**

| URL | subdir | 发现的 skills |
|-----|--------|---------------|
| `https://github.com/blrbiran/syncskill_test` | `.` | 5 个 |
| `.../tree/main/skills` | `skills` | 2 个 |
| `.../tree/main/skills/skill-alpha` | `skills/skill-alpha` | 1 个 |
| `.../tree/main/examples` | `examples` | 2 个 |
| `.../tree/main/examples/example-one` | `examples/example-one` | 1 个 |

### 5.2 Submodule 集成

```bash
# 添加 submodule
git submodule add git@github.com:blrbiran/syncskill_test.git tests/end2end/fixtures/syncskill_test

# 初始化 submodule
git submodule update --init

# 更新到最新
git submodule update --remote tests/end2end/fixtures/syncskill_test
```

### 5.3 可配置 URL

测试仓库 URL 可通过环境变量覆盖：

```typescript
export const TEST_REPO = {
  get baseUrl(): string {
    return process.env.E2E_TEST_REPO_URL
      ?? 'https://github.com/blrbiran/syncskill_test';
  },

  get sshUrl(): string {
    return process.env.E2E_TEST_REPO_SSH
      ?? 'git@github.com:blrbiran/syncskill_test.git';
  },

  localPath: 'tests/end2end/fixtures/syncskill_test',

  urls: {
    get root() { return TEST_REPO.baseUrl; },
    get skills() { return `${TEST_REPO.baseUrl}/tree/main/skills`; },
    get singleSkill() { return `${TEST_REPO.baseUrl}/tree/main/skills/skill-alpha`; },
    get examples() { return `${TEST_REPO.baseUrl}/tree/main/examples`; },
    get singleExample() { return `${TEST_REPO.baseUrl}/tree/main/examples/example-one`; },
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

**使用方式：**

```bash
# 默认
npm run test:e2e:network

# 自定义仓库
E2E_TEST_REPO_URL=https://github.com/myuser/my-test-repo npm run test:e2e:network

# CI 配置
env:
  E2E_TEST_REPO_URL: ${{ secrets.E2E_TEST_REPO_URL || 'https://github.com/blrbiran/syncskill_test' }}
```

## 6. 模拟远程服务器

通过本地 tmp 目录模拟远程服务器，测试 push/pull/sync 操作。

### 6.1 实现原理

```
/tmp/syncskill-e2e-xxx/          ← 本地 HOME
/tmp/syncskill-e2e-xxx-server-A/ ← 模拟服务器 A
/tmp/syncskill-e2e-xxx-server-B/ ← 模拟服务器 B
```

config.yaml 中配置为 localhost SSH 或直接用 fs.cp 模拟：

```yaml
servers:
  server-A:
    host: localhost
    user: $USER
    port: 22
    remote_syncskill_dir: /tmp/syncskill-e2e-xxx-server-A/.syncskill
```

### 6.2 使用示例

```typescript
e2eTest("push syncs local skill to server", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkill("my-skill", "# Local version\n")
    .withMockServer({ name: "dev-server", agents: { claude: "~/.claude/skills" } })
    .setup();

  await ctx.run("syncskill", "push", "dev-server", "-y");

  await ctx.assertServerHasSkill("dev-server", "my-skill");
  await ctx.assertServerSkillContent("dev-server", "my-skill", "# Local version\n");
});

e2eTest("pull fetches remote changes", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkill("my-skill", "# Version 1\n")
    .withMockServer({ name: "dev-server", skills: ["my-skill"] })
    .setup();

  await ctx.run("syncskill", "push", "dev-server", "-y");

  // 模拟远程修改
  await ctx.modifyServerSkill("dev-server", "my-skill", "# Version 2 (from server)\n");

  await ctx.run("syncskill", "pull", "dev-server", "-y");

  const content = await ctx.readFile(".syncskill/skills/my-skill/SKILL.md");
  expect(content).toBe("# Version 2 (from server)\n");
});

e2eTest("conflict detection", async () => {
  const ctx = await new E2EScenario()
    .withAgents("claude")
    .withInit()
    .withSkill("shared-skill", "# Original\n")
    .withMockServer({ name: "server", skills: ["shared-skill"] })
    .setup();

  await ctx.run("syncskill", "push", "server", "-y");

  // 双方都修改
  await ctx.writeFile(".syncskill/skills/shared-skill/SKILL.md", "# Local edit\n");
  await ctx.modifyServerSkill("server", "shared-skill", "# Remote edit\n");

  const result = await ctx.run("syncskill", "sync", "server", { expectedExitCode: null });
  ctx.assertOutputContains(result, "conflict");
});
```

## 7. 测试编写指南

详细的测试编写指南请参考：[E2E 测试编写指南](../e2e-test-guide.md)

包含：
- API 参考
- 常见测试模式
- 调试技巧
- 最佳实践
