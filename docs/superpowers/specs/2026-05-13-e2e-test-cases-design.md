# E2E 测试用例设计

> 状态：已批准
> 创建日期：2026-05-13

## 1. 概述

基于 `syncskill-design.md` 和 `e2e-test-design.md` 规范，设计 E2E 测试用例以覆盖用户关注的核心功能场景，防止功能回退。

**设计决策：**
- 测试组织：**Feature-based**（按功能分目录，匹配 spec 结构）
- Mock 策略：**Partial mocking**（pull/sync 不走真实 SSH，通过手动设置状态模拟）
- 测试范围：**Critical path focus**（每场景 2-3 个测试，共 ~17 个）

## 2. 测试用例清单

### 2.1 `install/` — 本地压缩包支持

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `install-local-archive.test.ts` | install local zip extracts and links | 安装本地 `.zip` 压缩包，验证：解压到 `~/.syncskill/sources/<name>/`、config 记录 `type: "local"` + `archive_path`、skills 正确发现并 link |
| `install-local-archive.test.ts` | source add local archive equivalent to install | `source add` 本地压缩包行为与 `install` 等效 |

**验证点：**
- `config.yaml` 中 source 的 `type` 为 `"local"`
- `archive_path` 指向原始压缩包路径
- Skills 被正确发现并加入 `links`
- `skills-registry.json` 中记录正确的 origin 和 path

### 2.2 `sync/` — Pull 目标路径

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `pull-target.test.ts` | pull places manual skill in skills dir | Pull 后 manual skill 放回 `~/.syncskill/skills/<name>/` |
| `pull-target.test.ts` | pull places git source skill in sources dir | Pull 后 git source skill 放回 `~/.syncskill/sources/<source>/...` |
| `pull-target.test.ts` | pull places http source skill in sources dir | Pull 后 http source skill 放回对应 sources 路径 |
| `pull-target.test.ts` | pull places local source skill in external path | Pull 后 local source skill 放回外部路径（如 `/home/user/my-tools/`） |

**Partial mocking 策略：**
```
1. 通过 E2EScenario 设置 skill 和 source
2. 手动写入 skills-registry.json 记录 skill 来源
3. 模拟 "pull 后" 的状态（直接写文件到目标位置）
4. 验证后续命令（link, update）能正确解析路径
```

**验证点：**
- `skills-registry.json` 中 `path` 字段与实际文件位置匹配
- `link` 命令能正确创建 symlink 指向该路径
- `source update` 能正确识别 skill 归属

### 2.3 `source/` — Update 命令

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `source-update.test.ts` | update git source fetches and resets | 更新 git source：执行 fetch + reset，更新后 skill 内容变化 |
| `source-update.test.ts` | update http source downloads to tmp first | 更新 HTTP source：下载到 tmp → 验证完整 → 替换原目录 |
| `source-update.test.ts` | update skips local and archive sources | Local source 和无 URL 的压缩包 source 被跳过，不报错 |

**验证点：**
- Git update：`git fetch --depth=1` + `git reset --hard`
- HTTP update：先下载到 `~/.syncskill/.tmp/`，验证后才替换
- 被删除的 skill 触发用户确认（或 `-y` 时自动处理）
- 更新报告显示哪些 skill 被修改/新增/删除

### 2.4 `source/` — Dirty 状态处理

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `source-update-dirty.test.ts` | update detects dirty git multiskill repo | 多 skill git 仓库有 dirty 文件时，提示所有受影响的 skills，选择 skip 时跳过整个 repo |
| `source-update-dirty.test.ts` | update detects dirty http source by hash | HTTP source：当前 skill hash 与 `last_update_hash` 不匹配时检测为 dirty |
| `source-update-dirty.test.ts` | update force creates backup | `--force` 更新 dirty source 时，先备份到 `~/.syncskill/backups/<source>/<skill>/` |

**Git dirty 检测：**
```bash
git status --porcelain
# 输出不为空 → dirty
# 解析修改文件 → 映射到受影响的 skills
```

**HTTP dirty 检测：**
```typescript
// 比较当前 skill hash 与 registry 中 last_update_hash
const currentHash = computeSkillHash(skillPath);
const recorded = registry.skills[skillName].last_update_hash;
if (currentHash !== recorded) { /* dirty */ }
```

**验证点：**
- Dirty 检测正确识别修改的 skills
- 多 skill 仓库：一个 skill dirty → 整个 repo 的所有 skills 都列出
- `--force` 时 backup 目录和 `_meta.json` 正确创建
- `-y` 时 dirty source 被 skip（不是强制覆盖）

### 2.5 `source/` — Stale Checkout 处理

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `source-stale-checkout.test.ts` | install handles stale checkout with url mismatch | 目录存在且是 git 仓库，但 remote URL 不匹配 → 删除后重新 clone |
| `source-stale-checkout.test.ts` | install handles stale checkout non-git dir | 目录存在但不是 git 仓库 → 删除后重新 clone |

**检测逻辑：**
```typescript
// 1. 检查目录是否存在
if (await pathExists(targetPath)) {
  // 2. 检查是否为 git 仓库
  const isGit = await isGitRepo(targetPath);
  if (!isGit) {
    // 非 git 目录 → 删除
    await rm(targetPath, { recursive: true });
  } else {
    // 3. 检查 remote URL 是否匹配
    const remoteUrl = await getGitRemoteUrl(targetPath);
    if (remoteUrl !== expectedUrl) {
      // URL 不匹配 → 删除
      await rm(targetPath, { recursive: true });
    }
  }
}
// 4. 执行 clone
await gitClone(url, targetPath);
```

**验证点：**
- Stale 目录被正确清理
- Clone 成功完成
- Config 和 registry 正确记录新 source
- 原有的 stale 文件不残留

### 2.6 `link/` — Link Reconcile

| 文件 | 测试名 | 描述 |
|------|--------|------|
| `link-reconcile.test.ts` | link all removes stale symlinks | `link --all`：skill 从 `["*"]` 改为 `["claude"]` 后，其他 agent 的 stale symlink 被清理 |
| `link-reconcile.test.ts` | link single skill removes its stale symlinks | `link <skill>`：只清理该 skill 的 stale symlinks，不影响其他 skills |
| `link-reconcile.test.ts` | link preserves real directories | Agent 目录中的实体目录（非 symlink）不被清理 |
| `link-reconcile.test.ts` | link preserves unmanaged symlinks | 非 syncskill 管理的 symlink（target 不在 syncskill 路径下）不被清理 |

**Stale symlink 判断规则：**
```typescript
// 1. 是 symlink
// 2. target 能被 resolveSkillPath() 解析（指向 syncskill 管理的路径）
// 3. skill 在 config.links 中存在，但该 agent 不在目标列表中
//    OR skill 不在 config.links 中（已完全移除）
```

**验证点：**
- Stale symlinks 被删除
- 实体目录保留
- 非 syncskill symlinks 保留
- 正确的 symlinks 不受影响

## 3. 测试文件结构

```
tests/end2end/cases/
├── install/
│   └── install-local-archive.test.ts      # 2 tests
├── sync/
│   └── pull-target.test.ts                # 4 tests
├── source/
│   ├── source-update.test.ts              # 3 tests
│   ├── source-update-dirty.test.ts        # 3 tests
│   └── source-stale-checkout.test.ts      # 2 tests
├── link/
│   └── link-reconcile.test.ts             # 4 tests (bonus: unmanaged symlink)
└── smoke/
    └── init.test.ts                       # existing
```

**总计：18 个新测试 + 3 个现有 smoke 测试 = 21 个 E2E 测试**

## 4. 框架扩展需求

现有 E2E 框架需要以下扩展以支持新测试：

### 4.1 E2EScenario 扩展

```typescript
// 新增方法
withHttpSource(name: string, config: HttpSourceConfig): this;
withLocalSource(name: string, config: LocalSourceConfig): this;

interface HttpSourceConfig {
  skills: string[];
  url?: string;  // 如果提供，记录为可更新的 HTTP source
}

interface LocalSourceConfig {
  skills: string[];
  path?: string;  // 外部路径，不在 ~/.syncskill/ 下
}
```

### 4.2 E2EContext 扩展

```typescript
// 新增方法
async writeRegistry(registry: SkillsRegistry): Promise<void>;
async modifySkillContent(skillPath: string, content: string): Promise<void>;
async createStaleGitDir(name: string, wrongUrl: string): Promise<void>;
async createStaleNonGitDir(name: string): Promise<void>;
async assertBackupExists(sourceName: string, skillName: string): Promise<void>;
async assertSymlinkTarget(skill: string, agent: string, expectedTarget: string): Promise<void>;
```

### 4.3 Fixtures 扩展

```typescript
// fixtures/http.ts - 创建模拟 HTTP source（解压后的目录结构）
async function createHttpSourceFixture(
  fixturesDir: string,
  name: string,
  config: HttpSourceConfig
): Promise<HttpSourceFixture>;

// fixtures/stale.ts - 创建 stale checkout 场景
async function createStaleGitCheckout(
  sourcesDir: string,
  name: string,
  wrongRemoteUrl: string
): Promise<void>;

async function createStaleNonGitDir(
  sourcesDir: string,
  name: string
): Promise<void>;
```

## 5. 实现注意事项

### 5.1 Partial Mocking 边界

| 真实执行 | Mock/手动设置 |
|----------|---------------|
| `syncskill init` | — |
| `syncskill install` (local archive) | — |
| `syncskill link` | — |
| `syncskill source add` | — |
| `syncskill source update` | Git remote (使用本地 bare repo) |
| `syncskill push/pull` | SSH transport → 手动写文件模拟 |

### 5.2 测试隔离

- 每个测试使用独立的 temp HOME 目录
- Git source fixtures 使用本地 bare repo（`file://` URL）
- 不依赖网络（除非标记 `network: true`）

### 5.3 断言策略

优先使用 E2EContext 提供的断言方法：
- `assertLinked()` / `assertNotLinked()`
- `assertIsSymlink()` / `assertIsRealDir()`
- `assertFileExists()` / `assertFileNotExists()`
- `assertOutputContains()` / `assertOutputMatches()`

新增断言按需添加到 E2EContext。
