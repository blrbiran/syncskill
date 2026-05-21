# Syncskill — TypeScript 实现设计

> 更新日期：2026-05-21
> 状态：v2 草稿（合并冗余命令、瘦身 registry、简化 dirty 处理、plan-then-execute 全局化、补齐 §11 AI 契约）

**相关文档**：
- [E2E 测试框架设计](e2e-test-design.md) — End-to-End 测试框架规范

## 1. 概述

`syncskill` AI Agent Skills 同步工具。核心用途：管理多 AI Agent（Claude/Hermes/Qoder 等）的 Skill 文件，在本地开发机和远程服务器之间双向同步。

**设计约束**：
- 兼容 Node 20+
- 运行时依赖 `yaml` + `commander` + `@inquirer/prompts` + `compressing` 四个 npm 包（`@inquirer/core` 通过 `@inquirer/prompts` 间接引入），其余全部 Node 原生 API
- ESM 优先，远程 receiver 脚本也用 `.mjs`（Node 20+ 原生运行）
- Hash 算法与 Python 版本完全兼容（MD5 + sorted 文件遍历）
- 跨平台：macOS / Linux / Windows
- CLI 命令名：`syncskill`
- 远程部署目录：`~/.syncskill/`
- **所有用户交互信息使用英文**

**v2 关键变更**（2026-05-21）：

- §3.0 / §3.0.B：新增 flag 语义统一定义 + plan-then-execute 全局协议
- §3.1：合并 `install`/`source add`、`update`/`source update`、`unlink`/`link clear`；删除 `server probe`、`refresh --status`；`scan --migrate` 重命名 `--migrate-unmanaged`
- §3.5：`install` 内化 source add 逻辑
- §3.6：明确 link 双轨设计（人类用 edit/add/remove/clear，AI agent 用 set + apply）
- §3.8：删除 `update-history.json` / `source restore` / `~/.syncskill/backups/`；dirty 默认 abort + hint
- §3.8（registry）：skills-registry.json v2 schema 瘦身到 ignored 元信息 + http baselines
- §10：registry 诊断 4 码合并为 1 码（REGISTRY_CORRUPT）；删 `--rebuild-registry`
- §11.6：补齐 10 个命令的 data schema；明确 plan/result 可追溯、data.changes 强制约定
- §11.8–11.11：新增环境变量表、stdout/stderr 契约、CLI self-introspection、JSON-only config（自动迁移）

## 2. 项目结构

```
syncskill/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── LICENSE
├── docs/
│   ├── README.md                  # 文档索引
│   ├── design-guide.md            # 架构设计
│   ├── config-guide.md            # 配置参考
│   └── usage-guide.md             # 使用手册
├── config.example.yaml
├── skills/                          # 内置 skill
│   └── syncskill/
│       └── SKILL.md                 # syncskill 自身的 skill 定义
└── src/
    ├── index.ts                   # CLI 入口 (commander) — 命令路由 + preAction 钩子
    ├── repo.ts                    # init 命令：目录结构 + 配置模板
    ├── install.ts                 # install 命令：内置 skill 安装、从 URL/路径安装
    ├── linker.ts                  # 软链接管理（三级降级）+ expandLinkTargets
    ├── source.ts                  # 外部来源顶层入口（re-export source/ 子模块）
    ├── refresh.ts                 # 全局自动刷新钩子
    ├── commands/                  # 命令动作模块（从 index.ts 拆分）
    │   ├── index.ts               # Barrel — 注册所有命令到 program
    │   ├── config.ts              # config 命令
    │   ├── dashboard.ts           # 无参数调用的仪表盘
    │   ├── diff.ts                # diff 命令
    │   ├── doctor.ts              # doctor 命令
    │   ├── init.ts                # init 命令
    │   ├── install.ts             # install 命令
    │   ├── link.ts                # link/unlink 命令
    │   ├── refresh.ts             # refresh 命令
    │   ├── remote.ts              # remote 命令
    │   ├── resolve.ts             # resolve 命令
    │   ├── scan.ts                # scan 命令
    │   ├── server.ts              # server 命令
    │   ├── skill.ts               # skill 命令
    │   ├── source.ts              # source 命令
    │   ├── status.ts              # status 命令
    │   ├── sync.ts                # push/pull/sync 命令
    │   └── update.ts              # update 命令
    ├── config/
    │   ├── types.ts               # TypeScript 类型定义 (SyncSkillConfig, SourceConfig, etc.)
    │   ├── config.ts              # JSON 加载（含 YAML 自动迁移）+ 自动检测 agent 目录
    │   ├── config-ui.ts           # 交互式 TUI 配置菜单 (@inquirer/prompts)
    │   ├── config-doctor.ts       # 配置健康诊断与修复 (agents/links/sources/registry)
    │   └── matrix-editor.ts       # 二维矩阵编辑器组件 (@inquirer/core createPrompt)
    ├── core/
    │   ├── manifest.ts            # MD5 hash + manifest 读写/比较
    │   ├── sync_engine.ts         # push/pull/sync 核心流程
    │   ├── sync-utils.ts          # 同步层工具函数（getIncludedSkills, computeLocalHashes, buildDirectionMap）
    │   ├── transport.ts           # SSH/rsync 传输 + 降级
    │   ├── conflict.ts            # 三路冲突检测与解决
    │   ├── server.ts              # 服务器配置格式化输出
    │   ├── skills-registry.ts     # 统一 skills 注册表 (skills-registry.json)
    │   └── registry-builder.ts    # v2 registry 重建（仅 ignored + http_baselines；REGISTRY_CORRUPT 自动恢复）
    ├── source/                    # 外部来源子模块（从 source.ts 拆分）
    │   ├── index.ts               # Barrel — re-export 所有公共 API
    │   ├── core.ts                # 核心来源操作（installFromSource, runSourceUpdate）
    │   ├── detect.ts              # 输入类型检测（detectSourceInput）
    │   ├── dirty.ts               # Dirty 检测逻辑
    │   ├── discover.ts            # Skill 发现（discoverSourceSkills）
    │   └── history.ts             # （已废弃：update-history.json 已移除，见 §3.8）
    ├── utils/
    │   ├── utils.ts               # 共享工具函数 (isNotFoundError, pathExists)
    │   ├── archive.ts             # 归档检测 + 跨平台解压 (compressing → CLI fallback)
    │   └── backup.ts              # HTTP source --force 更新时的 sidecar 备份 (.syncskill-pre-update-backup)
    └── receiver/
        ├── bootstrap_remote.sh    # 远程部署脚本
        └── sync_receiver.mjs      # 远程零依赖接收脚本

~/.syncskill/                    # init 后创建的本地数据目录
├── config.json                    # 用户配置（JSON 格式，见 §11.11）
├── skills/                        # 手动管理的 skill
├── manifests/                     # 各服务器同步状态 (JSON per server)
│   └── <server>.json
├── manifest_history.json          # hash 变更历史
├── skills-registry.json           # skill 注册表（来源映射 + 忽略状态，统一管理）
├── sources/                       # 外部来源 clone/下载目录（git clone、HTTP 解压）
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

**通用设计原则**：

- **CLI 输出只显示变化**：命令执行后只输出实际发生变化的条目（新增、删除、错误等），不输出未变化的条目（如 already-linked）。如果完全没有变化，输出一条简短的汇总消息（如 `All links are up to date.`）。`--dry-run` 模式同样遵循此原则，显示"将要变化"的条目。
- **别名命令复用核心逻辑**：当一个命令是另一个命令的别名或组合（如 `install` = `source add` + `auto-link`），禁止重新实现持久化逻辑，必须复用核心命令的写入路径。这确保核心逻辑发生变更时，所有入口点自动获得修复。
- **Skill/Source 变更的不变量**：所有会改变 skill 或 source 状态的入口点（`install`、`update`、`scan`）都必须保证以下三个副作用完整执行：
  1. config.sources 持久化（新增/修改 source 条目）
  2. config.links 持久化（新增 skill 映射）
  3. skills-registry.json 刷新（保证 registry 与实际状态一致）

### 3.0 Flag 语义统一定义

所有命令共享同一套全局 flag 语义。本节是后续所有命令章节的语义基准；具体命令章节引用本节而非重复定义。

#### 3.0.1 `--dry-run`

| 项 | 定义 |
|---|---|
| 含义 | 不做任何 fs 写、不发起任何网络请求、不修改任何外部状态 |
| 允许例外 | 只读探查（`git status --porcelain`、`stat`、`ls`、本地 hash 计算）—— 用于产出 plan |
| 输出（text 模式） | 显示"将要发生的变更"，每行前缀 `[dry-run]` |
| 输出（json 模式） | 完整 plan JSON，等价 `--plan` |
| 与 `--plan` 关系 | `--dry-run` ≡ `--plan` + text 渲染；`--json --dry-run` ≡ `--json --plan` |

#### 3.0.2 `-y` / `--yes`

| 项 | 定义 |
|---|---|
| 含义 | 所有 prompt 选**文档化的 safe default** |
| 强制约定 | spec 中每个 prompt 必须显式标注 "default under -y"；该默认值同时出现在 plan 的 `unresolved[].default_under_y` 字段 |
| 不暗示 | 不暗示 `--force`；不暗示 `--cross-server-policy=first-wins`；不暗示 `--on-conflict=keep-local` |
| 适用范围 | 仅影响 prompt 选择，不改变命令的破坏性行为 |

#### 3.0.3 `--force`

| 项 | 定义 |
|---|---|
| 含义 | **单一含义** = "绕过 dirty 保护"（覆盖 dirty source、强制 `git reset --hard` 等） |
| 不暗示 | 不暗示 `-y`（force 仍可能弹其他确认）；不暗示文件删除 |
| 不用于 | 删除文件用专门 verb 或显式 `--delete-files`；跳过确认用 `-y` |

#### 3.0.4 `--no-interactive`

| 项 | 定义 |
|---|---|
| 含义 | 禁止任何 prompt 出现 |
| 与 `-y` 关系 | 独立。`-y` = "选默认"，`--no-interactive` = "禁止问"。可单独用、可组合 |
| 不暗示 | 不暗示 `--json` |
| 触发行为 | 单独使用：遇 prompt → 输出 `E_NEEDS_INPUT`，exit 4 |

#### 3.0.5 组合矩阵

| `--no-interactive` | `-y` | 遇到 prompt 时 |
|---|---|---|
| ✗ | ✗ | 正常交互（默认） |
| ✗ | ✓ | 自动选 safe default，无 prompt 出现 |
| ✓ | ✗ | 输出 `prompt` 事件 + `E_NEEDS_INPUT`，exit 4 |
| ✓ | ✓ | 自动选 safe default，无 prompt 出现（最 AI-friendly 组合） |

| `--force` | dirty source 时 |
|---|---|
| ✗ | skip + warning，exit 6 |
| ✓ | 执行更新（git reset --hard / http overwrite） |

| `--dry-run` 组合 | 行为 |
|---|---|
| `--dry-run -y` | plan 显示"将要做"（含 `-y` 下的默认决策） |
| `--dry-run --force` | plan 显示"force 下将要做"（dirty source 也算入） |
| `--dry-run --no-interactive` | plan 照常输出，遇 unresolved 也列出（plan 阶段允许 unresolved 存在，不 exit 4） |

### 3.0.B Plan-then-Execute 全局协议

所有 mutate 状态的命令遵循同一份 plan/execute 契约。本节定义协议；具体命令章节引用本节而非重复定义。

#### 3.0.B.1 通用 flag

| Flag | 行为 |
|------|------|
| `--plan` | 只跑 plan 阶段，输出结构化 plan 后 exit 0 |
| `--plan-file <path>` | 写 plan 到文件，仍继续 execute |
| `--apply <path>` | 跳过 plan，直接执行 `<path>` 中预生成的 plan |
| `--apply-stdin` | 从 stdin 读 plan，等价 `--apply` 的流式版本 |
| `--resolutions <path>` | 提供决议文件，绕过所有 prompt |
| `--resolutions-stdin` | 从 stdin 读决议 JSON，避免临时文件 |

`--dry-run`（§3.0.1）等价 `--plan` + text 渲染；两者共享同一份 plan-builder 函数。

#### 3.0.B.2 通用 plan schema

```json
{
  "version": 1,
  "command": "install",
  "generated_at": "2026-05-21T12:00:00Z",
  "actions": [
    { "op": "clone", "url": "...", "to": "..." },
    { "op": "register-source", "name": "my-repo", "type": "git" },
    { "op": "link-skill", "skill": "skill-a", "agents": ["claude", "cursor"] },
    { "op": "create-symlink", "from": "...", "to": "..." }
  ],
  "unresolved": [
    {
      "kind": "skill-selection",
      "candidates": [{"name": "skill-a", "path": "..."}],
      "default_under_y": ["skill-a", "skill-b"]
    }
  ],
  "warnings": []
}
```

`actions[].op` 与 `unresolved[].kind` 取值由具体命令定义，但字段名稳定（视作 API 表面）。

#### 3.0.B.3 应用范围

| 命令 | plan 应列出 |
|------|------------|
| `install <url>` / `install --self` | clone/download + 待 link 的 skill 列表 + skill-selection 决议项 |
| `update [name]` | 哪些 source 会更新、dirty 状态、删除/新增的 skill |
| `source remove <name>` | 待删 config 条目 + 待删文件路径 + 待清理 symlink |
| `scan` | 待 register 的新 skill + 待迁移的 unmanaged skill |
| `link set/add/remove/clear/apply` | config 前后 diff + reconcile 的 symlink 增删 |
| `sync` / `push` / `pull` | 远程 delta + cross-server / content / deletion 未决项（§3.9 详） |
| `resolve <skill>` | 待覆盖方向 + 涉及 server |
| `doctor --fix` | 待修复项列表 |

#### 3.0.B.4 硬性约束（保护人类体验）

1. **plan 阶段不允许做昂贵操作**：clone / download 必须发生在 execute 阶段。plan 只做轻量探查（`git ls-remote`、`fs.stat`、本地 hash 计算）。否则用户回车后会"卡住"。
2. **plan 阶段不允许 prompt**：plan 是 `(config, args, fs state) → Plan` 的纯函数。prompt 发生在"plan 构建完成 → execute 开始前"这层，由 TTY + flag 组合决定怎么收集 resolutions。
3. **TTY + 无 flag 时 prompt 体感与今天一致**：用 `@inquirer/prompts` 原生组件，不让用户感知底层有 plan 抽象。

#### 3.0.B.5 默认人类流程（无 flag）

```
$ syncskill install https://github.com/user/repo

[ 内部 ]
  1. buildPlan() — 轻量探查（git ls-remote、scan SKILL.md）
                 → unresolved = [{kind:"skill-selection", candidates:[...]}]
  2. 检测 unresolved + TTY + 无 --no-interactive
     → 用原生 inquirer prompt 询问，把答案填回 resolutions
  3. executePlan(plan, resolutions) — 真正 clone + 写盘 + link

[ 用户看到 ]
  Cloning https://github.com/user/repo...
  Found 5 skills. Select to install: [matrix]
  ✓ Installed 3 skills
  ✓ Linked to: claude, cursor
```

跟今天 install 行为一致。

#### 3.0.B.6 AI agent 标准工作流

```bash
# 探查
syncskill --json --plan install https://github.com/...

# 离线决策后携带决议执行
syncskill --json --no-interactive \
  --resolutions-stdin install https://github.com/... <<< "$resolutions"

# 或直接重放上一步生成的 plan
syncskill --json --apply plan.json
```

### 3.1 `index.ts` — CLI 入口

使用 `commander` 实现。命令列表：

**无参数调用**

| 命令 | 说明 |
|------|------|
| `syncskill` | 显示仪表盘摘要（不触发网络请求） |

仪表盘输出示例：
```
Syncskill Status
────────────────────────────────────────

Skills:   12 total (10 linked, 2 ignored)
Sources:  3 (my-repo, skill-pack, local-tools)
Agents:   claude ✓  cursor ✓  hermes ✓

Servers:  (based on cached manifests, no network requests)
  prod     ✓ in-sync
  dev      ⚠ 2 skills pending
  staging  ? never synced

Health:   ✓ No issues

Quick actions:
  syncskill link          Edit skill-agent mappings
  syncskill update        Update all sources
  syncskill push          Push changes to servers

Run `syncskill --help` for all commands.
```

仪表盘 Servers 状态数据来源：
- 基于本地缓存的 manifest（`~/.syncskill/manifests/<server>.json`，3-field 模型直接含 `local_hash`/`remote_hash`/`recorded_hash`）
- 对每个 skill 重新计算当前文件的 hash，调用 `classifySkillDelta` 得到 action
- `pending` 计数 = action ≠ `skip` 的 skill 数（push / pull / conflict / new 不区分方向；细节用 `status` / `diff` 查看）
- 无缓存（从未 sync 过）→ 显示 `? never synced`
- 不触发网络请求，显示的是上次 sync/refresh 时的快照

**初始化与安装**

| 命令 | 说明 |
|------|------|
| `init [--skip-scan] [-y/--yes]` | 创建 `~/.syncskill/` 目录结构和 config.json；默认安装 syncskill skill（无需询问） |
| `install` | TTY 下交互式菜单，让用户选择安装来源；非 TTY → E_NEEDS_INPUT + exit 4 |
| `install --self` | 安装内置 syncskill skill |
| `install <url-or-path>` / `i <url-or-path>` | 安装外部来源（旧 `source add` 的行为合并到此） |

`install` 完整参数：

- `--self`：安装内置 syncskill skill
- `--name <name>`：指定 source 名称
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--type git|http|local`：强制 source 类型（detectSourceInput 99% 情况下可推断）
- `--branch <branch>`：Git 分支（默认自动检测）

通用 flag 见 §3.0；plan/execute 行为见 §3.0.B。

**Link 管理**

链接命令双轨：人类用 verb（`edit`/`add`/`remove`/`clear`/`apply`）表达增量意图；AI agent 用 declarative（`set` + `apply`）表达终态。

| 命令 | 模式 | 受众 | 说明 |
|------|------|------|------|
| `link edit [skill]` | 交互（需 TTY） | 人类 | 进入矩阵编辑器 |
| `link add <skill> <agent>...` | 增量 | 人类 | 在 `config.links[skill]` 上追加 agents |
| `link remove <skill> <agent>...` | 增量 | 人类 | 从 `config.links[skill]` 移除 agents |
| `link clear <skill>` | 增量 | 人类 | 删除该 skill 的所有 link + 从 config 移除 |
| `link apply` | 批量 | 人类 / AI | 按 config reconcile：创建/删除 symlink |
| `link set <skill> <agent>...` | 声明式 | AI agent | 覆盖 `config.links[skill]` 为给定 agents |
| `link list` / `link ls` | 只读 | 人类 / AI | 显示链接状态矩阵 |

**`unlink <skill>`**：顶级别名，等价 `link clear <skill>`。

**AI agent 推荐用法**：先 `link set <skill> <agents>...` 写 config（declarative），再 `link apply` 执行 reconcile。避免用 `add`/`remove` —— 这些是人类 verb，多次调用会被多个 agent 互相覆盖。

**子选项**：

- `-v` / `--verbose`（仅 `list`）：显示文字状态而非符号
- 通用 flag 见 §3.0；plan 行为见 §3.0.B

**通配符语义（`'*'`）**：

`link set <skill> '*'` 写入 `["*"]`：**通配符语义**——将来新增的 agent 自动包含。希望"当前快照"用显式列表。

**参数校验**：所有 `<agent>` 参数必须在 `config.agents` 中存在（除 `'*'`），否则报 `E_AGENT_NOT_CONFIGURED` + exit 2。

**`link list` 与同名 skill 歧义**：保留子命令名（`list`/`ls`/`edit`/`add`/`remove`/`clear`/`apply`/`set`）始终优先匹配子命令。同名 skill 通过 `link edit <skill>` 操作。注：`unlink` 是顶级命令（等价 `link clear`），不在 link 子命令命名空间，因此 skill 名为 `unlink` 时不冲突——`syncskill unlink unlink` 即"unlink 名为 unlink 的 skill"。

**`link edit` 是唯一交互式子命令**：非 TTY 下报错 `E_NEEDS_INPUT` + exit 4，hint 指引到 `link set` / `link add` / `link clear`。不接受 `--dry-run`（用 `link set --dry-run`）。

**Source 管理**

| 命令 | 说明 |
|------|------|
| `source list` / `source ls` | 列出来源 |
| `source remove <name> [--force]` | 移除外部来源（交互式选择处理方式；`--force` 直接 Remove completely） |

注：`source add` 和 `source update` 已移除，功能分别由 `install`（§3.5）和顶级 `update` 承担。

**Update 命令**

| 命令 | 说明 |
|------|------|
| `update [name]` | 更新指定来源；无参数 = 更新所有可更新的 source |

`update` 完整参数：

- `[name]`：指定要更新的 source 名称
- 通用 flag 见 §3.0；plan 行为见 §3.0.B
- `--force`：强制更新 dirty source（git 走 `git stash`；http 写 `.syncskill-pre-update-backup` sidecar，详见 §3.8）

注：dirty source 默认 skip + warning（exit 6），hint 字段输出"如何手动备份"的可执行命令片段。`--force` 是 escape hatch，多数情况推荐用户用原生 `git stash` 处理后再跑 `update`。

**Scan 扫描**

| 命令 | 说明 |
|------|------|
| `scan [--migrate-unmanaged]` | 扫描 sources 中新增的 skill；同时检测 agent 目录中未纳管的 skill。`--migrate-unmanaged` 同时迁移未纳管 skill 到 `~/.syncskill/skills/` |

通用 flag 见 §3.0；plan 行为见 §3.0.B。

**Server 管理**

| 命令 | 说明 |
|------|------|
| `server` | 进入服务器管理菜单 |
| `server list` / `server ls` | 列出已配置的远程服务器 |
| `server show <name>` | 显示指定服务器的配置详情 |

注：原 `server probe` 删除——其功能（SSH 连通性、receiver 部署状态、最后同步时间）已由 `status <server>` 和 `refresh <server>` 覆盖。

**Remote 管理**

| 命令 | 说明 |
|------|------|
| `remote` | 进入 skills × servers 矩阵编辑器 |

**同步操作**

| 命令 | 说明 |
|------|------|
| `push [server] [--all] [--timeout <s>]` | 推送到远程；无参数时交互式选择服务器 |
| `pull [server] [--all] [--timeout <s>]` | 从远程拉取；无参数时交互式选择服务器 |
| `sync [server] [--all] [--timeout <s>]` | 双向同步：pull → refresh → push 串行执行；带 server 参数时只针对该服务器，否则覆盖所有 servers |
| `status` | 显示所有 tracked manifests 的同步状态 |
| `diff <server>` | 显示指定服务器的待同步变更 |
| `resolve <skill>` | 交互式解决冲突 |
| `resolve <skill> --local` | 保留本地版本，覆盖远程 |
| `resolve <skill> --remote` | 保留远程版本，覆盖本地 |
| `resolve <skill> --diff` | 只显示 hash 差异 |
| `refresh [server]` | 刷新本地 + 远程 manifest 后显示状态（带 `[server]` 时只针对该服务器） |
| `refresh --local` | 只刷新本地 hash，不显示状态 |
| `refresh --remote` | 只刷新远程 hash，不显示状态 |

注：上述命令的 `-y/--yes` 和 `--dry-run` 是全局参数（见下方"全局参数"），各命令签名不重复列出。

**Config 配置**

| 命令 | 说明 |
|------|------|
| `config` | 进入交互式配置主菜单 |
| `config show` | 打印当前配置（JSON 格式） |
| `config set <key> <value>` | 设置单个配置项 |
| `config set --show-paths` | 显示所有可配置的路径 |

**全局参数**：

人类交互层（语义见 §3.0）：

- `--no-refresh`：跳过自动刷新
- `-y` / `--yes`：同意所有 prompt（safe default）
- `--dry-run`：预览变更但不执行（等价 `--plan` + text 渲染）
- `--force`：绕过 dirty 保护

机器/脚本接入层（见 §11 + §3.0.B）：

- `--json`：所有输出走结构化 JSONL（与人类文本互斥）
- `--no-interactive`：禁止任何 prompt
- `--quiet` / `-q`：仅输出错误与最终结果
- `--plan`：只跑 plan 阶段并输出（见 §3.0.B）
- `--plan-file <path>`：写 plan 到文件，仍继续 execute
- `--apply <path>` / `--apply-stdin`：执行预生成 plan
- `--resolutions <path>` / `--resolutions-stdin`：携带决议绕过 prompt
- `--config <path>`：覆盖 config 文件路径
- `--sync-dir <path>`：覆盖 `~/.syncskill/` 目录
- `--cwd <path>`：切换工作目录

所有命令（除 `init`、`config`、`refresh`、`doctor`）执行前在同一个 `preAction` 钩子里自动调用 `autoDiagnoseConfig()` + `autoRefreshManifests()`。两个钩子排除集相同（详见 §10.5）。

**3+ 服务器提示**：当服务器数量 ≥ 3 时，以下场景打印提示：

- `init` 命令结束后
- 退出 `server` UI 时（如果服务器数量从 <3 变为 ≥3）

```
Note: With 3+ servers, auto-refresh may be slow.
Use --no-refresh to skip, then run `syncskill refresh` manually.
```

### 3.2 `config.ts` — 配置加载与验证

- 加载 `~/.syncskill/config.json`
- 自动检测本地 agent **父目录**（存在即添加）。**检测的是 agent 的根目录是否存在**（例如 `~/.claude/`），而不是 `skills/` 子目录。这是合理场景：用户安装 Claude 但还没创建过 `~/.claude/skills/` 子目录时，agent 也应该被注册：

| Agent | 检测父目录 | 链接路径 |
|-------|-----------|---------|
| `claude` | `~/.claude/` | `~/.claude/skills` |
| `agents` | `~/.agents/` | `~/.agents/skills` |
| `cursor` | `~/.cursor/` | `~/.cursor/skills` |
| `windsurf` | `~/.windsurf/` | `~/.windsurf/skills` |
| `codex` | `~/.codex/` | `~/.codex/skills` |
| `gemini` | `~/.gemini/` | `~/.gemini/skills` |
| `antigravity` | `~/.gemini/antigravity/` | `~/.gemini/antigravity/skills` |
| `kiro` | `~/.kiro/` | `~/.kiro/skills` |
| `augment` | `~/.augment/` | `~/.augment/skills` |
| `amp` | `~/.config/agents/` | `~/.config/agents/skills` |
| `cline` | `~/.cline/` | `~/.cline/skills` |
| `opencode` | `~/.config/opencode/` | `~/.config/opencode/skills` |
| `qwen` | `~/.qwen/` | `~/.qwen/skills` |
| `openclaw` | `~/.openclaw/` | `~/.openclaw/skills` |
| `hermes` | `~/.hermes/` | `~/.hermes/skills` |
| `qoder` | `~/.qoder/` | `~/.qoder/skills` |
| `aone_copilot` | `~/.aone_copilot/` | `~/.aone_copilot/skills` |

`agents` 与其它 agent 走相同检测逻辑，无特殊分支：检测 `~/.agents/` 是否存在，存在即注册，链接路径是 `~/.agents/skills`。

- **链接时 mkdir**：`linker.createLink()` 创建链接前，若 `<agent_link_path>` 父目录（如 `~/.claude/skills/`）不存在，自动 `mkdirSync({ recursive: true })`。这样首次链接到任意 agent 都不会因为缺少 `skills/` 子目录失败。
- **Default Link Targets 计算**：`install`、`init` 迁移、`scan` 等场景自动为新 skill 计算默认 link target。实现拆分为两个函数以分离关注点：
  - **`computeDefaultLinkTargets(config)`**：纯函数，根据 config 计算默认 link target 数组。规则：
    1. 默认 target 为 `["agents"]`（即 `~/.agents/skills/`，跨客户端标准目录）
    2. 遍历已检测到的 agent，若该 agent 属于 `private_agents`（不读取共享目录），则追加到 target 列表
    3. 返回最终 target 数组，如 `["agents", "cursor", "kiro"]`
  - **`ensureSharedSkillsDirectory(homeDir)`**：有副作用的函数，在必要时创建 `~/.agents/skills/` 目录、写入 `config.agents.agents` 字段并 `saveConfig()`。输出提示：
     ```
     Created ~/.agents/skills/
       This is the standard shared skills directory for agents that support it.
       Skills linked here are available to: claude, windsurf, codex, ...
     ```
     （仅首次创建时打印此提示；幂等：第二次调用不会重复打印或重复落盘）
  - **`ensureDefaultLinkTargets(config, homeDir)`**：调用方便利包装。等价 `ensureSharedSkillsDirectory(homeDir)` + `computeDefaultLinkTargets(config)`：先保证 `~/.agents/skills/` 存在（必要时创建并落盘），再返回纯计算的目标数组。`install` / `init` 迁移 / `scan` / `update` 等需要"自动给新 skill 算默认 link 目标并立刻可用"的入口点统一调用此包装；不需要副作用的纯查询请直接用 `computeDefaultLinkTargets`。
- **`private_agents` 配置**：不读取 `~/.agents/skills/` 共享目录的 agent 列表，需要单独 link 到其专有目录。这些 agent 只读取自己的 `~/.<agent>/skills/` 目录。
  - **默认值**（硬编码）：`["claude", "codex", "gemini", "cursor", "kiro", "augment", "cline", "hermes"]`
  - **config.json 初始化**：`init` 命令生成 `config.json` 时，自动写入 `private_agents` 字段的默认值，方便用户查看和修改
  - **用户覆盖**：可在 `config.json` 中修改 `private_agents` 字段（完全覆盖，非 merge）：
    ```json
    {
      "private_agents": [
        "claude", "codex", "gemini", "cursor",
        "kiro", "augment", "cline", "hermes",
        "my-custom-agent"
      ]
    }
    ```
  - **合并逻辑**：`finalList = config.private_agents ?? DEFAULT_PRIVATE_AGENTS`（硬编码作为 fallback，防止用户误删 config 中的字段）
- 验证必填字段：`version`, `agents`, `links`
- 解析通配符 `*` → 展开为所有 agent
- `getSyncDir()` 返回 `~/.syncskill/` 路径，所有其他路径（config、skills、manifests、history）均基于此计算

### 3.3 `config-ui.ts` — 交互式配置编辑

使用 `@inquirer/prompts` + `@inquirer/core` 实现 TUI（终端用户界面）交互式编辑配置。

**`config`（无参数）**：交互式菜单主界面
```
Configuration Menu
├─ agents — Manage agent directories
├─ links — Manage skill to agent mappings (matrix editor)
├─ servers — Manage remote sync servers
├─ sources — Manage external sources (git/http/local)
├─ remote — Manage skills → servers sync mappings (matrix editor)
└─ conflict_resolution — Conflict resolution strategy
```

每个子菜单使用 `select` / `input` / `checkbox` 实现增删改：
- **agents 管理**：列出已检测/手动配置的 agent，支持 `add` / `remove` / `auto-detect`（重新运行 detectAgents）
- **links 管理**：使用矩阵编辑器（见下方），skills × agents 二维网格
- **servers 管理**：列出远程服务器（host/user/port/ssh-key），支持 `add` / `remove` / `edit` / `test-connection`（SSH 连通性测试）。`add` 流程中，输入 server name 后自动解析 `~/.ssh/config`，若找到匹配 Host 则提取 HostName/IP、Port、User、IdentityFile 等字段供用户确认。每个 server 还支持配置远程 agents（远程机器上的 AI agent 目录映射）
- **remote 管理**：使用矩阵编辑器，skills × servers 二维网格，控制哪些 skill 在哪些远程服务器上生效
- **sources 管理**：与 `install` / `update` / `source list` / `source remove` 命令对等，提供交互式引导添加
- **conflict_resolution 管理**：下拉选择 `manual` / `keep-local` / `keep-remote`

**所有子菜单均支持 Esc 返回功能**：
- 统一行为：从子菜单进入的嵌套层级中，Esc 始终返回上一级；在主菜单（第一层）按 Esc 退出 CLI
- 所有修改即时生效，Esc 退出子菜单时自动调用 `saveConfig()` 写入 config.json

**links 保存时的通配符优化**：保存 links 配置时，如果某个 skill 选中了所有已配置的 agents，写入 `["*"]` 而不是逐个列出所有 agent 名称。

**矩阵编辑器（Matrix Editor）** — `@inquirer/core` `createPrompt` 自定义组件

使用 `createPrompt` + `useKeypress` 实现二维网格交互。渲染示例：

```
  Skills → Agent Assignment       Page 1/3

  Skill              claude     hermes     qoder
  ──────────────────────────────────────────────────────
→ skill-one          [✓]        ·          ✓
  skill-two           ·         ✓          ·
```

**单元格显示规则**：
- 当前选中单元格：`[✓]`（已选）或 `[·]`（未选）— 使用方括号高亮
- 其他单元格：` ✓ `（已选）或 ` · `（未选）— 使用空格对齐

**快捷键**：

| 快捷键 | 功能 |
|--------|------|
| `↑/↓` | 上下移动行光标 |
| `←/→` | 左右移动列光标 |
| `Space` | 切换当前单元格选中/未选中 |
| `Tab` | 切换并移到下一列 |
| `r` | 全选/全不选当前行（row，skill 的所有 agents） |
| `c` | 全选/全不选当前列（column，agent 的所有 skills） |
| `/` | 搜索 skill 名称并跳转 |
| `g` | 跳转到第一行 |
| `G` | 跳转到最后一行 |
| `Page Up/Down` 或 `n/p` | 翻页 |
| `Enter` | 保存修改并退出 |
| `Escape` | 返回上一级 |

**分页**：skills 数量超过 25 时自动分页，每页最多显示 25 行。

**Matrix editor 保存时的通配符优化**：如果某个 skill 选中了所有已配置的 agents，保存时写入 `["*"]` 而不是逐个列出所有 agent 名称。

**`link edit`**（无 skill 参数）：直接调用矩阵编辑器。退出矩阵编辑器后，若 links 配置发生了变更，交互式询问用户是否立即 apply（等效于 `link apply`，创建/清理 symlink 使实际状态与配置一致）。用户确认则执行 reconcile，拒绝则仅保存配置不操作 symlink。

**`link list`** / **`link ls`**：显示链接状态。

默认符号版输出：
```
Link Status

Skill                    claude*   agents    cursor*   kiro*
────────────────────────────────────────────────────────────
web-artifacts-builder    ⚠         ·         ✓         ·
web-design-guidelines    ⚠         ·         ✓         ·
webapp-testing           ✓         ·         ✓         ·
xlsx                     ✗         ·         ·         ·

Legend: ✓ linked  ⚠ copied  · missing  ✗ broken
        * = private agent (requires separate link)
```

`-v` / `--verbose` 文字版输出：
```
Link Status

Skill                    claude*     agents      cursor*     kiro*
──────────────────────────────────────────────────────────────────
web-artifacts-builder    copied      missing     linked      missing
web-design-guidelines    copied      missing     linked      missing
webapp-testing           linked      missing     linked      missing
xlsx                     broken      missing     missing     missing

* = private agent (doesn't read ~/.agents/skills/, requires separate link)
```

**状态符号说明**：

| 状态 | 符号 | 含义 |
|------|------|------|
| `linked` | `✓` | 软链接正常 |
| `copied` | `⚠` | 降级为拷贝（需要关注） |
| `missing` | `·` | 未链接 |
| `broken` | `✗` | 链接损坏 |

**重名 skill 处理**：保留子命令名（`edit` / `set` / `add` / `remove` / `clear` / `apply` / `list` / `ls`）优先匹配。如果 skill 名恰好是保留字（罕见），所有显式子命令仍可正常使用——例如 skill 名为 `set` 时，`link set set claude` 等价于"用 `link set` 子命令把 skill `set` 的 targets 设为 claude"，无歧义；只有不带 skill 参数的 `link list` 会优先识别为子命令。

**`server`**：直接进入服务器管理菜单。

**`remote`**：直接调用矩阵编辑器，skills × servers 映射。

**`config show`**：打印当前配置（JSON 格式化）

**`config set <key> <value>`**：非交互式设置单个配置项。

**新增类型：`ServerConfig.agents`**

每个远程 server 可独立配置 AI agent 目录映射：
```json
{
  "agents": {
    "claude": "~/.claude/skills",
    "hermes": "~/.hermes/skills"
  }
}
```

### 3.4 `repo.ts` — 仓库初始化

- 创建 `~/.syncskill/` 目录（含 `skills/`, `manifests/` 子目录）
- 生成 `~/.syncskill/config.json`（含自动检测的 agent）
- 复制 `config.example.yaml` 作为参考
- **自动迁移已有 skills（默认行为）**：当 `~/.syncskill/` 目录不存在或 `~/.syncskill/skills/` 为空时，按顺序扫描 agent 目录，将发现的 skill 复制到 `~/.syncskill/skills/`。重名 skill 不覆盖，以前面扫描到的目录为准。仅复制普通文件，跳过软链接。`--skip-scan` 参数跳过此步骤。
- **自动更新 links**：如果迁移了 skills，自动将迁移的 skill 名写入 `config.json` 的 `links` 字段（使用 `computeDefaultLinkTargets()` 计算默认目标，即 `["agents"]` + 已检测到的不支持 `~/.agents/skills/` 的 agent）。
- **默认安装 syncskill skill**：流程末尾自动安装内置 syncskill skill 到 `~/.syncskill/skills/syncskill/` 并 link 到默认 agent（计算规则见 §3.2 `computeDefaultLinkTargets()`）。无需询问。如需跳过，用 `--skip-self` flag。

### 3.5 `install.ts` — Skill 安装

处理 `syncskill install` / `syncskill i` 命令。**`source add` 已合并到此命令**——通过 `install <url-or-path>` 统一入口安装外部来源。

`install` 内部统一遵循 §3.0.B plan-then-execute 协议。

**无参数调用**：

```
syncskill install
├─ TTY → 进入交互式菜单：
│   ┌─────────────────────────────────────────────────────────┐
│   │ ? What would you like to install?                       │
│   │ > Built-in syncskill skill                              │
│   │   From a URL or local path                              │
│   │   Cancel                                                │
│   └─────────────────────────────────────────────────────────┘
│   ├─ Built-in syncskill skill → 等同 install --self
│   ├─ From a URL or local path → 提示输入 URL 或路径，等同 install <input>
│   └─ Cancel → 退出，不操作
└─ 非 TTY → E_NEEDS_INPUT + exit 4（hint: 用 `--self` 或 `<url-or-path>`）
```

**安装内置 syncskill skill**：

```
syncskill install --self
├─ Plan: 探查 ~/.syncskill/skills/syncskill/ 是否已存在
│   ├─ 已存在 → plan.actions 为空 + info "already installed"
│   └─ 不存在 → plan.actions: [copy-builtin, link-skill, create-symlink]
├─ Execute:
│   ├─ 定位 dist/skills/syncskill/ 目录（通过 import.meta.url）
│   ├─ 复制到 ~/.syncskill/skills/syncskill/
│   └─ 调用 link reconcile（使用 computeDefaultLinkTargets() 计算目标 agent）
└─ 输出 result.summary.data（schema 见 §11.6）
```

**`--self` flag**：安装内置 syncskill skill。如果用户本地有名为 `self` 的目录需要安装，请使用 `install ./self`（显式路径）。

**从 URL/路径安装**：

```
syncskill install <url-or-path> [--name <n>] [--path <p>] [--type git|http|local] [--branch <b>]
├─ Plan 阶段（只读探查）：
│   ├─ detectSourceInput(input) — 类型推断
│   ├─ git source: git ls-remote 拿 HEAD ref（轻量）
│   ├─ http source: HEAD 请求拿 Content-Type / Content-Disposition
│   ├─ local source: fs.stat 验证存在
│   ├─ 计算默认 name / path（推断或显式 --name/--path 覆盖）
│   ├─ 推断会发现的 skill 集合（git: SKILL.md 路径只能在 clone 后确定 →
│   │   plan 标 unresolved.kind="skill-selection-deferred"。execute 阶段
│   │   clone 完成后列出 candidates 并按 flag 处理：
│   │     - TTY → 弹 prompt（这是 §3.0.B.4 约束 2 的例外：deferred 决议
│   │       只能在 clone 后做，作为 execute 内部的 sub-plan 周期处理）
│   │     - `-y` / `--resolutions[-stdin]` 提供 → 应用决议
│   │     - `--no-interactive` 且无 `-y` 无 resolutions → exit 4 + E_NEEDS_INPUT）
│   └─ 产出 plan：actions + unresolved
│
├─ 检查 unresolved：
│   ├─ TTY + 无 --no-interactive → 弹 prompt 收集决议
│   ├─ --no-interactive → exit 4 + E_NEEDS_INPUT + hint
│   └─ --resolutions[-stdin] 提供 → 使用文件决议
│
├─ Execute 阶段：
│   ├─ 真正 clone / download / scan
│   ├─ 应用决议（选中 skill 进 links，未选中进 ignore）
│   ├─ 持久化 sources + links（含三种场景：新 source / 合并到已有同 URL source / 新建附加 source）
│   ├─ 创建 symlink 到 agent 目录
│   ├─ 保存 config.json
│   └─ 刷新 skills-registry.json（写 http baseline 等）
│
└─ 输出 result.summary.data（schema 见 §11.6）
```

**参数说明**：`--self` 安装内置 skill；其余参数用于外部来源安装。

**输出示例**：

```bash
# 无参数 + TTY → 交互式菜单
$ syncskill install
? What would you like to install? (Use arrow keys)
> Built-in syncskill skill
  From a URL or local path
  Cancel

# 无参数 + 非 TTY (CI、管道) → exit 4
$ echo "" | syncskill install
{"type":"error","code":"E_NEEDS_INPUT","message":"`install` without args requires an interactive terminal","hint":"Use `install --self` or `install <url-or-path>`"}

# 安装内置 skill
$ syncskill i --self
✓ Installed syncskill skill to ~/.syncskill/skills/syncskill/
✓ Linked to: claude, hermes

# 从 URL 安装
$ syncskill i https://github.com/user/my-skills
Cloning https://github.com/user/my-skills...
Found 3 skills: skill-a, skill-b, skill-c
✓ Installed 3 skills
✓ Linked to: claude, hermes

# 从本地压缩包安装
$ syncskill i ~/Downloads/my-skills.tar.gz
Extracting my-skills.tar.gz...
Found 2 skills: skill-x, skill-y
✓ Installed 2 skills from local archive
✓ Linked to: claude, hermes

# 重复安装 → 已存在时输出 info
$ syncskill i https://github.com/user/my-skills
Source "my-skills" is up to date. All skills already linked.

# 已包含的子目录 skill
$ syncskill i https://github.com/user/my-skills/tree/main/examples/skill-a
All skills from "examples/skill-a" are already included in source "my-skills".
```

本地压缩包安装等效于 HTTP 下载后的状态：解压到 `~/.syncskill/sources/<name>/`，`SourceConfig` 记录 `type: "local"` + `archive_path` 指向原始压缩包路径。后续的 skill 发现、link 逻辑与其他 source 类型完全一致。

**实现共享**：`install` 内部调用 `installFromSource()`。上方 Plan/Execute 流程是高层视角；具体子机制的详细规则见 §3.8 的对应小节：

- 输入类型推断 → §3.8 "输入检测（`detectSourceInput`）"
- GitHub URL 子目录推断 → §3.8 "GitHub URL → `skill_subdir` 推断规则"
- 同一 URL 已存在时的合并策略（含 nuwa-skill 示例）→ §3.8 "同仓库合并逻辑"
- 多 skill 选择 / 重名冲突的交互细节 → §3.8 "首次安装行为"
- skill 发现遍历规则 → §3.8 "Skill 发现机制"

### 3.6 `linker.ts` — 软链接管理

**双轨命令设计**（人类 verb / AI declarative）：

| 子命令 | 受众 | 语义 |
|--------|------|------|
| `link edit [skill]` | 人类 | 交互式矩阵编辑 |
| `link add <skill> <agent>...` | 人类 | 增量追加 |
| `link remove <skill> <agent>...` | 人类 | 增量移除 |
| `link clear <skill>` | 人类 | 清空该 skill |
| `link apply` | 人类 / AI | 按 config reconcile symlinks |
| `link set <skill> <agent>...` | AI agent | declarative 覆盖 |
| `link list` / `link ls` | 人类 / AI | 只读查询 |

**AI agent 优先用法**：`link set <skill> <agents>...`（写 config）+ `link apply`（reconcile）。避免 `add` / `remove` —— 这些是人类 verb，多个 agent 并发调用容易互相覆盖；`set` 是 declarative，可幂等重放。

**三级降级策略**：
1. `fs.symlink()` — 标准软链接
2. Windows Junction（通过 `fs.symlink(target, link, 'junction')`）
3. `fs.cp(source, target, { recursive: true })` — 拷贝（带警告）

支持：创建链接、状态检查、删除、扫描（walk 目录发现新 skill）。

**Stale Link Reconcile**：

`link apply`、`link set/add/remove/clear` 落盘后、以及矩阵编辑器退出后的 apply 操作，都需要清理 stale 的 syncskill 管理的软链接。当用户通过矩阵编辑器（或 `link set`）将某个 skill 从 `["*"]` 改为 `["claude"]` 后，其他 agent 目录中残留的旧链接应被自动清理。

- `link edit <skill>`：单 skill 矩阵编辑器，退出后 reconcile 该 skill 的链接状态
- `link edit`：全局矩阵编辑器，退出后 reconcile 所有变更的 skill
- `link set/add/remove/clear`：落盘前先 reconcile 受影响 skill 的链接（dry-run 时仅打印）
- `link apply`：按 config 配置 reconcile 所有 skill 在所有 agent 目录中的链接状态

清理规则：
1. 遍历所有 `config.agents` 目录，检查指定 skill（或所有 skill）是否存在需要清理的 stale 链接
2. **仅清理 syncskill 管理的软链接**：symlink target 能被 `resolveSkillPath()` 解析到（指向 `~/.syncskill/skills/` 或 `config.sources` 中的路径）
3. **不清理实体目录**：非 symlink 的真实目录不动，可能是用户手动放置的
4. **不清理非 syncskill 管理的链接**：symlink target 不在 syncskill 管理范围内的不动
5. 一个 symlink 是 stale 的条件：skill 名在 `config.links` 中存在但该 agent 不在其展开后的目标列表中，或 skill 名不在 `config.links` 中（已完全移除）

`reconcileStaleLinks()` 函数签名：

```typescript
interface ReconcileResult {
  removed: string[];   // 被清理的路径
  skipped: string[];   // 跳过的（非 syncskill 管理）
  errors: string[];    // 清理失败的
}

function reconcileStaleLinks(
  skillNames: string[],
  config: SyncSkillConfig
): ReconcileResult;
```

**Reconcile 交互行为**：

当有需要清理的链接时，显示并等待用户确认：

- **默认（交互模式）**：列出将要清理的链接，等待确认 `[Y/n]`
- **`-y/--yes`**：显示摘要，自动确认
- **`--dry-run`**：只显示，不执行也不询问

**输出示例（单 skill 矩阵编辑器）**：

```bash
$ syncskill link edit my-skill

my-skill is currently linked to:

  [x] claude
  [ ] cursor
  [x] hermes

↑↓ navigate  Space: toggle  Enter: confirm  Esc: cancel

# 用户取消勾选 hermes，按 Enter
✓ Updated my-skill: linked to claude, unlinked from hermes

# 用户按 Esc 取消（不写 config，不操作 symlink）
$ syncskill link edit my-skill
... (matrix editor)
Cancelled. No changes made.
```

**单 skill 矩阵的 Enter / Esc 语义**：
- **Enter**：confirm 即 apply。立即写入 `config.links[skill]` 并执行 createLink/removeLink，**不再二次询问**"是否 apply"（与全局矩阵不同：因为单 skill 作用域小且明确）。
- **Esc** 或 `Ctrl+C`：取消。**不写 config，不操作 symlink**。打印 `Cancelled. No changes made.` 后返回。

**输出示例（声明式 set / 增量 add / remove）**：

```bash
# 覆盖式：链接到正好这两个 agent，其他 agent 上的旧链接被清理
$ syncskill link set my-skill claude cursor
✓ Set my-skill targets to: claude, cursor
✓ Reconciled symlinks (added: cursor; removed: hermes)

# 通配符
$ syncskill link set my-skill '*'
✓ Set my-skill targets to: * (wildcard — applies to all configured agents)

# 追加单个 agent
$ syncskill link add my-skill cursor
✓ Linked my-skill to cursor

# 移除单个 agent（修复了原 unlink 只能整 skill 的不对称）
$ syncskill link remove my-skill hermes
✓ Removed my-skill from hermes

# 未配置的 agent
$ syncskill link add my-skill unknown-agent
Error: Agent 'unknown-agent' not configured (E_AGENT_NOT_CONFIGURED)
```

**输出示例（批量 reconcile）**：

```bash
$ syncskill link apply

✓ Linked 5 skills

Links to remove (no longer in config):
  my-repo:
    skill-a: hermes, qoder
    skill-b: qoder
  manual:
    local-tool: hermes

Remove 4 links? [Y/n] y
✓ Removed 4 links
```

**使用 `-y` 时**：

```bash
$ syncskill link apply -y

✓ Linked 5 skills
✓ Removed 4 links (skill-a, skill-b, local-tool)
```

**Clear / Unlink 命令示例**：

`unlink <skill>` 是 `link clear <skill>` 的顶级别名。

```bash
# 交互确认后删除所有 agent 链接
$ syncskill link clear my-skill
Remove all links for skill "my-skill"? (claude, cursor, hermes) [y/N] y
✓ Unlinked my-skill from all agents
✓ Removed "my-skill" from config links.

# 顶级别名
$ syncskill unlink my-skill -y
✓ Unlinked my-skill from all agents
✓ Removed "my-skill" from config links.
```

### 3.7 `manifest.ts` — Hash 计算与 Manifest

**Hash 算法**（与 Python/Hermes 完全兼容）：
```
遍历 skill 目录 sorted 文件（使用 lstatSync 检测文件类型）
  对每个文件：md5.update(相对路径_utf8 + 文件内容)
  忽略目录和软链接（lstatSync + isSymbolicLink），只 hash 普通文件
  返回 hex digest (32 字符)
```

**Symlink 处理规则**：
- **Skill 目录本身是软链接**：跟随 symlink，对实际目录内容计算 hash（由调用方解析路径）
- **Skill 目录内部的软链接**：忽略，不参与 hash 计算（使用 `lstatSync` 检测）

**Manifest 格式**（3-field 模型）：
```json
{
  "version": 1,
  "server": "server-name",
  "updated_at": "2026-04-30T00:00:00Z",
  "skills": {
    "skill-name": {
      "local_hash": "abc123...",
      "remote_hash": "def456...",
      "recorded_hash": "abc123...",
      "direction": "push",
      "status": "in-sync"
    }
  }
}
```

**3-field 模型说明**：
- `local_hash`：当前本地文件的实际 hash（每次刷新时重新计算）
- `remote_hash`：最后已知的远程 hash（从远程 manifest 拉取）
- `recorded_hash`：上次同步点的基准 hash（push/pull 完成时设置为同步后的 hash）
- `direction`：同步方向，取值 `push` / `pull` / `conflict`（其中 `conflict` 由 manual 策略下的冲突标记产生；不设方向等价于 `push`，需要双向同步用 `sync` 命令）
- `status`：同步状态，取值固定为 5 态枚举之一 —— `in-sync` / `local-changed` / `remote-changed` / `conflict` / `new`。所有写入 manifest 的代码路径都通过 `classifySkillDelta(local, remote, recorded)` 派生该值，避免出现 `changed`、`pending` 等非枚举值。

`recorded_hash` 作为 3-way merge 的基准点，用于判断"谁改了"：
- `local_hash ≠ recorded_hash` → 本地相对基准有变化
- `remote_hash ≠ recorded_hash` → 远程相对基准有变化

这种设计天然解决了"syncskill 外部操作"（如 `git checkout`）的场景：即使本地文件被外部工具还原，`recorded_hash` 保持不变，系统仍能正确检测到本地变化并触发 push。

**Manifest 变更历史** (`manifest_history.json`)：用于追踪 hash 变更事件，仅在 hash 实际变更时追加记录。

**Delta 比较逻辑**（`classifySkillDelta`）：

返回二元组 `{ action, status }`：

- `action` 取值 `skip` / `push` / `pull` / `conflict` / `init`（同步动作，给 push/pull 引擎消费）
  - `init`：首次同步（recorded 为 null），具体方向（推/拉）由调用方根据哪一侧有 hash 推断
  - 注意 action 与 status 词表共享 `conflict` 但**不共享 `new`**：状态用 `new`，动作用 `init`
- `status` 取值 `in-sync` / `local-changed` / `remote-changed` / `conflict` / `new`（写入 manifest 的当前状态）

```text
1. local_hash === remote_hash                                                     → skip, in-sync
2. local_hash ≠ recorded_hash && remote_hash === recorded_hash                    → push, local-changed
3. remote_hash ≠ recorded_hash && local_hash === recorded_hash                    → pull, remote-changed
4. recorded_hash === null && local_hash && !remote_hash                           → init, new   (首次同步,推方向)
5. recorded_hash === null && !local_hash && remote_hash                           → init, new   (首次同步,拉方向)
6. recorded_hash === null && local_hash && remote_hash && local_hash ≠ remote_hash → conflict, conflict   (双方独立创建,内容冲突)
7. local_hash ≠ remote_hash && 以上都不满足                                        → conflict, conflict
```

### 3.8 `source.ts` — 外部来源管理

- **Git 来源**：克隆前通过 `git ls-remote --symref <url> HEAD` 自动探测远程默认分支名，然后执行 `git clone --single-branch --depth 1 --branch <detected>`
  - **Stale checkout 检测**：若 checkout 目录已存在，检查是否为有效 git 仓库且 remote URL 匹配；若不匹配或非 git 仓库，删除后重新 clone
- **HTTP 来源**：`fetch()` 下载 → 解压（支持 `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`）
- **Local 来源（目录）**：以 `path` 为基准目录，通过 `path` 和 `skill_subdir` 定位 skills
- **Local 来源（压缩包）**：本地 `.zip` / `.tar.gz` 等压缩包文件，解压到 `~/.syncskill/sources/<name>/`，config 中记录 `archive_path` 指向原始压缩包路径

**输入检测（`detectSourceInput`）**：

```
detectSourceInput(input) 判断优先级：

1. 文件系统路径（/, ~, ./, ../, 或当前目录存在的路径）
   ├─ 是目录 → type: "local"
   └─ 是文件 + 已知压缩格式后缀 → type: "local"（压缩包模式）

2. 以 .git 结尾的 URL → type: "git"

3. URL 路径含压缩格式后缀（支持 ?query 参数）→ type: "http"
   例: https://cdn.example.com/skills.tar.gz?token=abc

4. GitHub / GitLab URL（含 /tree/<branch> 格式）→ type: "git"

5. 其他 http(s) URL → type 未知，需要用户指定 --type
   ├─ 若指定 --type http：下载时通过 Content-Disposition / Content-Type 推断文件格式
   └─ 若仍无法推断格式：提示用户指定 --archive-format tar.gz|zip|...

6. 裸名称（非路径、非URL）→ 交互式询问类型和路径
```

**已知压缩格式**：`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`

**`SourceConfig` 字段**（`types.ts`）：

```typescript
interface SourceConfig {
  type: "git" | "http" | "local";
  url?: string;                // Git/HTTP: 远程 URL
  path: string;                // 本地存储路径（clone/解压目标，或 local 目录路径）
  branch?: string;             // Git: 分支名
  skill_subdir?: string;       // skill 搜索起始目录（默认 "." = 递归搜索整个 path）
  ignore?: string[];           // 忽略的 skill 名列表
  archive_path?: string;       // Local 压缩包模式：原始压缩包文件的绝对路径
}
```

**`archive_path` 使用场景**：
- 仅在 `type: "local"` + 输入为压缩包文件时设置
- 记录原始压缩包路径，供 `source list` 显示来源信息
- `update` 不支持更新有 `archive_path` 的 local source（无远程 URL）
- 区分"本地压缩包解压后的 local source"和"本地目录引用的 local source"

**设计说明**：本地压缩包使用 `type: "local"` 而非 `type: "http"` 是有意为之。虽然解压后的状态与 HTTP 下载相同，但 `type: "local"` 明确表达"无法自动更新"的语义——没有远程 URL 可供 `update` 拉取新版本。这使 `source list` 和 `update` 的行为更直观。

**可更新判断**：

| type | url 有值 | archive_path | 可更新 |
|------|---------|-------------|--------|
| `git` | ✓ | — | ✓ |
| `http` | ✓ | — | ✓ |
| `http` | ✗ | — | ✗ |
| `local` | — | — | ✗（目录引用） |
| `local` | — | ✓ | ✗（压缩包解压后） |

**`source add` 流程**：已合并到 `install` 命令，详见 §3.5。

**Skill 发现机制**：

Skill 发现统一基于**递归搜索 SKILL.md 文件**。给定一个 subdir，在该目录下递归搜索所有含 SKILL.md 的目录，每个这样的目录是一个独立的 skill（名称 = 该目录名）。

`skill_subdir` 取值语义：
- `"."` → 仓库根目录（递归搜索整个仓库）— **默认值**
- `"examples/demo-skill"` → 指定子目录（递归搜索该目录）
- `"examples"` → 指定子目录（递归搜索该目录下所有 SKILL.md）

注：`skill_subdir` 默认为 `"."`（递归搜索整个 source 目录）。所有入口（GitHub URL、本地目录、压缩包）统一使用此默认值。

**GitHub URL → `skill_subdir` 推断规则**：
- `https://github.com/user/repo` → `skill_subdir="."` （裸仓库 URL = 整个仓库）
- `https://github.com/user/repo.git` → `skill_subdir="."` （同上）
- `https://github.com/user/repo/tree/main` → `skill_subdir="."` （指向分支根 = 整个仓库）
- `https://github.com/user/repo/tree/main/examples` → `skill_subdir="examples"`
- `https://github.com/user/repo/tree/main/examples/foo` → `skill_subdir="examples/foo"`

**首次安装行为**：

递归搜索发现所有 skills 后：
- **单个 skill**：直接安装，无需确认
- **多个 skills**：交互式让用户选择要安装哪些
  - 选中的 → 加入 links
  - 未选中的 → 加入 ignore

使用 `-y` 标志时自动选中所有发现的 skills（跳过确认）。

**同仓库合并逻辑**：

核心原则：**一个 URL 对应一个 source entry**，通过调整 `skill_subdir` 层级和 `ignore` 列表来管理。

```
同 URL 的 source 已存在时：

1. 新 subdir 在 existing subdir 范围内
   → 只更新 ignore list（从 ignore 移除目标 skills，加入 links）
   → skill_subdir 保持不变
   例：existing=".", new="examples/skill-a"

2. 新 subdir 比 existing 更广
   → 扩大 skill_subdir 为新值
   → 新增 skills 加入 links，已有的保持不变
   例：existing="examples/skill-a", new="."

3. 完全不相关的路径（互不包含）
   → 询问用户：扩大到共同父目录，还是创建独立 source？
   → 推荐扩大到共同父目录（保持一个 source 原则）
   例：existing="skills/", new="examples/" → 扩大到 "."

裸仓库 URL（无 /tree/branch/subdir）：
   → GitHub URL 无 /tree/... 部分时，等同于 skill_subdir="."（整个仓库）
   → 若 existing 范围比 "." 窄，走 Case 2 扩大到 "."
   → 若 existing 已是 "."，走 Case 1 identity（all already included）
   例：existing="examples", new=bare URL → expand to "."

重复安装完全相同的 URL+subdir：
   → 保持现有 source 不变，只 refresh 发现新 skills
```

**包含关系判断**：`subdirContains(parent, child)`
- `"."` 包含一切（仓库根）
- `"a/b"` 包含 `"a/b/c"` 但不包含 `"a/x"`
- 同一路径视为包含（identity）

**示例**（nuwa-skill 仓库）：
```
仓库结构：
  /SKILL.md
  /examples/andrej-karpathy-perspective/SKILL.md
  /examples/steve-jobs-perspective/SKILL.md
  ... (~15 个 examples/*/SKILL.md)

# 首次安装
syncskill i https://github.com/alchaincyf/nuwa-skill
→ 递归搜索发现 ~16 个 skills
→ 交互式选择：用户选中 "nuwa-skill"，其余加入 ignore
→ config: skill_subdir: ".", ignore: [其余 15 个]

# 后续添加子目录 skill
syncskill i .../tree/main/examples/andrej-karpathy-perspective
→ source 已存在，"." 包含 "examples/..."
→ 从 ignore 移除 "andrej-karpathy-perspective"，加入 links
→ skill_subdir 保持 "."
```

**`update` 命令流程**：

`update` 是顶级命令（原 `source update` 已移除）。遵循 §3.0.B plan-then-execute 协议。

```
update [name]

Step 1: Plan 阶段（只读）
├─ 确定更新范围
│   ├─ 指定 name → 只更新该 source
│   └─ 无参数 → 所有可更新的 source（过滤掉 local / no-url 的）
├─ Dirty 检测（只读操作）：
│   ├─ Git source: `git status --porcelain` 在 source.path 执行
│   └─ HTTP source: 对每个 skill 计算当前 hash，对比 skills-registry.json 中的 last_update_hash
├─ 生成 plan：
│   ├─ actions: [fetch+reset] / [download+extract] per source
│   └─ unresolved: dirty source 列表（除非 --force）
└─ 输出 plan（--plan / --dry-run 模式）

Step 2: Dirty 处理（per-source 决策；最终 exit 6 当任意 source 被 skip）
├─ 多 source 时**逐个独立处理**：dirty 的 skip，clean 的继续执行 Step 3；不会因第一个 dirty 而中止整批
├─ 检测到 dirty source 时：
│   ├─ 无 --force → skip 该 source + warning（最终 exit 6 表示有 source 未更新）
│   │   输出 hint 字段（可执行命令片段）：
│   │     git source: "git -C <path> stash && syncskill update <name> && git -C <path> stash pop"
│   │     http source: "cp -r <path> <path>.bak && syncskill update <name> --force"
│   └─ --force → 继续执行：
│       ├─ git source: git stash push -m "syncskill: auto-stash" → git fetch → git reset --hard
│       │   不记录 stash SHA（用户自己 git stash list 找；用 --force 即接受手动恢复成本）
│       └─ http source: 将 dirty skills 复制到 `<source-path>.syncskill-pre-update-backup/` sidecar 目录
│           不持久化历史记录（用户自己 cp 恢复；用 --force 即接受手动恢复成本）

Step 3: Execute 更新
├─ Git source: git fetch --depth=1 → git reset --hard origin/<branch>
├─ HTTP source（clean，或交互/--force 确认）：
│   ├─ 下载到 tmp 目录（~/.syncskill/.tmp/update-<name>/）
│   ├─ 解压验证完整性
│   └─ rm 源目录 + mv tmp → 源目录
├─ 扫描新 skill 列表，对比变化
└─ 更新 skills-registry.json 的 last_update_hash（HTTP source）

Step 4: 处理被删除的 skill
├─ 列出更新后从 source 中消失的 skill
├─ 对每个被删除的 skill 询问（除非 -y/--no-interactive 则用 safe default = 保留）：
│   "Skill <X> was removed from source <Y>. Keep it as a local skill?"
│   ├─ Yes（safe default）→ 复制 skill 到 ~/.syncskill/skills/<name>，registry 更新为 manual
│   └─ No → 从 links 中移除，清理软链接，registry 标记删除

Step 5: 输出更新报告（result.summary.data，schema 见 §11.6）
```

**简化决定**（vs 旧版）：

- 不再有 `update-history.json` —— 用户 `--force` 即接受手动恢复成本
- 不再有 `source restore` 命令 —— hint 字段直接输出可执行命令片段
- HTTP source 备份改为 sidecar 目录 `.syncskill-pre-update-backup/`（同 source 旁），不再有独立 `~/.syncskill/backups/` 目录
- 不再有 git source / http source 分流的恢复 UI

**为什么简化**：force-update dirty source 是低频场景。原设计相当于"自己实现 git stash 工作流"，复杂度回报比低。abort + 可执行 hint 解决 90% 场景，剩下 10% 用 `--force` 接受手动恢复。

**`--dry-run` 行为**：plan 输出"将要做什么"，包括 dirty source 列表。无 `--force` 时 dry-run 同样标 "would skip"；`--force` + dry-run 标 "would force-update（stash / backup）"。

**Skills 注册表（`skills-registry.json`）**：

**数据优先级原则**：`file truth > config > registry`

`skills-registry.json` 是 sidecar 元数据，**只存不可派生**的两类字段：

1. **Ignored 元信息**（用户操作历史）：`reason` / `at` / `kept_by`
2. **HTTP baseline hashes**（dirty 检测必需）：每个 HTTP source skill 的 `last_update_hash`

其他字段（path / origin / type / status: active）每次需要时从 `config.sources` + 文件系统派生。

```json
{
  "version": 2,
  "ignored": {
    "<skill-name>": {
      "reason": "duplicate",
      "at": "2026-05-09T10:00:00Z",
      "kept_by": "~/.syncskill/sources/repo/skills/<name>"
    }
  },
  "http_baselines": {
    "<skill-name>": {
      "source": "skill-pack",
      "hash": "a1b2c3d4..."
    }
  }
}
```

**`http_baselines.<skill>.hash` 字段**：

- 仅用于 HTTP source 的 dirty 检测
- 在 `install`（HTTP 类型解压完成后）和 `update`（更新完成后）写入
- update 前计算当前 skill 实际 hash，与此字段对比判断是否 dirty

**Schema 迁移**：v1 (旧 schema) → v2。`install --self` / `init` 升级路径：检测到 v1 registry 时只读取 `ignored` 状态和 `last_update_hash`，丢弃其他派生字段后重写为 v2。doctor 在 v1 → v2 迁移时不视为错误。

**全局 skill 发现**：

统一通过 `discoverAllSkills(config)` 函数，合并 `~/.syncskill/skills/` 和所有 sources 的 skill。

### 3.9 `sync_engine.ts` — 核心同步流程

**Push 流程**：
1. 按需部署 receiver：计算本地 `sync_receiver.mjs` 的 MD5 hash，通过 SSH `md5sum` 获取远程文件 hash，仅在 hash 不同或远程文件不存在时重新部署 `sync_receiver.mjs` + `bootstrap_remote.sh`
2. 推送 receiver config（remote_agents 映射）
3. 计算本地 hash
4. 拉取远程 manifest
5. 对比 → delta（注：`compareManifests` 对不在远程 manifest 中的 skill **无论本地 hash 是否变化**都标记为 `"new"`，确保新增到 include 列表的 skill 一定会被 push）
6. 检测冲突
7. **Reconcile remote skill set**：一次性 SSH `ls` 远端 `~/.syncskill/skills/` 目录，得到实际存在的 skill 列表。基于此列表执行两件事，复用同一次 ls 调用：
   - **7a (always — cleanup)**：远端实际存在但不在当前 include 列表中的 skill → 列出待删除项，除 `-y/--yes` 外要求用户确认后删除。
   - **7b (`--no-refresh` only — safety net)**：delta 中被标记为 "skip"（manifest 认为已同步）但远端实际缺失的 skill → 强制改为 "push"。正常流程下 `refreshRemoteManifest()` 已经从 manifest 删除了消失的远端 skill（详见 §3.12），所以 7b 仅在 `--no-refresh` 场景下有意义；正常流程不会命中。
8. rsync 将具体 skill 目录推送到远程
9. **对远程有变更但本地不需要 push 的 skill**：仅打印警告（`Skipping <skill>: remote has changes. Use syncskill pull to update local.`），**不执行隐式 pull**。push 命令只推送，不拉取。用户需要单独执行 `syncskill pull` 来获取远程变更。
10. **更新本地 manifest**（3-field 模型）：区分实际推送的 skill 和未推送的 skill。实际 pushed 的 skill 设置 `remote_hash=local_hash, recorded_hash=local_hash, status="in-sync"`（三个 hash 同步）；未 pushed 的 skill（skip/pull/conflict）保留旧的 `remote_hash` 和 `recorded_hash`，正确反映同步状态。
11. 推送 manifest
12. SSH exec `sync_receiver.mjs apply`（receiver 会创建当前 skill 的 agent symlink，并清理指向已删除 skill 目录的 stale symlink）

**Push 命令交互**：

无参数时显示服务器列表让用户选择，第一个选项是"推送到所有服务器"：

```
Select servers to push:
  [x] All servers
  [ ] prod-server
  [ ] dev-server
  [ ] staging

↑↓ navigate  Space: toggle  Enter: confirm
```

**Pull 流程**：
1. 拉取远程 manifest
2. 对比本地 hash
3. 确定 pull 目标路径（见下方路径解析规则）
4. rsync 拉取到目标路径
5. 更新本地 manifest + skills-registry.json

**Pull 目标路径解析**：

Pull 时 skill 应放回其**原始来源目录**，而非统一放到 `~/.syncskill/skills/`。路径解析优先级：

```
resolveSkillPullTarget(skillName):
  1. 查询 skills-registry.json
     ├─ 找到 entry.path → 使用 registry 中记录的真实路径
     │   例: manual skill → ~/.syncskill/skills/<name>
     │   例: git source  → ~/.syncskill/sources/repo/skills/<name>
     │   例: http source → ~/.syncskill/sources/archive/skills/<name>
     │   例: local source → /external/path/skills/<name>
     └─ 未找到 → 进入 fallback

  2. Fallback（registry 异常缺失时）
     ├─ resolveSkillPath(skillName, config.sources) — 从 config sources 推断路径
     └─ 兜底 → ~/.syncskill/skills/<name>（manual 默认位置）

  3. 远程新增（本地不存在的 skill）
     → 拉取到 ~/.syncskill/skills/<name>（作为 manual skill）
     → registry 中新增条目：origin: "remote", type: "manual", status: "active"
```

所有来源类型（manual / git / http / local）均允许被 pull 覆盖。用户配置了 `direction: pull` 即表示希望从远程覆盖本地。

> Sync 是 plan-then-execute 协议的原型，本节描述 sync 专属的两阶段细节。通用协议见 §3.0.B；以下 sync flag 与全局 flag 复合使用。

**Sync 流程**（plan-then-execute，禁止中途 prompt）：

Sync 拆成两个**完全分离**的阶段：

1. **Plan 阶段（只读）**：拉所有目标服务器 manifest、对比 delta、检测**所有**冲突（单 server 内 + 跨 server）、生成完整执行计划。绝不写盘、不传输文件、不修改 manifest。所有需要决策的点（cross-server conflict、单 server conflict、被删除 skill 处置）在此阶段一次性收集完毕。
2. **Execute 阶段（写）**：按 plan 严格执行 pull → refresh → push 串行流程。**此阶段不发任何 prompt**——所有决策必须在 plan 阶段已经确定（或由 policy flag / resolutions 文件提供）。

这种切分让 sync 在 `--no-interactive` / `--json` 下可被 AI agent 可靠驱动：先跑 plan 拿计划 → 离线决策 → 把决议传回 execute。

**作用域**：
- `syncskill sync`（无参数）/ `syncskill sync --all`：作用域 = `config.servers` 中所有服务器。
- `syncskill sync <server>`：作用域缩小到单台服务器，仍执行 plan → execute（pull → refresh → push）。**只覆盖该 server**——需要"从 server-A pull 后再 push 到 server-B"的中转场景，用 `pull <server-A>` + `push <server-B>` 显式组合。

**遍历顺序**：plan 与 execute 阶段都按 `Object.keys(config.servers)` 的插入顺序串行处理（YAML 中的 servers 出现顺序）。文档化的固定顺序让多 server sync 行为可预测，并影响 cross-server policy `first-wins` / `last-wins` 的语义。

**通用 flag**（语义见 §3.0.B）：`--plan` / `--plan-file <path>` / `--apply <path>` / `--apply-stdin` / `--resolutions <path>` / `--resolutions-stdin`

**sync 专属 flag**：

| Flag | 行为 |
|------|------|
| `--cross-server-policy <p>` | 跨 server 冲突的批量策略：`first-wins` / `last-wins` / `abort` / `prompt`（默认）。`-y` 暗示 `first-wins` |
| `--on-conflict <p>` | 单 server 冲突的批量策略：`skip`（默认）/ `keep-local` / `keep-remote` / `abort` |
| `--on-deletion <p>` | sync 中检测到远端删除时的策略：`keep-local`（默认，等价于"保留本地复制为 manual"）/ `delete` / `prompt` |

```
Phase A: PLAN（只读，无副作用）
  ├─ 对所有目标 server 并行拉取远程 manifest
  ├─ 对比 delta → 标记每个 skill 的 action（push / pull / skip / conflict / init）
  ├─ 模拟 pull 顺序，按 config.servers 插入顺序检测 cross-server 冲突：
  │    若 skill 在 server-A 已计划 pull、server-B 也要 pull 且 hash-A ≠ hash-B
  │    → 标记为 cross-server conflict
  ├─ 收集所有未决问题：
  │    - cross-server conflicts
  │    - 单 server content conflicts (action="conflict")
  │    - 远端删除决策 (skill 在远端消失)
  │    - dirty source 风险提示
  └─ 输出 SyncPlan（schema 见下方）

Phase B: EXECUTE（写盘，禁止 prompt）
  前置：所有 SyncPlan.unresolved 必须为空（要么由 plan 自动决议，要么由
        --resolutions / --cross-server-policy / --on-conflict / --on-deletion
        / -y 显式提供策略）。否则在进入 execute 前 abort，exit 7。

  ├─ Phase B.1: PULL（按插入顺序串行）
  │    for each target in plan.servers:
  │      ├─ rsync/scp pull 计划中标记 pull 的 skill
  │      └─ 更新本地 manifest（按 plan 中的 hash 写入 recorded_hash）
  │
  ├─ Phase B.2: REFRESH
  │    └─ 重算本地 hash，更新所有 server 的 local_hash 字段
  │
  └─ Phase B.3: PUSH（按插入顺序串行）
       for each target in plan.servers:
         ├─ rsync/scp push 计划中标记 push 的 skill
         └─ 更新 manifest + 远程 receiver apply
```

**SyncPlan schema**（`--plan-file` 写出 / `--json --plan` 直接打印 result.summary.data）：

```json
{
  "version": 1,
  "generated_at": "2026-05-21T12:00:00Z",
  "scope": ["prod", "dev", "staging"],
  "servers": [
    {
      "server": "prod",
      "actions": [
        { "skill": "skill-a", "op": "pull", "remote_hash": "abc123", "local_hash": "def456", "recorded_hash": "def456" },
        { "skill": "skill-b", "op": "push", "local_hash": "ghi789", "remote_hash": "abc123" },
        { "skill": "skill-c", "op": "skip", "reason": "in-sync" }
      ]
    }
  ],
  "unresolved": [
    {
      "kind": "cross-server-conflict",
      "skill": "shared-skill",
      "candidates": [
        { "server": "prod", "hash": "aaa" },
        { "server": "dev",  "hash": "bbb" }
      ],
      "default_under_first_wins": { "server": "prod", "hash": "aaa" }
    },
    {
      "kind": "content-conflict",
      "skill": "diverged",
      "server": "prod",
      "local_hash": "xxx",
      "remote_hash": "yyy",
      "recorded_hash": "zzz"
    },
    {
      "kind": "remote-deletion",
      "skill": "removed-on-remote",
      "server": "dev"
    }
  ],
  "warnings": [
    { "code": "W_SOURCE_DIRTY", "skill": "modified-source-skill", "message": "..." }
  ]
}
```

**resolutions 文件 schema**（`--resolutions <path>`）：

```json
{
  "cross_server": {
    "shared-skill": { "choose": "prod" }
  },
  "content": {
    "diverged": { "choose": "local" }
  },
  "deletion": {
    "removed-on-remote": { "choose": "keep-local" }
  }
}
```

读取规则：未在 resolutions 中列出的条目走对应 `--*-policy` flag；两者都缺时 `abort` + exit 7。

**Cross-server policy 语义**：

| Policy | 行为 |
|--------|------|
| `first-wins`（`-y` 默认） | 按 `Object.keys(config.servers)` 顺序，第一个出现该 skill 的 server 获胜，后续 server 的 pull 跳过 |
| `last-wins` | 顺序最后一个 server 获胜 |
| `abort` | 检测到 cross-server conflict 立即停止 plan，exit 7 |
| `prompt`（默认，仅交互模式） | plan 阶段为每个 conflict 一次性弹出 prompt（不在 execute 阶段中途打断） |

**关键设计点**：

- **plan 阶段绝不修改本地状态**：可以重复跑、安全在 CI 跑、可被 AI agent 当作"探查"使用
- **execute 阶段绝不 prompt**：所有决策已外移；任何会触发 prompt 的代码路径都视为 bug
- **`--plan` 与 `--dry-run` 区别**：`--dry-run` 是"完整流程的预览输出"（可能包含 stdout 文本），`--plan` 是"只跑只读阶段并产出结构化计划"。`--json --plan` 是机器消费的标准入口
- **单 server 冲突处理**：plan 标记为 `unresolved.content-conflict`；execute 阶段按 `--on-conflict` 全局策略或 resolutions 文件处理；遇到 `skip` 策略的冲突 skill 跳过，继续处理其他 skill
- **最终输出**：execute 完成后汇总每个 skill 的最终同步状态。冲突 skill 列出并提示用户执行 `resolve <skill>` 命令

**超时机制**：默认依赖操作系统的 SSH 超时配置（`ConnectTimeout`、`ServerAliveInterval`）。可通过 `--timeout` 参数显式设置超时：

```bash
# 设置 60 秒超时
syncskill sync --timeout 60
syncskill push --timeout 60
syncskill pull --timeout 60
```

推荐的 SSH 配置（`~/.ssh/config`）：
```
Host *
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 3
```

当 `--timeout` 指定时，CLI 在 await 层面 race 该次 push/pull/sync：到时立即抛错并放弃等待，已经启动的 rsync/scp/ssh 子进程不会被强制 kill —— 它们继续运行直到自然结束（或被 OS 级 SSH 超时配置回收）。这意味着 `--timeout` 能让 CLI 及时返回，但 **不能保证立即释放远端连接**。

**为什么不 kill 子进程**：rsync/scp 在传输 skill 目录中途如果被强制 kill，远端可能进入"部分文件已写入、部分未写入"的半同步状态，下次 push 时 hash 比较结果不可预测。OS 级 SSH 超时（`ConnectTimeout` / `ServerAliveInterval`）由 SSH 协议本身处理半状态恢复，更安全。所以 `--timeout` 故意只在 CLI 层面释放等待，不干预子进程。如果需要严格的进程级超时，请同时配置 `~/.ssh/config` 的 `ConnectTimeout` / `ServerAliveInterval`。

超时后 CLI 输出：
```
✗ Timeout: push to dev-server exceeded 60s
  Check network connectivity or increase --timeout value.
```

**--dry-run 输出格式**（skill 级别摘要）：

```
[dry-run] push to dev-server:

  + skill-one (new)
  ~ skill-two (modified)
  - skill-three (deleted)
  ! skill-four (conflict)

Summary: 4 skill(s), 1 added, 1 modified, 1 deleted, 1 conflict(s)
```

注：dry-run 显示 skill 级别摘要而非文件级别，避免额外的网络请求开销。

### 3.10 `transport.ts` — SSH/rsync 传输

- `fetchRemoteManifest()` — rsync/scp manifest.json
- `rsyncPush()` — rsync -avz --delete（`--delete` 确保远程与本地完全一致，删除远程多余文件）
- `rsyncPull()` — rsync -avz 反方向（**有意不使用 `--delete`**，保护本地可能存在的未纳管文件；pull 只添加/覆盖，不删除本地多余文件）
- `pushManifest()` — 推送 manifest
- `receiverNeedsUpdate()` — 比较本地与远程 receiver 文件的 MD5 hash，判断是否需要重新部署
- `deployReceiver()` — 部署 receiver 文件到远程（仅在 `receiverNeedsUpdate()` 返回 true 时调用）
- `sshExec()` — 执行 SSH 命令

**SSH 命令构建**：所有 rsync/scp 的 `-e` 选项需根据服务器配置动态构建 SSH 命令。如果配置了 `identity_file`（服务器级或全局 `ssh_defaults`），必须通过 `-i` 参数传递给 SSH：
```
rsync -avz -e "ssh -p <port> -i <identity_file>" ...
scp -P <port> -i <identity_file> ...
```

降级：rsync 不可用时，Node 原生逐文件传输（对比 hash 只传变更文件）。

**Symlink 传输规则**：
- **rsync 路径**：`rsync -avz` 中 `-a` 包含 `-l`（保持 symlink 原样传输），skill 目录内部的 symlink 会被保持为 symlink
- **scp fallback push**：使用 `readlink` 读取 symlink target，通过 JSON 格式 `{files: {...}, symlinks: {...}}` 传递给 receiver，receiver 使用 `symlink()` 重建
- **scp fallback pull**：receiver 导出 `{files, symlinks}` 格式，本地使用 `symlink()` 重建
- **Skill 目录本身是 symlink**：调用方传入已解析的实际路径，rsync/scp 传输的是实际内容
- **安全验证**：创建 symlink 前必须验证 target 不是绝对路径且不会逃逸出 skill 目录（防止路径穿越攻击）

### 3.11 `conflict.ts` — 冲突检测与解决

**3-field 模型的三路比较**：
- `local_hash` vs `recorded_hash` → 本地是否相对基准有变更
- `remote_hash` vs `recorded_hash` → 远程是否相对基准有变更

冲突发生条件：两边都相对基准有变更（`local_hash ≠ recorded_hash` 且 `remote_hash ≠ recorded_hash`），且变更内容不同（`local_hash ≠ remote_hash`）。

策略：
- `manual`（默认）：跳过冲突 skill，在 manifest 中标记 `direction: conflict`，用户通过 `syncskill status` 查看、`syncskill resolve` 解决
- `keep-local`：本地覆盖远程
- `keep-remote`：远程覆盖本地

**resolve 命令语法**：
```bash
syncskill resolve <skill>                   # 交互式选择解决方式
syncskill resolve <skill> --local           # 本地覆盖远程
syncskill resolve <skill> --remote          # 远程覆盖本地
syncskill resolve <skill> --diff            # 只显示差异，不解决
syncskill resolve <skill> --local --diff    # 先显示差异，再用本地覆盖
syncskill resolve <skill> --remote --diff   # 先显示差异，再用远程覆盖
```

### 3.12 `refresh.ts` — 自动刷新钩子

```
所有命令前 → autoRefreshManifests()
  遍历所有服务器
    refreshLocalManifest() → 重算本地 hash
    refreshRemoteManifest() → SSH 重算远程 hash
  try-catch：刷新失败只打印 WARNING，不阻断主流程
```

**3-field 模型与外部操作**：

`refreshLocalManifest()` 总是将 `local_hash` 更新为当前实际 hash，但**不修改 `recorded_hash`**。这是 3-field 模型的关键：

```
场景：用户在 syncskill 之外执行 git checkout 还原文件

Pull 后状态:
  local_hash=B, remote_hash=B, recorded_hash=B (in-sync)

Git checkout 后:
  实际文件 hash=A，manifest 未变

下次 push 时 refreshLocalManifest 更新:
  local_hash=A, remote_hash=B, recorded_hash=B

classifySkillDelta(A, B, B):
  A ≠ B (本地相对 recorded 变了) → push ✓
```

`recorded_hash` 保持为上次同步点的值（B），系统正确检测到本地变化（A ≠ B）并触发 push。无需任何特殊的 "in-sync 保护" 逻辑。

**远程 hash 一致性要求**：`refreshRemoteManifest()` 在远程执行的 Node 脚本必须使用 `lstatSync`（而非 `statSync`）来检测文件类型，以确保与本地 `computeHash()`（§3.7）的 symlink 跳过行为一致。使用 `statSync` 会导致 `isSymbolicLink()` 永远返回 false，从而将 symlink 文件内容错误地纳入 hash 计算。

**远程 skill 缺失处理**：当远程 skill 目录不存在时（如被意外删除），`refreshRemoteManifest()` 必须从远程 manifest 中**删除该 skill 条目**（而非保留旧 hash）。这确保后续 `fetchRemoteManifest` → `compareManifests` 能正确识别出远程缺失的 skill（`!rm` → `action: "new"`），触发重新 push。

**refresh 命令**：
```bash
syncskill refresh          # 刷新本地 + 远程 manifest，然后显示状态
syncskill refresh --local  # 只刷新本地 hash
syncskill refresh --remote # SSH 刷新远程 hash
syncskill refresh <server> # 同上，但范围限定到指定 server
```

**flag 组合行为速查**：

| flag | 刷新本地 | 刷新远程 |
|------|:------:|:------:|
| 无 flag | ✓ | ✓ |
| `--local` | ✓ | — |
| `--remote` | — | ✓ |

无 flag 时刷新完成后输出 `status` 等价摘要。`[server]` 参数仅限定操作范围，与 flag 行为正交。

注：原 `refresh --status` 删除——纯"显示状态"用 `status` 命令，更直观。

### 3.13 `receiver/sync_receiver.mjs` — 远程接收脚本

纯 ESM Node 20+ 脚本，零外部依赖：
- `apply` 命令：遍历 `~/.syncskill/skills/` 下 skill
- 根据 `receiver_config.json` 中的 remote_agents 映射创建软链接
- 更新 `manifest.json`
- `export-symlinks <dir>` 命令：导出目录中的 symlink 为 JSON（供 scp fallback pull 使用）

**hash 一致性要求**：receiver 内部的 `computeHash()` 必须使用 `lstatSync`（而非 `statSync`）来检测文件类型，与本地 `computeHash()`（§3.7）及 `refreshRemoteManifest()`（§3.12）保持一致。使用 `statSync` 会导致 `isSymbolicLink()` 永远返回 false，将 symlink 文件内容错误地纳入 hash 计算。

**远程 `receiver_config.json` schema**：

由 `buildReceiverConfig()` 生成，push 时通过 scp 推送到远程 `~/.syncskill/receiver_config.json`：

```json
{
  "remote_agents": {
    "claude": "~/.claude/skills",
    "cursor": "~/.cursor/skills"
  }
}
```

- `remote_agents`：agent 名称 → 远程 skill 目录路径的映射。服务器级 `agents` 配置优先于全局 `agents`（§3.3）。

**远程 `manifest.json` schema** (single-hash snapshot, version 2)：

远程 manifest 是**远端在某时刻的 hash 快照**，与本地 manifest 的 3-field 模型（§3.7）不同。本地 manifest 用 3 个 hash 跟踪 "当前 / 已知远程 / 同步基准"；远端机器作为 receiver 不需要这种角色区分，只需要"我现在每个 skill 的 hash 是什么"这一个事实。schema：

```json
{
  "version": 2,
  "server": "server-name",
  "updated_at": "2026-05-19T00:00:00Z",
  "skills": {
    "skill-name": {
      "hash": "abc123..."
    }
  }
}
```

receiver `apply` 执行后，对远程 `skills/` 目录中每个 skill 重新计算 hash 并写入 `hash` 字段（不再写 `local_hash` / `remote_hash` / `recorded_hash`）。

**`fetchRemoteManifest()` 兼容读取**：本地 `transport.ts` 拉取远端 manifest 后，对每个 skill 优先读 `entry.hash`；若不存在（旧版 receiver 写的 manifest），fallback 读 `entry.local_hash`。读到的值映射为本地 manifest 视角的 `remote_hash`。下次 push 后，receiver 会自动覆盖为新 schema。

**版本迁移**：旧 manifest 仍可读（fallback 路径），但首次 push 后 receiver 会重写为新 schema。无需手动迁移。

### 3.14 `receiver/bootstrap_remote.sh` — 远程部署脚本

- 创建 `~/.syncskill/` 目录结构
- 确保 `node` 可用
- 验证权限

### 3.15 `scan` 命令行为

```
syncskill scan

Scanning for new skills...

Found 2 new skills in sources:
  ✓ Added "new-skill-1" from source "my-repo"
  ✓ Added "new-skill-2" from source "my-repo"

Found 1 unmanaged skill in agent directories:
  ~/.claude/skills/local-experiment

Use `--migrate-unmanaged` to migrate, or ignore if intentional.
```

```
syncskill scan --migrate-unmanaged

Found 1 unmanaged skill in agent directories:
  ~/.claude/skills/local-experiment

Migrate to ~/.syncskill/skills/? [Y/n]   ← safe default Yes
```

- 扫描 sources → 发现新 skill → 直接注册到 links（target 使用 `ensureDefaultLinkTargets()`，与 §3.8 一致）
- 扫描 ~/.syncskill/skills/ → 发现新 skill → 直接注册到 links（target 同上）
- 扫描 agent 目录 → 发现未纳管的 skill：
  - 默认（无 flag）→ 仅提示，不询问、不操作
  - `--migrate-unmanaged` → 询问迁移（safe default = 迁移 + 用 `ensureDefaultLinkTargets()` 注册到 links）

**Plan 行为**（§3.0.B 协议）：

`scan --dry-run` / `scan --plan` 输出将要执行的注册和迁移操作，不写盘：

```
$ syncskill scan --dry-run

Found 2 new skill(s) in sources:
  [dry-run] Would add "new-skill-1"
  [dry-run] Would add "new-skill-2"

Found 1 unmanaged skill(s) in agent directories:
  ~/.claude/skills/local-experiment
  [dry-run] Hint: use --migrate-unmanaged to migrate
```

```
$ syncskill scan --migrate-unmanaged --dry-run

Found 1 unmanaged skill(s) in agent directories:
  [dry-run] Would migrate "local-experiment" to skills/ and add to links
```

注：flag 名为 `--migrate-unmanaged`（更具描述性，明确"迁移的是 unmanaged skill"）。

### 3.16 `source list` 输出格式

```
$ syncskill source list

Sources:

  my-repo (git)
    url:     https://github.com/user/my-repo.git
    path:    ~/.syncskill/sources/my-repo
    branch:  main
    skills:  skill-a, skill-b, skill-c
    ignored: old-skill

  skill-pack (http)
    url:     https://cdn.example.com/skills-v2.tar.gz
    path:    ~/.syncskill/sources/skill-pack
    skills:  http-skill-1, http-skill-2

  local-tools (local)
    path:    /home/user/my-tools
    skills:  tool-a, tool-b

  archive-skills (local)
    path:    ~/.syncskill/sources/archive-skills
    archive: ~/Downloads/my-skills.tar.gz
    skills:  skill-x, skill-y
```

**显示规则**：
- 每个 source 显示：名称、类型、URL（如有）、路径、分支（Git）、archive 路径（本地压缩包）、活跃 skills、忽略的 skills（如有）
- **Label 列宽对齐**：所有字段标签的冒号后用空格补齐，使 value 列对齐到第 9 字符（按最长 label `archive:` / `ignored:` 8 字符 + 1 空格计算）。具体：`url:` 5 空格、`path:` 4 空格、`branch:`/`skills:` 2 空格、`archive:`/`ignored:` 1 空格。
- 无 source 时显示 `No sources configured.`

## 4. 同步协议

```
Phase 1: PREPARE & COMPARE
  ├─ 计算本地 Manifest（MD5 hash）
  ├─ 拉取远程 manifest.json
  ├─ 对比哈希 → 得到 delta
  └─ 检测冲突

Phase 2: TRANSPORT (rsync)
  ├─ 按需部署 receiver（比较 hash，有变化才重传）
  ├─ rsync -avz 推送变更 → remote ~/.syncskill/skills/
  └─ 无 rsync 时 Node 逐文件传输

Phase 3: RECONCILE (远程 receiver)
  ├─ SSH exec "node ~/.syncskill/sync_receiver.mjs apply"
  ├─ 创建/更新 agent 目录软链接
  ├─ 更新双方 manifest
  └─ 拉回最终 manifest 确认
```

## 5. package.json

```json
{
  "name": "syncskill",
  "version": "1.0.0",
  "description": "Multi-device AI Agent Skill sync tool",
  "type": "module",
  "bin": {
    "syncskill": "./dist/index.js"
  },
  "files": [
    "dist",
    "skills"
  ],
  "scripts": {
    "build": "tsc && shx cp -r skills dist/",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "bootstrap": "npm install && npm run build"
  },
  "dependencies": {
    "commander": "^12.x",
    "yaml": "^2.x",
    "@inquirer/prompts": "^8.x",
    "compressing": "^2.x"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "shx": "^0.3.x",
    "tsx": "^4.x",
    "typescript": "^5.x",
    "vitest": "^3.x"
  },
  "engines": {
    "node": ">=20"
  }
}
```

## 6. tsconfig.json

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
  "include": ["src/**/*"]
}
```

## 7. .gitignore

```
dist/
node_modules/
~/.syncskill/
*.log
.DS_Store
.env
```

用户数据全部存放在 `~/.syncskill/` 中，仓库源码不包含用户数据文件。

## 8. 跨平台策略

| 场景 | 策略 |
|------|------|
| 路径处理 | `node:path` 自动适配 `/` 和 `\` |
| 压缩/解压 | `compressing`（跨平台纯 JS，支持 tar.gz/tgz/zip）→ fallback `tar`/`unzip` CLI；bz2/xz 仅 CLI。所有 CLI fallback 先通过 `command -v` 检测可用性，不可用时抛出包含安装指引的错误（如 `apt install xz-utils`） |
| HTTP 下载 | `fetch()`（Node 18+ 原生支持） |
| 文件同步 | 优先 rsync，无 rsync 时 Node fs 逐文件传输 |
| SSH | `child_process.exec('ssh')` |
| Git | `child_process.exec('git')` |
| 软链接 | `fs.symlink()` → `fs.symlink(type='junction')` → `fs.cp()` |

## 9. 文档计划

| 文档 | 内容 |
|------|------|
| `docs/README.md` | 文档索引，快速导航 |
| `docs/design-guide.md` | 架构设计、模块职责、同步协议、冲突处理 |
| `docs/config-guide.md` | config.json 完整字段参考 |
| `docs/usage-guide.md` | CLI 命令参考、日常 workflow、SSH 配置、故障排查 |
| `README.md` | 项目简介、快速开始、架构图、安装 |

## 10. Config Doctor — 配置诊断与修复

### 10.1 概述

`config-doctor` 模块负责检测 `~/.syncskill/config.json` 中的错误和不合理配置，并提供交互式修复能力。

**设计原则**：
- 自动检查：所有命令启动时运行，轻微问题警告，严重问题阻断
- 手动修复：`syncskill doctor --fix` 交互式修复，需用户确认

### 10.2 模块接口

**文件**：`src/config/config-doctor.ts`

```typescript
// 诊断结果项
interface DiagnosticItem {
  code: string;           // 诊断码
  severity: 'error' | 'warning';
  message: string;        // 人类可读描述
  path: string;           // config 中的路径，如 'links.old-skill'
  suggestion?: string;    // 修复建议
}

// 诊断报告
interface DiagnosticReport {
  errors: DiagnosticItem[];    // 严重问题
  warnings: DiagnosticItem[];  // 轻微问题
  isHealthy: boolean;          // errors.length === 0 && warnings.length === 0
  canProceed: boolean;         // errors.length === 0
}

// 修复选项
interface RepairOptions {
  removeInvalidSkillLinks: boolean;
  removeInvalidAgentLinks: boolean;
  removeInvalidAgents: boolean;
  removeInvalidSources: boolean;
}

// 核心函数
function diagnoseConfig(config: SyncSkillConfig, paths: SyncPaths): Promise<DiagnosticReport>;
function repairConfig(config: SyncSkillConfig, report: DiagnosticReport, options: RepairOptions): SyncSkillConfig;
function formatDiagnosticReport(report: DiagnosticReport): string;
function formatDiagnosticSummary(report: DiagnosticReport): string;
```

### 10.3 诊断码

| Code | Severity | 触发条件 | 修复动作 |
|------|----------|---------|---------|
| `NO_VALID_AGENTS` | error | `agents` 中所有路径都不存在 | 阻断，提示运行 `doctor --fix` |
| `AGENT_PATH_INVALID` | warning | 单个 agent 路径不存在 | 从 `agents` 中移除 |
| `SKILL_NOT_FOUND` | warning | `links` 中引用的 skill 在 `~/.syncskill/skills/` 和 sources 中都不存在 | 从 `links` 中移除该 skill |
| `AGENT_NOT_CONFIGURED` | warning | `links[skill]` 中引用的 agent 不在 `agents` 中 | 从该 skill 的 targets 中移除该 agent |
| `SOURCE_PATH_INVALID` | warning | `sources` 中 local 类型的 `path` 不存在 | 从 `sources` 中移除 |
| `REGISTRY_CORRUPT` | warning | `skills-registry.json` 解析失败或 schema 不合法 | 备份损坏文件后重建（只重建 v2 schema 中的 ignored + http_baselines 字段）。若 `--fix` 模式下重建仍失败 → 升级为 `E_REGISTRY_CORRUPT` exit 3 |

**检查顺序**：
1. 检查 `agents` 路径有效性（决定是否 error）
2. 检查 `links` 引用完整性
3. 检查 `sources` 路径有效性
4. 检查 `skills-registry.json` 完整性（见下方）

**注意**：`links[skill]` 的 targets 数组为空是合理情况（临时禁用），不触发诊断。

**skills-registry.json 诊断**：

v2 schema 下 registry 只存 ignored 元信息 + http_baselines。诊断流程：

1. 文件不存在 → 静默创建空 registry（非错误）
2. JSON 解析失败 / schema 不合法 → `REGISTRY_CORRUPT`，`--fix` 时备份为 `skills-registry.json.bak` 然后重建空 registry
3. v1 schema → 自动迁移到 v2（保留 ignored 状态 + 从 v1 的 last_update_hash 字段提取 http baseline），不报错

重建逻辑（v2）：扫描 `config.sources` 中所有 HTTP source 的 skill，计算当前 hash 作为新 baseline；ignored 状态从 v1 迁移或为空。

### 10.4 CLI 命令

```
syncskill doctor [--fix] [-y/--yes]
```

| 参数 | 说明 |
|------|------|
| （无参数） | 只诊断，输出报告，不修复（等同于 dry-run） |
| `--fix` | 交互式修复（逐项确认） |
| `--fix -y` | 自动修复所有可修复项 |

**诊断模式输出**：

```
$ syncskill doctor

Config Diagnosis
────────────────────────────────────────

✗ Error: No valid agents configured
  All agent paths are invalid. At least one is required.

⚠ Warning: links.old-skill
  Skill "old-skill" not found in ~/.syncskill/skills/ or sources

⚠ Warning: links.web-tools → hermes
  Agent "hermes" not configured in agents

⚠ Warning: agents.qoder
  Path ~/.qoder/skills does not exist

────────────────────────────────────────
1 error, 3 warnings

Run `syncskill doctor --fix` to repair.
```

**修复模式输出**：

```
$ syncskill doctor --fix

Found 3 issues to fix:

? Remove "old-skill" from links? (skill not found) (Y/n) y
✓ Removed links.old-skill

? Remove "hermes" from links.web-tools targets? (agent not configured) (Y/n) y
✓ Removed hermes from links.web-tools

? Remove "qoder" from agents? (path does not exist) (Y/n) n
⊘ Skipped agents.qoder

────────────────────────────────────────
Fixed 2 of 3 issues. Config saved.
```

### 10.5 自动检查集成

**执行流程**：

```
命令执行流程：
  loadConfig()
  → autoDiagnoseConfig()  ← 新增
  → autoRefreshManifests()
  → 命令主逻辑
```

**触发范围**：所有命令（除 `init`、`config`、`refresh`、`doctor` 外）。`autoDiagnoseConfig()` 与 `autoRefreshManifests()` 共用同一个 `preAction` 钩子，排除集相同（与 §3.1 一致）。

排除原因：
- `init`：尚未创建 config，钩子无配置可读
- `config`：用户正在修配置，刷新没有意义
- `refresh`：命令本身就是手动刷新，避免重复
- `doctor`：需要在配置不健康时仍能运行（autoDiagnose 会因配置坏掉先崩溃）

**autoDiagnoseConfig() 行为**：

```typescript
async function autoDiagnoseConfig(config: SyncSkillConfig, paths: SyncPaths): Promise<void> {
  const report = await diagnoseConfig(config, paths);

  if (report.isHealthy) return;  // 无问题，静默通过

  // 打印警告摘要（精简为一行）
  console.error(formatDiagnosticSummary(report));

  if (!report.canProceed) {
    // 严重问题，阻断
    console.error('Run `syncskill doctor --fix` to repair.');
    process.exit(1);
  }

  // 轻微问题，继续执行（警告已打印）
}
```

**自动检查输出示例**：

```
$ syncskill link add my-skill cursor

⚠ Config has 2 issues (run `syncskill doctor` to fix)

✓ Linked my-skill to: cursor
```

## 11. AI Agent / 脚本接入

syncskill 管的是 AI agent 的 skill 文件，本身也必须能被 AI agent / shell 脚本可靠驱动。本节定义 syncskill 在"机器消费者"视角下的契约。

### 11.1 输出模式

| 模式 | 触发条件 | 适用 |
|------|---------|------|
| `text`（默认） | 无 `--json` | 人类终端 |
| `json` | `--json` 全局 flag 出现 | AI agent / 脚本 |

`text` 与 `json` 互斥。两者输出**同一份事件流**，仅渲染不同。

### 11.2 JSONL 事件协议（`--json` 模式）

`--json` 模式下，stdout 是 **JSON Lines**（每行一个 JSON 对象，行尾 `\n`），stderr 不输出（除内部崩溃栈）。每条事件至少包含 `type` 字段。事件按时间顺序流式产出，调用方可以边读边解析。

事件类型：

| `type` | 触发场景 | 必含字段 | 可选字段 |
|--------|---------|---------|---------|
| `progress` | 进度更新（如 "Cloning..."） | `phase`, `message` | `pct` |
| `info` | 中性信息（如 "Source 'x' up to date"） | `message` | `data` |
| `change` | 状态变更（add / modify / delete / link / unlink） | `op`, `entity`, `name` | `before`, `after`, `target` |
| `warning` | 非阻断警告（如 doctor warning） | `code`, `message` | `path`, `hint` |
| `error` | 阻断错误 | `code`, `message` | `path`, `hint`, `cause` |
| `prompt` | 需要用户输入（仅交互模式发出） | `code`, `question`, `options` | `default` |
| `result` | 命令最终结果，每次调用至多一条且总在最后 | `command`, `ok`, `summary` | `data` |

**示例**（`syncskill --json push prod`）：

```jsonl
{"type":"progress","phase":"refresh","message":"Refreshing manifests"}
{"type":"change","op":"push","entity":"skill","name":"skill-a","before":"abc123","after":"def456"}
{"type":"warning","code":"W_SKILL_NOT_FOUND","message":"Skill 'old-tool' missing from disk","path":"links.old-tool"}
{"type":"result","command":"push","ok":true,"summary":{"pushed":1,"skipped":0,"conflicts":0,"warnings":1}}
```

`result` 事件的 `summary.data` 字段对应每个命令的领域数据（如 `status` 命令返回 per-skill 状态数组），具体 schema 见各命令章节。

`change.op` 取值固定枚举：`add | modify | delete | link | unlink | push | pull | resolve | restore | stash | backup`。`change.entity` 取值固定枚举：`skill | source | agent | server | link | manifest | registry`。

### 11.3 退出码（exit codes）

文档化的退出码，调用方可以**只看 exit code 决策**而不解析输出：

| Exit code | 含义 | 例子 |
|-----------|------|------|
| `0` | 成功 | 命令完成，无错误 |
| `1` | 通用错误（运行时未分类） | 内部 panic / 未捕获异常 |
| `2` | 用法错误 | 未知参数、缺少必填位置参数 |
| `3` | 配置错误 | doctor 检测到 `error`-级问题且无 `--fix` |
| `4` | 需要输入但无法获取 | `--no-interactive` 模式下遇到 prompt |
| `5` | 网络/远端错误 | SSH / rsync 失败、超时 |
| `6` | Dirty / 安全保护跳过 | `update` 跳过 dirty source、push 检测到冲突 |
| `7` | 冲突未解决 | `resolve` 未提供决议、sync 计划中存在未决冲突 |
| `8` | 远端不一致 | receiver 部署失败、远端 manifest 损坏 |

**`-y/--yes` 与 exit code**：`-y` 让 prompt 默认前进，不会触发 `4`。`--no-interactive` 不暗示 `-y`：遇到 prompt 直接 `4`，由调用方决定是否重跑加 `-y`。

### 11.4 错误码（error codes）

每条 `error` / `warning` 事件都带 `code` 字段（`E_*` 前缀的稳定字符串），调用方可以基于 code 路由处理逻辑而不依赖 `message` 文本。code 一旦发布即视为 API 表面，**不破坏性变更**。

核心错误码（非穷举，命令章节可定义子集）：

| Code | Severity | 含义 | exit code |
|------|----------|------|-----------|
| `E_USAGE` | error | 参数错误 | 2 |
| `E_AGENT_NOT_CONFIGURED` | error | 引用了未配置的 agent | 2 |
| `E_SKILL_NOT_FOUND` | error | skill 不存在 | 2 |
| `E_SOURCE_NOT_FOUND` | error | source 不存在 | 2 |
| `E_SERVER_NOT_FOUND` | error | server 不存在 | 2 |
| `E_NEEDS_INPUT` | error | `--no-interactive` 下需要输入 | 4 |
| `E_NO_VALID_AGENTS` | error | doctor: 所有 agent 路径都失效 | 3 |
| `E_REGISTRY_CORRUPT` | error | doctor: registry 损坏 | 3 |
| `E_NETWORK` | error | 网络/SSH 失败 | 5 |
| `E_TIMEOUT` | error | 操作超时 | 5 |
| `E_SOURCE_DIRTY` | warning/error | source dirty，无 `--force` 时降级为 warning + skip | 6 |
| `E_CONFLICT` | error | sync/push 检测到内容冲突 | 7 |
| `E_RECEIVER_DEPLOY` | error | receiver 部署失败 | 8 |
| `W_AGENT_PATH_INVALID` | warning | doctor warning（`W_*` 前缀仅用于 warning 级别） | — |
| `W_SKILL_NOT_FOUND` | warning | doctor warning | — |
| `W_REGISTRY_CORRUPT` | warning | doctor warning（registry 损坏，会自动备份重建） | — |

**前缀约定**：`E_*` = error 级别（伴随非 0 exit code），`W_*` = warning 级别（exit 0，但事件流里出现）。同一逻辑问题可能既有 `E_FOO` 又有 `W_FOO`：取决于上下文是否阻断。

### 11.5 `--no-interactive` 契约

任何会 prompt 用户的代码路径，在 `--no-interactive` 下必须：

1. 不打开 TUI / 不阻塞 stdin
2. 输出一条 `prompt` 事件（仅 `--json` 模式；text 模式输出等价 stderr 行）
3. 输出 `error` 事件，`code: "E_NEEDS_INPUT"`，`hint` 字段告诉调用方如何用 flag 跳过该 prompt
4. `exit 4`

举例：

```jsonl
$ syncskill --json --no-interactive link edit my-skill
{"type":"prompt","code":"NEEDS_LINK_TARGETS","question":"Choose agents to link my-skill to","options":["claude","agents","cursor"]}
{"type":"error","code":"E_NEEDS_INPUT","message":"`link edit` opens an interactive matrix editor","hint":"Use `link set my-skill <agent>...` (overwrite), `link add my-skill <agent>` (append), or `link clear my-skill` for non-interactive control"}
```

调用方拿到 `hint` 后改用非交互形式重跑。**`hint` 应总是可执行的命令片段**，避免"see docs"式无效提示。

**与 `-y` / `--force` / `--dry-run` 的组合行为**：详见 §3.0.5 组合矩阵。`--no-interactive` 与 `-y` 是正交的（独立、可组合），最 AI-friendly 的组合是 `--no-interactive -y --json`。

### 11.6 各命令的 `--json` 输出契约

下列命令在 `--json` 模式下，`result.summary.data` 字段必须返回结构化数据。本节列出所有 mutate 状态命令的完整 schema。

#### 11.6.0 实现要求（强制约定）

- **任何 mutate state 的命令必须返回 `data.changes` 或等价字段**（不能只返回计数）
- **text 渲染从 data 派生**：`renderText(data)`，不允许独立组装人类文本
- **plan/result 可追溯**：每个 plan action 在 result 中必须能找到对应记录（成功 / 跳过 / 失败 + 原因）。result 不要求与 plan **结构同构**——分类输出（`skills.installed`、`updated[]` 等）允许，但语义上必须可与 plan 的 `actions[]` 逐项核对
- **skill 标识字段命名约定**：父键已表明是 skill 集合（如 `skills.installed`、`removed_skills`、`migrated_skills`）时，子项用 `name`；父键是泛化操作集合（如 `changes`、`deltas`、`local_changes`、`affected_servers`）时，子项用 `skill` 显式标识

#### 11.6.1 `syncskill` (dashboard)

```json
{ "skills": {...}, "sources": [...], "agents": [...], "servers": [...], "health": {...} }
```

#### 11.6.2 `status`

```json
{ "servers": [{ "server": "prod", "skills": [{ "name": "skill-a", "status": "in-sync", "action": "skip" }] }] }
```

#### 11.6.3 `diff <server>`

```json
{
  "server": "prod",
  "deltas": [
    { "skill": "skill-a", "action": "push", "local_hash": "...", "remote_hash": "...", "recorded_hash": "..." }
  ]
}
```

#### 11.6.4 `source list`

```json
{ "sources": [SourceConfig 序列化, ...] }
```

#### 11.6.5 `link list`

```json
{ "matrix": [{ "skill": "skill-a", "agents": { "claude": "linked", "cursor": "missing" } }] }
```

#### 11.6.6 `install` / `install --self`

```json
{
  "source": { "name": "my-repo", "type": "git", "url": "...", "path": "..." },
  "skills": {
    "installed": [{ "name": "skill-a", "path": "..." }],
    "ignored": [{ "name": "skill-c", "reason": "user-deselected" }],
    "already_installed": ["skill-d"]
  },
  "links_created": [
    { "skill": "skill-a", "agent": "claude", "path": "~/.claude/skills/skill-a" }
  ]
}
```

#### 11.6.7 `update [name]`

```json
{
  "updated": [
    {
      "name": "my-repo",
      "type": "git",
      "before_commit": "abc1234",
      "after_commit": "def5678",
      "skills": {
        "modified": ["skill-a"],
        "added": ["skill-d"],
        "removed": ["skill-old"]
      }
    }
  ],
  "skipped": [
    { "name": "company", "reason": "dirty", "dirty_skills": ["skill-a"], "hint": "git -C ... stash && syncskill update company && git -C ... stash pop" }
  ],
  "failed": []
}
```

#### 11.6.8 `source remove <name>`

```json
{
  "name": "my-repo",
  "mode": "completely",
  "deleted_paths": ["~/.syncskill/sources/my-repo"],
  "removed_skills": ["skill-a", "skill-b"],
  "removed_links": [{ "skill": "skill-a", "agents": ["claude"] }]
}
```

#### 11.6.9 `scan` / `scan --migrate-unmanaged`

```json
{
  "new_in_sources": [{ "name": "skill-x", "source": "my-repo", "registered": true }],
  "unmanaged_in_agents": [{ "name": "local-experiment", "path": "~/.claude/skills/..." }],
  "migrated": [{ "name": "local-experiment", "to": "~/.syncskill/skills/..." }]
}
```

#### 11.6.10 `link set/add/remove/clear/apply`

```json
{
  "changes": [
    {
      "skill": "my-skill",
      "config_before": ["claude"],
      "config_after": ["claude", "cursor"],
      "symlinks_created": [{ "agent": "cursor", "path": "..." }],
      "symlinks_removed": []
    }
  ]
}
```

**AI agent 优先**：用 `set` + `apply`，避免 `add` / `remove`（人类 verb，多 agent 并发时易互相覆盖）。

#### 11.6.11 `refresh [server]`

```json
{
  "scope": ["server-a"],
  "local_changes": [{ "skill": "skill-a", "before": "abc", "after": "def" }],
  "remote_changes": []
}
```

#### 11.6.12 `init`

```json
{
  "created_paths": ["~/.syncskill/", "~/.syncskill/config.json"],
  "detected_agents": ["claude", "cursor"],
  "migrated_skills": [{ "name": "skill-a", "from": "~/.claude/skills/skill-a" }],
  "installed_self": true
}
```

#### 11.6.13 `resolve <skill>`

```json
{
  "skill": "my-skill",
  "resolution": "local",
  "applied_hash": "abc123",
  "affected_servers": [
    { "server": "prod", "before": "xyz789", "after": "abc123" },
    { "server": "dev",  "before": "qqq000", "after": "abc123" }
  ]
}
```

#### 11.6.14 `doctor` / `doctor --fix`

```json
{
  "errors": [DiagnosticItem],
  "warnings": [DiagnosticItem],
  "fixed": [{ "code": "...", "path": "...", "action": "removed" }],
  "skipped": [{ "code": "...", "path": "...", "reason": "user-declined" }]
}
```

#### 11.6.15 `push` / `pull` / `sync`

```json
{
  "pushed": 3,
  "pulled": 1,
  "skipped": 2,
  "conflicts": 0,
  "warnings": 1,
  "changes": [
    { "op": "push", "skill": "skill-a", "server": "prod", "before": "abc", "after": "def" }
  ]
}
```

### 11.7 兼容性承诺

- `code` 字符串值视为 API：新增不破坏，重命名/删除走 deprecation（先在 `result.summary.deprecations` 列出 → 至少一个 minor 版本后移除）
- `type` 与必含字段视为 API
- exit codes `0..8` 视为 API；新增 code 走"先大于 8"
- `--json` 输出对未知字段宽容（调用方应忽略不认识的 key）

### 11.8 环境变量

CLI flag 的环境变量等价。优先级：**显式 flag > 环境变量 > 内置默认**。

| 变量 | 等价 flag | 说明 |
|------|----------|------|
| `SYNCSKILL_DIR` | `--sync-dir` | 覆盖 `~/.syncskill/` 目录路径 |
| `SYNCSKILL_CONFIG` | `--config` | 覆盖 config 文件路径 |
| `SYNCSKILL_NO_INTERACTIVE` | `--no-interactive` | 设为 `1` 启用（CI 环境批量设置） |
| `SYNCSKILL_JSON` | `--json` | 设为 `1` 启用 |
| `SYNCSKILL_TIMEOUT` | `--timeout` | 默认网络超时秒数 |
| `SYNCSKILL_LOG_LEVEL` | — | `error` / `warn` / `info` / `debug`（不影响 JSONL 契约，仅控制非结构化日志详细度） |
| `NO_COLOR` | — | 标准约定，关闭 ANSI 着色（text 模式） |

**使用示例**：

```bash
# CI 脚本统一禁用交互
export SYNCSKILL_NO_INTERACTIVE=1
export SYNCSKILL_JSON=1
syncskill push prod

# 沙箱环境用自定义 sync dir
SYNCSKILL_DIR=/tmp/sandbox-syncskill syncskill init
```

### 11.9 stdout / stderr 契约

| 模式 | stdout | stderr |
|------|--------|--------|
| text（默认） | progress / info / change / result（人类文本） | warning / error（人类文本） |
| `--json` | **所有事件**（progress / info / change / warning / error / prompt / result，JSONL） | 仅 panic stack trace（CLI 自身崩溃） |

**关键约定**：

- `--json` 模式下错误事件也走 stdout，让 AI agent **单流解析**，不用拼 stdout+stderr
- text 模式下 error 走 stderr（符合 Unix 习惯）
- **退出前必须 flush stdout**，防止 AI agent 读到截断的 JSONL
- stderr 永远是 best-effort 人类文本或 panic trace，不属于 API 表面

### 11.10 CLI Self-Introspection

让 AI agent / skill 不依赖解析 help text 就能发现命令面与 schema。

**`syncskill --help --json`**：

输出所有命令、子命令、flag、位置参数的结构化描述：

```json
{
  "version": "1.x.y",
  "commands": [
    {
      "name": "install",
      "aliases": ["i"],
      "args": [{ "name": "url-or-path", "required": false }],
      "flags": [
        { "name": "--self", "type": "boolean", "description": "..." },
        { "name": "--name", "type": "string", "description": "..." }
      ]
    }
  ],
  "global_flags": [
    { "name": "--json", "type": "boolean" },
    { "name": "--dry-run", "type": "boolean" }
  ]
}
```

**`syncskill schema <command>`**：

输出该命令的 plan / result / data 完整 JSON Schema，给 AI agent 校验输入用：

```bash
syncskill schema install
# → {
#     "plan_schema": {...},      // 该命令产出的 plan JSON Schema
#     "result_data_schema": {...}, // result.summary.data 的 schema
#     "resolutions_schema": {...}  // --resolutions 文件的 schema
#   }
```

**设计目的**：未来新增命令 / 修改 schema 时，skill prompt 无需更新——agent 启动时跑一次 `syncskill --help --json` 自动学习。

### 11.11 JSON-only Config（自动迁移）

**`~/.syncskill/config.json` 是唯一配置格式**。JSON 对 AI agent 更友好（无缩进歧义、无 multi-doc、无 anchor），让 AI 读写 config 更可靠。

**读取逻辑**：

1. `--config <path>` / `$SYNCSKILL_CONFIG` 显式指定 → 用该文件
2. 默认目录下 `config.json` 存在 → 用 JSON
3. 默认目录下 `config.yaml` 存在（旧版遗留）→ 读取并**自动迁移**（见下方）
4. 两者都不存在 → 报错 `E_CONFIG_NOT_FOUND`

**自动迁移**：任何 config 写操作（`config set`、`link set`、`install`、矩阵编辑器保存等）在首次写入时自动执行：

1. 读取 `config.yaml`
2. 写入 `config.json`
3. 删除 `config.yaml`
4. 输出 `info` 事件：`Migrated config.yaml → config.json`

迁移后所有后续操作只读写 `config.json`。用户无需手动操作。

**`init` 命令**：直接创建 `config.json`（不创建 YAML）。

**显式指定路径**：`--config /path/to/custom.yaml` 仍可用——按扩展名解析格式，但写入时保持原格式（不迁移用户显式指定的文件）。
