# Syncskill — TypeScript 实现设计

> 更新日期：2026-05-11
> 状态：草稿

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
    ├── index.ts                   # CLI 入口 (commander)
    ├── repo.ts                    # init 命令：目录结构 + 配置模板
    ├── install.ts                 # install 命令：内置 skill 安装、从 URL/路径安装
    ├── linker.ts                  # 软链接管理（三级降级）+ expandLinkTargets
    ├── source.ts                  # 外部来源 (git clone/pull, HTTP tar.gz/zip)
    ├── refresh.ts                 # 全局自动刷新钩子
    ├── config/
    │   ├── types.ts               # TypeScript 类型定义 (SyncSkillConfig, SourceConfig, etc.)
    │   ├── config.ts              # YAML 加载 + 自动检测 agent 目录
    │   ├── config-ui.ts           # 交互式 TUI 配置菜单 (@inquirer/prompts)
    │   ├── config-doctor.ts       # 配置健康诊断与修复 (agents/links/sources/registry)
    │   └── matrix-editor.ts       # 二维矩阵编辑器组件 (@inquirer/core createPrompt)
    ├── core/
    │   ├── manifest.ts            # MD5 hash + manifest 读写/比较
    │   ├── sync_engine.ts         # push/pull/sync 核心流程
    │   ├── transport.ts           # SSH/rsync 传输 + 降级
    │   ├── conflict.ts            # 三路冲突检测与解决
    │   ├── server.ts              # 服务器配置格式化输出
    │   └── skills-registry.ts     # 统一 skills 注册表 (skills-registry.json)
    ├── utils/
    │   ├── utils.ts               # 共享工具函数 (isNotFoundError, pathExists)
    │   ├── archive.ts             # 归档检测 + 跨平台解压 (compressing → CLI fallback)
    │   └── backup.ts              # 备份管理 (dirty skill 备份与元信息)
    └── receiver/
        ├── bootstrap_remote.sh    # 远程部署脚本
        └── sync_receiver.mjs      # 远程零依赖接收脚本

~/.syncskill/                    # init 后创建的本地数据目录
├── config.yaml                    # 用户配置
├── skills/                        # 手动管理的 skill
├── manifests/                     # 各服务器同步状态 (JSON per server)
│   └── <server>.json
├── manifest_history.json          # hash 变更历史
├── skills-registry.json           # skill 注册表（来源映射 + 忽略状态，统一管理）
├── backups/                       # --force 更新前的备份（按 source/skill 组织）
│   └── <source-name>/
│       ├── <skill-name>/          # 每个 skill 只保留最新一份
│       └── _meta.json             # 备份元信息（时间、原因、原始 hash）
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

**通用设计原则**：

- **CLI 输出只显示变化**：命令执行后只输出实际发生变化的条目（新增、删除、错误等），不输出未变化的条目（如 already-linked）。如果完全没有变化，输出一条简短的汇总消息（如 `All links are up to date.`）。`--dry-run` 模式同样遵循此原则，显示"将要变化"的条目。
- **别名命令复用核心逻辑**：当一个命令是另一个命令的别名或组合（如 `install` = `source add` + `auto-link`），禁止重新实现持久化逻辑，必须复用核心命令的写入路径。这确保核心逻辑发生变更时，所有入口点自动获得修复。
- **Skill/Source 变更的不变量**：所有会改变 skill 或 source 状态的入口点（`install`、`source add`、`source update`、`scan`）都必须保证以下三个副作用完整执行：
  1. config.sources 持久化（新增/修改 source 条目）
  2. config.links 持久化（新增 skill 映射）
  3. skills-registry.json 刷新（保证 registry 与实际状态一致）

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
| `init [--skip-scan] [--skip-skill] [-y/--yes]` | 创建 `~/.syncskill/` 目录结构和 config.yaml，交互式询问是否安装 syncskill skill |
| `install` | TTY 下交互式菜单，让用户选择安装来源；非 TTY 下显示帮助 |
| `install self` / `install --self` | 安装内置 syncskill skill（`self` 是保留关键字，本地 `./self` 目录请用 `install ./self`） |
| `install <url-or-path>` / `i <url-or-path>` | 等同于 `source add` + 自动 link |

`install` 完整参数：
- `--self`：安装内置 syncskill skill（与 `install self` 等效）
- `--name <name>`：指定 source 名称
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--branch <branch>`：Git 分支（默认自动检测）
- `-y/--yes`：跳过确认

**Link 管理**

| 命令 | 说明 |
|------|------|
| `link` | 进入 skills × agents 全局矩阵编辑器 |
| `link <skill>` | 进入单 skill 矩阵编辑器（编辑该 skill 的 agent 映射）— 交互式命令 |
| `link <skill> <agent>` | 追加链接：将 skill 链接到指定 agent 并更新 config（第二参数必须是已配置的 agent，否则报错） |
| `link <skill> --all` | 将 skill 链接到所有已配置的 agents 并写入 config（通配符语义，见下方说明） |
| `link --apply` | 按 config 配置执行 reconcile：创建/删除软链接使实际状态与 config.links 一致 |
| `link list` / `link ls` | 显示链接状态矩阵 |
| `link -v/--verbose` | 与 `list` 组合使用，显示文字状态而非符号 |
| `link --dry-run` | 预览 `link --apply` / `link <skill> --all` 等可预览的链接操作 |
| `unlink <skill> [-y/--yes]` | 删除 skill 在所有 agent 中的软链接并从 config.links 移除（交互确认，`-y` 跳过） |

注：`list` / `ls` 是保留子命令。如果存在与之同名的 skill，子命令优先匹配；要管理这种 skill，使用显式形式 `link <skill> <agent>` / `link <skill> --all` 或全局矩阵编辑器 `link`。

**`link <skill> <agent>` 参数校验**：第二参数必须在 `config.agents` 中存在，否则报错 `Agent '<name>' not configured`。

**`link <skill>` 是交互式命令**：

- 进入单 skill 矩阵编辑器需要 TTY。
- 不接受 `--dry-run`：交互式编辑器没有 dry-run 概念，传 `--dry-run` 会报错并提示用户改用 `link <skill> --all --dry-run` 或 `link --apply --dry-run`：
  ```
  Error: link <skill> does not support --dry-run (interactive editor).
  Use `link <skill> --all --dry-run` or `link --apply --dry-run` instead.
  ```
- 非 TTY（CI、管道输入、`-y` 模式）下报错并提示用户使用显式形式：
  ```
  Error: link <skill> requires an interactive terminal.
  Use `link <skill> <agent>` or `link <skill> --all` instead.
  ```

**`link <skill> --all` 写入通配符 `["*"]`**：

`config.links[skill]` 写入 `["*"]` 而非展开后的 agent 名列表。这是**通配符语义**：将来新增的 agent 会自动被包含，而不是当前 agent 的快照。如果用户希望只链接到当前的 agents 列表，应该使用矩阵编辑器或 `link <skill> <agent>` 逐个指定。

**Source 管理**

| 命令 | 说明 |
|------|------|
| `source add <url-or-path>` | 添加外部来源（支持 GitHub URL、本地压缩包文件） |
| `source list` / `source ls` | 列出来源 |
| `source update [name] [--all] [--force]` | 更新指定来源（仅 git/http 有 URL 的），无参数交互式选择 |
| `source remove <name> [--force]` | 移除外部来源（交互式选择处理方式；`--force` 直接 Remove completely: config + files + links） |
| `source restore <source-name>` | 恢复被 `--force` 覆盖的 dirty source（交互式选择恢复方式） |

`source add` 完整参数：
- `--name <name>`：指定 source 名称（默认从 URL 推断）
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--type git|http|local`：指定来源类型（默认自动检测）
- `--branch <branch>`：Git 分支（默认自动检测）
- `-y/--yes`：跳过确认，自动选中所有 skills

`source update` 完整参数：
- `[name]`：指定要更新的 source 名称（不带参数 = `--all`）
- `--all`：更新所有可更新的 source（显式写法，与不带参数等效）
- `-y/--yes`：跳过 HTTP sources 的批量确认；dirty source 自动 skip（安全优先）
- `--force`：强制更新 dirty source（git source 先 stash，http source 先备份到 `backups/`；记录恢复信息到 `update-history.json`，可通过 `source restore` 恢复）
- `--dry-run`：预览更新操作但不执行（dirty 检测仍会执行，只打印 dirty source）

**Update 快捷命令**

| 命令 | 说明 |
|------|------|
| `update [name] [--all] [-y/--yes] [--force]` | `source update` 的顶级别名 |

**Scan 扫描**

| 命令 | 说明 |
|------|------|
| `scan` | 扫描 sources 中新增的 skill + 检测 agent 目录中未纳管的 skill |
| `scan --migrate` | 将 agent 目录中未纳管的 skill 迁移到 ~/.syncskill/skills/ |
| `scan --dry-run` | 预览扫描结果，不执行任何操作 |

**Server 管理**

| 命令 | 说明 |
|------|------|
| `server` | 进入服务器管理菜单 |
| `server list` / `server ls` | 列出已配置的远程服务器 |
| `server show <name>` | 显示指定服务器的配置详情 |
| `server probe <name>` | 诊断服务器状态（SSH 连通性、Node 版本、receiver 部署状态、最后同步时间） |

**Remote 管理**

| 命令 | 说明 |
|------|------|
| `remote` | 进入 skills × servers 矩阵编辑器 |

**同步操作**

| 命令 | 说明 |
|------|------|
| `push [server] [--all] [-y/--yes] [--dry-run] [--timeout <s>]` | 推送到远程；无参数时交互式选择服务器 |
| `pull [server] [--all] [-y/--yes] [--dry-run] [--timeout <s>]` | 从远程拉取；无参数时交互式选择服务器 |
| `sync [server] [--all] [--dry-run] [--timeout <s>]` | 双向同步：pull → refresh → push 串行执行；带 server 参数时只针对该服务器，否则覆盖所有 servers |
| `status` | 显示所有 tracked manifests 的同步状态 |
| `diff <server>` | 显示指定服务器的待同步变更 |
| `resolve <skill>` | 交互式解决冲突 |
| `resolve <skill> --local` | 保留本地版本，覆盖远程 |
| `resolve <skill> --remote` | 保留远程版本，覆盖本地 |
| `resolve <skill> --diff` | 只显示 hash 差异 |
| `refresh [server]` | 刷新 manifest 状态（默认 `--all --status`） |
| `refresh --local` | 只刷新本地 hash |
| `refresh --remote` | 只刷新远程 hash |
| `refresh --status` | 刷新后显示状态 |

**Config 配置**

| 命令 | 说明 |
|------|------|
| `config` | 进入交互式配置主菜单 |
| `config show` | 打印当前配置（JSON 格式） |
| `config set <key> <value>` | 设置单个配置项 |
| `config set --show-paths` | 显示所有可配置的路径 |

注：`config link`、`config server`、`config remote` 已废弃，请使用顶级命令 `link`、`server`、`remote`。

**全局参数**：
- `--no-refresh`：跳过自动刷新
- `-y` / `--yes`：跳过交互确认
- `--dry-run`：预览变更但不执行
- `--force`：强制执行（update 时覆盖 dirty 状态）

所有命令（除 `init`、`config`、`refresh`）执行前自动调用 `autoRefreshManifests()` 钩子。

**3+ 服务器提示**：当服务器数量 ≥ 3 时，以下场景会打印提示：
- `init` 命令结束后
- 退出 `config server` UI 时（如果服务器数量从 <3 变为 ≥3）

```
Note: With 3+ servers, auto-refresh may be slow.
Use --no-refresh to skip, then run `syncskill refresh` manually.
```

### 3.2 `config.ts` — 配置加载与验证

- 加载 `~/.syncskill/config.yaml`（使用 `yaml` npm 包）
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
- **`ensureDefaultLinkTargets()`**（原 `computeDefaultLinkTargets`，重命名以反映副作用）：`install`、`source add`、`init` 迁移等场景自动为新 skill 计算默认 link target，**该函数有副作用**：会在必要时创建 `~/.agents/skills/` 目录、写入 `config.agents.agents` 字段并 `saveConfig()`。规则：
  1. 默认 target 为 `["agents"]`（即 `~/.agents/skills/`，跨客户端标准目录）
  2. 若 `~/.agents/` 父目录不存在，**自动创建** `~/.agents/skills/`，把 `agents` 加入 `config.agents`，并落盘 `config.yaml`，输出提示：
     ```
     Created ~/.agents/skills/
       This is the standard shared skills directory for agents that support it.
       Skills linked here are available to: claude, windsurf, codex, ...
     ```
     （仅首次创建时打印此提示；幂等：第二次调用不会重复打印或重复落盘）
  3. 遍历已检测到的 agent，若该 agent 属于 `private_agents`（不读取共享目录），则追加到 target 列表
  4. 返回最终 target 数组，如 `["agents", "cursor", "kiro"]`
- **`private_agents` 配置**：不读取 `~/.agents/skills/` 共享目录的 agent 列表，需要单独 link 到其专有目录。这些 agent 只读取自己的 `~/.<agent>/skills/` 目录。
  - **默认值**（硬编码）：`["claude", "codex", "gemini", "cursor", "kiro", "augment", "cline", "hermes"]`
  - **config.yaml 初始化**：`init` 命令生成 `config.yaml` 时，自动写入 `private_agents` 字段的默认值，方便用户查看和修改
  - **用户覆盖**：可在 `config.yaml` 中修改 `private_agents` 字段（完全覆盖，非 merge）：
    ```yaml
    # config.yaml
    private_agents:
      - claude
      - codex
      - gemini
      - cursor
      - kiro
      - augment
      - cline
      - hermes
      - my-custom-agent  # 用户新增的不支持共享目录的 agent
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
- **sources 管理**：与 `source list/add/update` 命令对等，提供交互式引导添加
- **conflict_resolution 管理**：下拉选择 `manual` / `keep-local` / `keep-remote`

**所有子菜单均支持 Esc 返回功能**：
- 统一行为：从子菜单进入的嵌套层级中，Esc 始终返回上一级；在主菜单（第一层）按 Esc 退出 CLI
- 所有修改即时生效，Esc 退出子菜单时自动调用 `saveConfig()` 写入 config.yaml

**config.yaml links 保存时的通配符优化**：保存 links 配置时，如果某个 skill 选中了所有已配置的 agents，写入 `["*"]` 而不是逐个列出所有 agent 名称。这使 config.yaml 更简洁可读。

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

**config link 保存时的通配符优化**：如果某个 skill 选中了所有已配置的 agents，保存时写入 `["*"]` 而不是逐个列出所有 agent 名称。

**`link`**（无参数）：直接调用矩阵编辑器。退出矩阵编辑器后，若 links 配置发生了变更，交互式询问用户是否立即 apply（等效于 `link --apply`，创建/清理 symlink 使实际状态与配置一致）。用户确认则执行 reconcile，拒绝则仅保存配置不操作 symlink。

**`config link`**（已废弃，行为与 `link` 一致）：退出矩阵编辑器后同样触发 apply 询问。

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

**重名 skill 处理**：`list` / `ls` 子命令优先匹配。要操作与之同名的 skill，使用显式形式 `link <skill> <agent>` / `link <skill> --all`，或在全局矩阵编辑器 `link` 中管理该 skill。

**`config server`**：直接进入服务器管理菜单。

**`config remote`**：直接调用矩阵编辑器，skills × servers 映射。

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
- 生成 `~/.syncskill/config.yaml`（含自动检测的 agent）
- 复制 `config.example.yaml` 作为参考
- **自动迁移已有 skills（默认行为）**：当 `~/.syncskill/` 目录不存在或 `~/.syncskill/skills/` 为空时，按顺序扫描 agent 目录，将发现的 skill 复制到 `~/.syncskill/skills/`。重名 skill 不覆盖，以前面扫描到的目录为准。仅复制普通文件，跳过软链接。`--skip-scan` 参数跳过此步骤。
- **自动更新 links**：如果迁移了 skills，自动将迁移的 skill 名写入 `config.yaml` 的 `links` 字段（使用 `ensureDefaultLinkTargets()` 计算默认目标，即 `["agents"]` + 已检测到的不支持 `~/.agents/skills/` 的 agent）。
- **交互式安装 syncskill skill**：流程末尾询问是否安装 syncskill skill（默认 Y）。`--skip-skill` 参数跳过此询问，`-y`/`--yes` 参数自动选择 yes。

### 3.5 `install.ts` — Skill 安装

处理 `syncskill install` / `syncskill i` 命令。

**无参数调用**：
```
syncskill install
├─ TTY → 进入交互式选择菜单：
│   ┌─────────────────────────────────────────────────────────┐
│   │ ? What would you like to install?                       │
│   │ > Built-in syncskill skill                              │
│   │   From a URL or local path                              │
│   │   Cancel                                                │
│   └─────────────────────────────────────────────────────────┘
│   ├─ Built-in syncskill skill → 等同 install --self
│   ├─ From a URL or local path → 提示输入 URL 或路径，等同 install <input>
│   └─ Cancel → 退出，不操作
└─ 非 TTY → 显示帮助信息，不执行安装
```

**安装内置 syncskill skill**：
```
syncskill install self
syncskill install --self
├─ 检查 ~/.syncskill/skills/syncskill/ 是否已存在
│   ├─ 已存在 → 提示 "syncskill skill already installed"
│   └─ 不存在 → 继续
├─ 定位 dist/skills/syncskill/ 目录（通过 import.meta.url）
├─ 复制到 ~/.syncskill/skills/syncskill/
├─ 自动执行 link syncskill（使用 ensureDefaultLinkTargets() 计算目标 agent）
└─ 输出 "✓ Installed syncskill skill"
```

**`self` 是保留关键字**：`install self` 和 `install --self` 完全等效，都安装内置 syncskill skill。如果用户本地有名为 `self` 的目录需要安装，请使用 `install ./self`（显式路径）。

**从 URL/路径安装**：
```
syncskill install <url-or-path> [--name <n>] [--path <p>] [-y/--yes]
├─ 执行核心逻辑（交互式添加来源、clone/download/link）
├─ 应用结果到 config
│   持久化 sources + links，支持三种场景：
│   - 新 source
│   - 合并到已有 source（同 URL 时）
│   - 新建附加 source（拒绝合并时）
├─ 创建 symlink 到 agent 目录
├─ 保存 config.yaml
├─ 刷新 skills-registry.json（注册活跃 skills，保留 ignored 条目）
└─ 输出安装结果摘要
```

**`source add` ≡ `install` 别名**：`source add <url-or-path>` 和 `install <url-or-path>` 行为完全等价：都执行上述全部步骤（含 symlink 落盘）。两者复用同一份 `installFromSource()` 实现，CLI 命令名上的区别只是用户视角的两种入口。`source add` 保留是为了语义完整性（"管理 sources 的子命令"），但 `install` 是推荐的主入口。

本地压缩包安装等效于 HTTP 下载后的状态：解压到 `~/.syncskill/sources/<name>/`，`SourceConfig` 记录 `type: "local"` + `archive_path` 指向原始压缩包路径。后续的 skill 发现、link 逻辑与其他 source 类型完全一致。

**输出示例**：
```bash
# 无参数 + TTY → 交互式菜单
$ syncskill install
? What would you like to install? (Use arrow keys)
> Built-in syncskill skill
  From a URL or local path
  Cancel

# 无参数 + 非 TTY (CI、管道) → 显示帮助
$ echo "" | syncskill install
Usage: syncskill install [options] [url-or-path]

Install skills from URL, path, or built-in syncskill skill.

Options:
  --self              Install built-in syncskill skill
  --name <name>       Source name
  ...

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

# 重复安装 → 无新 skill 时也输出结果消息
$ syncskill i https://github.com/user/my-skills
Source "my-skills" is up to date. All skills already linked.

# 已包含的子目录 skill
$ syncskill i https://github.com/user/my-skills/tree/main/examples/skill-a
All skills from "examples/skill-a" are already included in source "my-skills".
```

### 3.6 `linker.ts` — 软链接管理

三级降级策略：
1. `fs.symlink()` — 标准软链接
2. Windows Junction（通过 `fs.symlink(target, link, 'junction')`）
3. `fs.cp(source, target, { recursive: true })` — 拷贝（带警告）

支持：创建链接、状态检查、删除、扫描（walk 目录发现新 skill）。

**Stale Link Reconcile**：

`link --apply` 和矩阵编辑器退出后的 apply 操作需要清理 stale 的 syncskill 管理的软链接。当用户通过矩阵编辑器将某个 skill 从 `["*"]` 改为 `["claude"]` 后，其他 agent 目录中残留的旧链接应被自动清理。

- `link <skill>`：打开单 skill 矩阵编辑器，退出后 reconcile 该 skill 的链接状态
- `link`：打开全局矩阵编辑器，退出后 reconcile 所有变更的 skill
- `link --apply`：按 config 配置 reconcile 所有 skill 在所有 agent 目录中的链接状态

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
$ syncskill link my-skill

my-skill is currently linked to:

  [x] claude
  [ ] cursor
  [x] hermes

↑↓ navigate  Space: toggle  Enter: confirm  Esc: cancel

# 用户取消勾选 hermes，按 Enter
✓ Updated my-skill: linked to claude, unlinked from hermes

# 用户按 Esc 取消（不写 config，不操作 symlink）
$ syncskill link my-skill
... (matrix editor)
Cancelled. No changes made.
```

**单 skill 矩阵的 Enter / Esc 语义**：
- **Enter**：confirm 即 apply。立即写入 `config.links[skill]` 并执行 createLink/removeLink，**不再二次询问**"是否 apply"（与全局矩阵不同：因为单 skill 作用域小且明确）。
- **Esc** 或 `Ctrl+C`：取消。**不写 config，不操作 symlink**。打印 `Cancelled. No changes made.` 后返回。

**输出示例（追加链接）**：

```bash
$ syncskill link my-skill cursor
✓ Linked my-skill to cursor

# 如果 agent 不存在
$ syncskill link my-skill unknown-agent
Error: Agent 'unknown-agent' not configured
```

**输出示例（批量 reconcile）**：

```bash
$ syncskill link --apply

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
$ syncskill link --apply -y

✓ Linked 5 skills
✓ Removed 4 links (skill-a, skill-b, local-tool)
```

**Unlink 命令示例**：

```bash
# 交互确认后删除所有 agent 链接
$ syncskill unlink my-skill
Remove all links for skill "my-skill"? (claude, cursor, hermes) [y/N] y
✓ Unlinked my-skill from all agents
✓ Removed "my-skill" from config links.

# 使用 -y 跳过确认
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
- `source update` 不支持更新有 `archive_path` 的 local source（无远程 URL）
- 区分"本地压缩包解压后的 local source"和"本地目录引用的 local source"

**设计说明**：本地压缩包使用 `type: "local"` 而非 `type: "http"` 是有意为之。虽然解压后的状态与 HTTP 下载相同，但 `type: "local"` 明确表达"无法自动更新"的语义——没有远程 URL 可供 `source update` 拉取新版本。这使 `source list` 和 `source update` 的行为更直观。

**可更新判断**：
| type | url 有值 | archive_path | 可更新 |
|------|---------|-------------|--------|
| `git` | ✓ | — | ✓ |
| `http` | ✓ | — | ✓ |
| `http` | ✗ | — | ✗ |
| `local` | — | — | ✗（目录引用） |
| `local` | — | ✓ | ✗（压缩包解压后） |

**`source add` 命令流程**：

```
source add <url-or-path> [--name <n>] [--path <p>] [--type git|http|local] [-y/--yes]

Step 1: 检测输入类型（见上方 detectSourceInput）

Step 2: 推断默认参数
├─ name: 从 URL/路径/压缩包文件名提取
├─ path: git/http → ~/.syncskill/sources/<name>
│        local(目录) → 原路径本身
│        local(压缩包) → ~/.syncskill/sources/<name>
└─ 显式参数 --name / --path 覆盖推断值

Step 3: 获取内容
├─ git: clone（支持 /tree/<branch> 解析为 --branch）
├─ http: 下载 + 解压到 path
│   ├─ URL 有压缩格式后缀 → 直接按格式解压
│   └─ URL 无后缀 → 检查 Content-Disposition header 获取文件名
│       └─ 仍无法推断 → 使用 --archive-format 或报错
├─ local(目录): 无需获取
└─ local(压缩包): 解压到 ~/.syncskill/sources/<name>/，SourceConfig 记录 archive_path

Step 4: 扫描 skills
├─ 递归遍历整个目录，发现所有 SKILL.md 所在位置
├─ 分类：单 skill 目录 vs 多 skill 容器
└─ 检测重名（同一 source 内部 + 与其他 source/manual 冲突）

Step 5: 用户选择（除非 -y/--yes）
┌─────────────────────────────────────────────────────────────┐
│ Found 5 skills in repo:                                     │
│                                                             │
│ [x] skill-a        (skills/skill-a)                         │
│ [x] skill-b        (skills/skill-b)                         │
│ [ ] skill-c        (.claude/skills/skill-c)                 │
│ [x] demo-skill     (examples/demo-skill)                    │
│                                                             │
│ ⚠️  Duplicate detected:                                      │
│                                                             │
│ "skill-a" exists in 2 locations:                            │
│   (•) skills/skill-a           ← selected                   │
│   ( ) .claude/skills/skill-a                                │
│                                                             │
│ ↑↓ navigate  Space: toggle  Enter: confirm                  │
└─────────────────────────────────────────────────────────────┘

Step 5b: 与外部 source 冲突时
┌─────────────────────────────────────────────────────────────┐
│ ⚠️  Skill "demo-skill" already exists:                       │
│    Current: ~/.syncskill/skills/demo-skill (manual)         │
│    New:     ~/.syncskill/sources/repo/examples/demo-skill   │
│                                                             │
│ Choose action:                                              │
│   ( ) Keep existing, ignore new                             │
│   ( ) Use new, ignore existing                              │
│   ( ) Rename new to "demo-skill-2"                          │
└─────────────────────────────────────────────────────────────┘

Step 6: 写入配置
├─ source entry 写入 config.yaml
├─ 选中的 skills 加入 links（默认使用 ensureDefaultLinkTargets()，即 ["agents"] + 已检测到的不支持共享目录的 agent）
├─ 未选中的 skills 在 skills-registry.json 中标记为 ignored
├─ 重名冲突的 skills 在 skills-registry.json 中标记为 ignored 并记录原因
└─ 更新 skills-registry.json

Step 6.5: 创建 symlink 到 agent 目录（与 install 一致）
└─ 对每个加入 links 的 skill，按其 link target 创建 symlink。这一步与 §3.5 install 的 symlink 步骤共享同一份实现（`applySourceResult`）。

Step 7: -y/--yes 行为
├─ 跳过 Step 5 的交互
├─ 自动选中所有非重名的 skills
└─ 重名的自动加入 ignore（保留现有）
```

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

**`source update` 命令流程**：

Source update **不自动触发**。用户通过 `syncskill update` 或 `syncskill source update` 手动执行。

```
source update [name] [--all] [-y/--yes] [--force]

Step 1: 确定更新范围
├─ 指定 name → 只更新该 source
├─ --all → 更新所有可更新的 source
├─ 无参数 → 列出所有可更新的 source，交互式选择
│
├─ 过滤不可更新的 source：
│   ├─ type: "local"（无论目录还是压缩包）→ 跳过
│   ├─ type: "http" + url 为空 → 跳过（本地压缩包，无原始 URL）
│   └─ type: "git" / type: "http" + url 有值 → 可更新
│
└─ 提示用户即将更新哪些 source（列出名称、类型、URL）

Step 2: 逐个执行更新

  ── Git source ──

  Step 2.1: Dirty 检测（以 repo 为单位）
  ├─ 在 source.path 执行 `git status --porcelain`
  ├─ 如果输出为空 → clean，正常更新
  ├─ 如果有输出 → dirty，**默认行为是 skip（安全优先）**
  │   ├─ 遍历 dirty files，根据路径确定归属的 skill 名
  │   ├─ dirty_skills = [...], 所有在此 repo 中的 skills 都会被影响
  │   └─ 如果所有修改文件都不归属任何 skill（如 repo 根目录 README）
  │       → "non-skill dirty"：不影响 skill 内容，但 reset --hard 仍会丢弃
  │
  ├─ --force → dirty 时先 stash 保存本地修改，再强制更新（记录恢复信息，见下方 update-history.json）
  ├─ -y/--yes（无 --force）→ dirty 时自动 skip（安全优先，等同于交互模式的默认选项）
  │   输出：
  │   "⚠ Skipped: <source> (dirty — <N> skill(s) have local modifications)"
  │   "  Dirty skills: skill-a, skill-c"
  │   "  Use --force to stash local changes and update."
  │
  └─ 交互模式 → 提示用户选择（**默认选项是 Skip**）：

  ── skill dirty 时 ──
  ┌─────────────────────────────────────────────────────────────┐
  │ ⚠ Source "company-skills" has local modifications:          │
  │                                                             │
  │   Dirty skills: skill-a (3 files), skill-c (1 file)        │
  │   All skills in this source: skill-a, skill-b, skill-c     │
  │                                                             │
  │ Git update is repo-level — ALL skills will be affected.     │
  │                                                             │
  │ Choose action:                                              │
  │ > (S) Skip — keep local modifications, skip this source     │
  │   (o) Overwrite — stash local changes and update to latest  │
  │   (q) Quit — stop update                                    │
  └─────────────────────────────────────────────────────────────┘

  ── non-skill dirty 时（修改不影响 skill，但 reset --hard 仍会丢弃）──
  ┌─────────────────────────────────────────────────────────────┐
  │ ⚠ Source "my-repo" has uncommitted changes (not in skills): │
  │   Modified: README.md, notes.txt                            │
  │                                                             │
  │ These files are not skills, but `git reset --hard` will     │
  │ discard them.                                               │
  │                                                             │
  │ Choose action:                                              │
  │ > (S) Skip — keep changes, skip this source                 │
  │   (o) Overwrite — stash changes and update                  │
  │   (q) Quit — stop update                                    │
  └─────────────────────────────────────────────────────────────┘

  注：non-skill dirty 时 `-y/--yes` 也自动 skip（与 skill dirty 行为一致）。

  Step 2.2: 执行更新（clean 或用户/--force 选择 overwrite）
  ├─ 如果 dirty overwrite（用户交互选择或 --force）：
  │   ├─ 记录 before_commit = `git rev-parse HEAD`
  │   ├─ git stash push -m "syncskill: auto-stash before update (<timestamp>)"
  │   ├─ 记录 stash_commit = `git rev-parse stash@{0}`（stash 的 SHA，不随序号漂移）
  │   ├─ git fetch --depth=1 origin <branch>
  │   ├─ git reset --hard origin/<branch>
  │   ├─ 记录 after_commit = `git rev-parse HEAD`
  │   └─ 写入 `~/.syncskill/update-history.json`（见下方 schema）
  ├─ 如果 clean：
  │   ├─ 记录 before_commit = `git rev-parse HEAD`
  │   ├─ git fetch --depth=1 origin <branch>
  │   ├─ git reset --hard origin/<branch>
  │   ├─ 记录 after_commit = `git rev-parse HEAD`
  │   └─ 如果 before_commit ≠ after_commit 且该 source 存在 dirty 记录 → 删除记录
  ├─ 扫描更新后的 skill 列表，对比变化
  └─ 输出更新结果（dirty overwrite 时额外输出）：
     "  ✓ Stashed changes (456789a)"
     "  To restore: syncskill source restore company-skills"

  ── HTTP source ──

  Step 2.1: Dirty 检测（hash 比较）
  ├─ 计算当前各 skill 的实际 hash
  ├─ 与 skills-registry.json 中记录的 last_update_hash 对比
  ├─ 如果有 skill 的 hash 与 last_update_hash 不一致 → dirty
  │
  ├─ --force → dirty 时先备份到 `~/.syncskill/backups/<source>/`，再强制覆盖更新，记录到 update-history.json
  ├─ -y/--yes（无 --force）→ dirty 时自动 skip（同 git source，安全优先）
  │   输出：
  │   "⚠ Skipped: <source> (dirty — <N> skill(s) have local modifications)"
  │   "  Dirty skills: skill-a, skill-c"
  │   "  Use --force to backup and update."
  │
  └─ 交互模式 → 提示格式（默认选项 = Skip）：
  ┌─────────────────────────────────────────────────────────────┐
  │ ⚠ Source "skill-pack" has local modifications:              │
  │                                                             │
  │   Dirty skills: skill-a (3 files), skill-c (1 file)        │
  │                                                             │
  │ Choose action:                                              │
  │ > (S) Skip — keep local modifications, skip this source     │
  │   (o) Overwrite — backup dirty skills and update to latest  │
  │   (q) Quit — stop update                                    │
  └─────────────────────────────────────────────────────────────┘

  Step 2.2: 执行更新（clean source 或用户/--force 选择 overwrite）
  ├─ 如果 dirty overwrite（用户交互选择或 --force）：
  │   ├─ 将 dirty skills 复制到 `~/.syncskill/backups/<source>/<skill>/`
  │   ├─ 更新 `backups/<source>/_meta.json`
  │   ├─ 写入 `update-history.json`（type: "http", backup_path, dirty_skills）
  │   └─ 输出提示：
  │      "⚠ Backing up dirty skills before force-update..."
  │      "  ✓ Backed up skill-a to ~/.syncskill/backups/skill-pack/skill-a/"
  │      "  To restore: syncskill source restore skill-pack"
  │
  ├─ 如果 clean：HTTP sources 在 Git sources 更新完成后，**批量确认一次**（除非 -y）
  │   提示格式：
  │   ```
  │   HTTP sources to update:
  │     cdn-skills     https://cdn.example.com/skills-v2.tar.gz
  │     another-pack   https://example.com/pack.zip
  │
  │   Update 2 HTTP sources? [Y/n]
  │   ```
  │   - `Y` / Enter → 更新所有列出的 HTTP sources
  │   - `n` → 跳过所有 HTTP sources
  │   - `-y` flag → 跳过此确认，直接更新
  │
  ├─ 下载到 tmp 目录（~/.syncskill/.tmp/update-<name>/）
  ├─ 解压到 tmp 目录
  ├─ 验证：解压后 skill 目录结构完整
  │   ├─ 验证成功 → rm 源目录 + mv tmp → 源目录
  │   └─ 验证失败 → 保留原目录，报错，清理 tmp
  ├─ 扫描更新后的 skill 列表，对比变化
  ├─ 更新 skills-registry.json 中的 last_update_hash
  ├─ 如果 clean update 成功且该 source 存在 dirty history 记录 → 删除记录
  └─ 注意：HTTP URL 可能有时效性，先下载到 tmp 确认完整后才替换

Step 3: 处理被删除的 skill
├─ 列出在更新后从 source 中消失的 skill
├─ 对每个被删除的 skill 询问（除非 -y 则默认保留）：
│   "Skill <X> was removed from source <Y>. Keep it as a local skill?"
│   ├─ Yes → 复制 skill 到 ~/.syncskill/skills/<name>，registry 更新为 manual
│   └─ No → 从 links 中移除，清理软链接，registry 标记删除
│
└─ 新增的 skill → 提示用户是否要 link（除非 -y 则自动使用 ensureDefaultLinkTargets() link）

Step 4: 输出更新报告（始终显示，包括 -y 模式）
├─ ✓ 更新成功的 source + 变更 skill 列表
├─ ✗ 更新失败的 source + 原因
├─ ⚠ 被删除的 skill 及用户的处理决定
└─ + 新增的 skill
```

**`--dry-run` 行为**：

`source update --dry-run` 预览更新操作但不执行。dirty 检测仍会执行（只读操作），但不执行 stash、fetch、下载等网络/写操作。只打印 dirty source，clean source 不打印 dirty 信息。

```
$ syncskill update --dry-run

Updatable sources:
  company-skills (git) — https://github.com/company/skills
  skill-pack (http) — https://cdn.example.com/skills-v2.tar.gz

[dry-run] Dirty sources:
  ⚠ company-skills: 2 skill(s) with local modifications — skill-a, skill-c

[dry-run] Would update the above sources.
  Note: company-skills is dirty — without --force, it will be skipped.
```

加 `--force` 时：

```
$ syncskill update --dry-run --force

Updatable sources:
  company-skills (git) — https://github.com/company/skills
  skill-pack (http) — https://cdn.example.com/skills-v2.tar.gz

[dry-run] Dirty sources:
  ⚠ company-skills: 2 skill(s) with local modifications — skill-a, skill-c

[dry-run] Would force-update all sources (git: stash + overwrite, http: backup + overwrite).
```

没有 dirty source 时：

```
$ syncskill update --dry-run

Updatable sources:
  company-skills (git) — https://github.com/company/skills
  skill-pack (http) — https://cdn.example.com/skills-v2.tar.gz

[dry-run] No dirty sources detected.
[dry-run] Would update the above sources.
```

规则：
- **Dirty 检测**：执行 `git status --porcelain`（只读）和 hash 比较（只读），正常报告 dirty 状态
- **Clean source**：不打印 dirty 信息（只在 dirty 列表中列出 dirty 的）
- **网络请求**：不执行 `git fetch`、HTTP 下载等网络操作
- **写操作**：不执行 `git stash`、`git reset`、文件覆盖、registry 更新等
- **提示信息**：dirty source 提示"without --force, it will be skipped"；`--force` 时提示"git: stash + overwrite, http: backup + overwrite"

**`update-history.json` — Dirty overwrite 恢复信息**：

当 dirty source 被 overwrite（`--force` 或交互选择 Overwrite）时，记录恢复信息到 `~/.syncskill/update-history.json`。Git source 和 HTTP source 使用不同的恢复机制：

```json
{
  "company-skills": {
    "type": "git",
    "before_commit": "abc1234def5678...",
    "after_commit": "789abcdef0123...",
    "stash_commit": "456789abcdef0...",
    "timestamp": "2026-05-15T16:00:00Z"
  },
  "skill-pack": {
    "type": "http",
    "backup_path": "~/.syncskill/backups/skill-pack/",
    "dirty_skills": ["skill-a", "skill-c"],
    "timestamp": "2026-05-15T16:00:00Z"
  }
}
```

字段说明：

**Git source（`type: "git"`）**：
- **`before_commit`**：update 前的 HEAD SHA（`git rev-parse HEAD`）
- **`after_commit`**：`git reset --hard` 后的 HEAD SHA
- **`stash_commit`**：`git stash` 产生的 commit SHA（`git rev-parse stash@{0}`，用 SHA 记录避免 `stash@{N}` 序号漂移）
- **`timestamp`**：操作时间

**HTTP source（`type: "http"`）**：
- **`backup_path`**：备份目录路径
- **`dirty_skills`**：被备份的 dirty skill 名称列表
- **`timestamp`**：操作时间

记录规则：
- **Dirty overwrite**：写入该 source 的恢复记录（覆盖上一次记录，只保留最近一次）
- **Clean update 且有新 commit/hash**：**删除**该 source 的记录（用户已在 clean 状态下接受新版本，之前的 dirty 恢复信息不再有意义）
- **Clean update 无变更**：无操作
- **非 dirty source**：不记录

**`source restore <source-name>` — 恢复命令**：

提供交互式恢复，避免用户手动执行复杂的 git 命令。

Git source 恢复：
```
$ syncskill source restore company-skills

Last overwrite: 2026-05-15 16:00:00
  Type: git
  Before: abc1234 → After: 789abcd
  Stash: 456789a

Choose restore action:
> (R) Restore to dirty state — checkout before + apply stash
  (c) Checkout only — go back to before commit (no stash apply)
  (a) Apply stash only — apply stash on current version
  (q) Cancel

> R

✓ Restored company-skills to dirty state
  Checked out abc1234, applied stash 456789a
  Note: You are now in detached HEAD state.
  To return to latest: syncskill source update company-skills
```

HTTP source 恢复：
```
$ syncskill source restore skill-pack

Last overwrite: 2026-05-15 16:00:00
  Type: http
  Backup: ~/.syncskill/backups/skill-pack/
  Dirty skills: skill-a, skill-c

Choose restore action:
> (R) Restore backup — copy files back
  (q) Cancel

> R

✓ Restored 2 skills from backup
  skill-a, skill-c
```

无 history 记录时：
```
$ syncskill source restore unknown-source
No restore history for "unknown-source".
```

行为说明：
- **默认选项**：Git source 为 "Restore to dirty state"（checkout + stash apply），完全恢复到 overwrite 前的状态
- **恢复后不删除 history 记录**：用户可能想再次恢复或查看
- **下次 clean update 成功后**：自动清除该 source 的 history 记录

**`--force` 备份/恢复机制**：

Git source 和 HTTP source 使用不同的机制保存本地修改：

```
Git source（使用 git stash）：
├─ git stash push -m "syncskill: auto-stash before update (<timestamp>)"
├─ 记录 stash_commit SHA 到 update-history.json
└─ 恢复：syncskill source restore <source-name>（或手动 git stash apply）

HTTP source（使用文件备份）：
├─ 将 dirty skills 复制到 ~/.syncskill/backups/<source>/<skill>/
├─ 记录 backup_path 和 dirty_skills 到 update-history.json
└─ 恢复：syncskill source restore <source-name>（或手动 cp 文件）

备份目录结构（仅 HTTP source 使用）：
~/.syncskill/backups/
├── <source-name>/
│   ├── <skill-name>/           # 每个 skill 只保留最新一份备份
│   │   ├── SKILL.md
│   │   └── ...
│   └── _meta.json              # 备份元信息
└── ...

_meta.json 格式：
{
  "skill-a": {
    "backed_up_at": "2026-05-11T12:00:00Z",
    "reason": "force-update",
    "original_hash": "abc123..."
  }
}

输出提示：
├─ Git source:
│   "⚠ Stashing local changes before force-update..."
│   "  ✓ Stashed changes (456789a)"
│   "  To restore: syncskill source restore company-skills"
│
└─ HTTP source:
   "⚠ Backing up dirty skills before force-update..."
   "  ✓ Backed up skill-a to ~/.syncskill/backups/skill-pack/skill-a/"
   "  To restore: syncskill source restore skill-pack"
```

**输出示例**：

```
$ syncskill update

Updatable sources:
  1. my-repo (git) — https://github.com/user/my-repo.git
  2. company-skills (git) — https://github.com/org/company-skills.git
  3. skill-pack (http) — https://cdn.example.com/skills-v2.tar.gz

⚠ Source "company-skills" has local modifications:
  Dirty skills: skill-a (3 files), skill-c (1 file)
  All skills in this source: skill-a, skill-b, skill-c

Git update is repo-level — ALL skills will be affected.

Choose action: (u) Update  (s) Skip  (q) Quit: s

Updating my-repo (git)...
  Fetching origin/main...
  ✓ Updated. 1 skill modified, 1 skill added.

HTTP sources to update:
  skill-pack   https://cdn.example.com/skills-v2.tar.gz

Update 1 HTTP source? [Y/n] y

Updating skill-pack (http)...
  Downloading to tmp...
  Verifying archive contents...
  ✓ Updated. 2 skills modified.

  ⚠ Skill "old-tool" was removed from source "skill-pack".
  Keep it as a local skill? [Y/n] y
  ✓ Moved to ~/.syncskill/skills/old-tool

Update Summary:
  ✓ my-repo: skill-a (modified), skill-d (new)
  ⚠ company-skills: skipped (dirty — skill-a, skill-c have local modifications)
     Skipped skills: skill-a, skill-b, skill-c
  ✓ skill-pack: skill-b (modified), skill-c (modified)
  ⚠ old-tool: removed from skill-pack, kept locally
```

```
$ syncskill update -y

Updating my-repo (git)...
  Fetching origin/main...
  ✓ Updated. 1 skill modified.

⚠ Skipped: company-skills (dirty — 2 skills have local modifications)
  Dirty skills: skill-a, skill-c
  Skipped skills: skill-a, skill-b, skill-c (all skills in this source)
  Use --force to overwrite local changes.

Updating skill-pack (http)...
  ✓ Updated. 2 skills modified.
```

```
$ syncskill update --force

Updating my-repo (git)...
  Fetching origin/main...
  ✓ Updated. 1 skill modified.

Updating company-skills (git)...
  Fetching origin/main...
  ✓ Force-updated. Discarded local modifications in: skill-a, skill-c
  ✓ Updated. 2 skills modified.

Updating skill-pack (http)...
  ✓ Updated. 2 skills modified.
```

**`source remove` 命令行为（交互式确认）**：

两个选项：

```
Removing source "my-repo" (3 skills: skill-a, skill-b, skill-c)

Choose action:
> 1. Keep files (remove from sources, skills become manual)
  2. Remove completely (delete config + files + links)
```

- **Keep files**：从 `config.sources` 移除该 source 条目，但保留文件。skills 变为 manual（可通过 `scan` 发现并重新纳管）。
- **Remove completely**：删除 config 条目、文件目录、所有相关 symlinks。链接清理复用 `reconcileStaleLinks()` 逻辑。

`--force` flag 直接执行 "Remove completely"，跳过确认。

**Skills 注册表（`skills-registry.json`）**：

**数据优先级原则**：`file truth > config > registry`
- **file truth**：文件系统的实际状态（skill 目录是否存在、文件内容 hash）
- **config**：`config.yaml` 中的配置（sources、links、agents）
- **registry**：`skills-registry.json` 作为 config 的派生缓存，而非独立 source of truth

当三者不一致时，以更高优先级为准。例如：registry 记录某 skill 存在但文件已删除，应以 file truth 为准移除 registry 条目。

统一管理所有 skill 的来源映射和忽略状态：

```json
{
  "version": 1,
  "skills": {
    "manual-skill": {
      "path": "~/.syncskill/skills/manual-skill",
      "origin": "manual",
      "type": "manual",
      "status": "active"
    },
    "source-skill": {
      "path": "~/.syncskill/sources/my-repo/.claude/source-skill",
      "origin": "my-repo",
      "type": "git",
      "status": "active"
    },
    "http-skill": {
      "path": "~/.syncskill/sources/skill-pack/skills/http-skill",
      "origin": "skill-pack",
      "type": "http",
      "status": "active",
      "last_update_hash": "a1b2c3d4..."
    },
    "ignored-skill": {
      "path": "~/.syncskill/sources/repo/.claude/skills/ignored-skill",
      "origin": "repo",
      "type": "git",
      "status": "ignored",
      "ignored_reason": "duplicate",
      "ignored_at": "2026-05-09T10:00:00Z",
      "kept_by": "~/.syncskill/sources/repo/skills/ignored-skill"
    }
  }
}
```

**`last_update_hash` 字段**：
- 仅用于 **HTTP source** 的 dirty 检测（git source 使用 `git status --porcelain`）
- 在 `source add`（HTTP 类型解压完成后）和 `source update`（更新完成后）时写入
- update 前计算当前 skill 实际 hash，与此字段对比判断是否 dirty

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

**Sync 流程**（串行策略，防止竞态）：

Sync 采用**两阶段串行策略**：先完成所有目标服务器的 pull，刷新 manifest 后再统一 push。串行避免并行操作导致的竞态问题（例如：从 server-A pull 的内容尚未落盘，同时 push 到 server-B 就会推送旧数据）。

**作用域**：
- `syncskill sync`（无参数）/ `syncskill sync --all`：作用域 = `config.servers` 中所有服务器。
- `syncskill sync <server>`：作用域缩小到单台服务器，仍执行 pull → refresh → push 三阶段，等价于"对该服务器做一次完整双向同步"。**不再有 relay 模式**（旧版"从 <server> pull 后再 push 到其他服务器"已经被移除；如需中转用 `pull <s>` + `push <other>` 显式组合）。

**遍历顺序**：所有阶段按 `Object.keys(config.servers)` 的插入顺序串行处理（YAML 中的 servers 出现顺序）。文档化的固定顺序让多 server sync 行为可预测。

```
Phase 1: PULL（按 config.servers 插入顺序串行）
  for each target in Object.keys(config.servers):
    ├─ 拉取远程 manifest
    ├─ 对比 delta → 确定需要 pull 的 skill
    ├─ 检测跨 server 冲突（详见下方）
    ├─ rsync/scp pull 变更到本地
    ├─ 记录本次 pull 实际改写的 skill → crossServerChangeMap
    └─ 更新本地 manifest

Phase 2: REFRESH
  └─ 刷新目标服务器的 manifest（确保 Phase 1 的变更反映在 hash 中）

Phase 3: PUSH（按 config.servers 插入顺序串行）
  for each target in Object.keys(config.servers):
    ├─ 重新对比 delta（基于刷新后的 manifest）
    ├─ rsync/scp push 本地变更到远程
    └─ 更新 manifest + 执行远程 receiver apply
```

详细步骤：

1. **Pull 阶段**：按 `Object.keys(config.servers)` 顺序串行遍历目标服务器
2. **跨 server 冲突检测**（Phase 1 内）：每次 pull 前，对将要被本次 pull 覆盖的 skill 检查 —— 若该 skill 已在本次 sync 的某个先前 server pull 中被改写（即 `crossServerChangeMap` 中记录过），且新内容（本次 server 远端）与已写入本地的内容不同 → 暂停并提示用户：

   ```
   ⚠ Cross-server conflict detected for skill "<name>":
     - Already pulled from <server-A>: hash <hash-A>
     - Now <server-B> wants to pull: hash <hash-B>
     - Local content matches <server-A>

   Choose action:
   > (A) Keep <server-A> version (skip <server-B> pull for this skill)
     (B) Use <server-B> version (overwrite local with <server-B>'s content)
     (C) Keep current local (do not pull from either)
   ```

   `-y/--yes` 模式自动选 A（先到先得，与配置顺序一致）。
3. **刷新 manifest**
4. **Push 阶段**：按相同顺序串行遍历目标服务器，对有本地变更的 skill 执行 push
5. **单 server 冲突处理**：遇到冲突的 skill 跳过，继续处理其他 skill
6. 汇总输出每个 skill 的最终同步状态，冲突的 skill 单独列出并提示用户执行 `resolve` 命令

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
syncskill refresh          # 等同于 refresh --all（刷新所有，然后显示状态）
syncskill refresh --local  # 只刷新本地 hash
syncskill refresh --remote # SSH 刷新远程 hash
syncskill refresh --all    # 刷新本地 + 远程，然后显示状态
syncskill refresh --status # 仅显示状态，不刷新
```

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

Use `syncskill scan --migrate` to migrate unmanaged skills.
```

```
syncskill scan --migrate

Found 1 unmanaged skill in agent directories:
  ~/.claude/skills/local-experiment

Migrate to ~/.syncskill/skills/? [Y/n]
```

- 扫描 sources → 发现新 skill → 直接注册到 links
- 扫描 ~/.syncskill/skills/ → 发现新 skill → 直接注册到 links
- 扫描 agent 目录 → 发现未纳管的 skill → 仅提示，使用 `--migrate` 才询问迁移

**`scan --dry-run` 行为**：

预览扫描结果但不执行任何写操作（不修改 config.yaml、不迁移文件、不更新 registry）。

```
$ syncskill scan --dry-run

Scanning for new skills...

Found 2 new skill(s) in sources:
  [dry-run] Would add "new-skill-1"
  [dry-run] Would add "new-skill-2"

Found 1 unmanaged skill(s) in agent directories:
  ~/.claude/skills/local-experiment

Use `syncskill scan --migrate` to migrate unmanaged skills.
```

```
$ syncskill scan --migrate --dry-run

Found 1 unmanaged skill(s) in agent directories:
  [dry-run] Would migrate "local-experiment" to skills/ and add to links
```

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
| `docs/config-guide.md` | config.yaml 完整字段参考 |
| `docs/usage-guide.md` | CLI 命令参考、日常 workflow、SSH 配置、故障排查 |
| `README.md` | 项目简介、快速开始、架构图、安装 |

## 10. Config Doctor — 配置诊断与修复

### 10.1 概述

`config-doctor` 模块负责检测 `~/.syncskill/config.yaml` 中的错误和不合理配置，并提供交互式修复能力。

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
| `REGISTRY_MISSING` | warning | `skills-registry.json` 文件不存在 | 从 config + 文件系统重建 |
| `REGISTRY_CORRUPT` | warning | `skills-registry.json` 解析失败或 schema 不合法 | 备份损坏文件后重建 |
| `REGISTRY_STALE` | warning | registry 中记录的 skill 路径不存在（skill 已删除/移动） | 移除失效条目 |
| `REGISTRY_ORPHAN` | warning | config/文件系统中存在 skill 但 registry 中缺少对应条目 | 补充缺失条目 |

**检查顺序**：
1. 检查 `agents` 路径有效性（决定是否 error）
2. 检查 `links` 引用完整性
3. 检查 `sources` 路径有效性
4. 检查 `skills-registry.json` 完整性（见下方）

**注意**：`links[skill]` 的 targets 数组为空是合理情况（临时禁用），不触发诊断。

**skills-registry.json 诊断与重建**：

registry 是 pull 目标路径解析、source update 等功能的关键依赖。doctor 需要确保其与实际状态一致。

```
检查流程：
1. 文件存在性
   ├─ 不存在 → REGISTRY_MISSING，--fix 时重建
   └─ 存在 → 继续

2. 文件可解析性
   ├─ JSON 解析失败或 version/skills 字段缺失 → REGISTRY_CORRUPT
   │   --fix 时备份为 skills-registry.json.bak，然后重建
   └─ 解析成功 → 继续

3. 条目有效性（遍历 registry.skills）
   ├─ entry.path 指向的目录不存在 → REGISTRY_STALE
   │   --fix 时移除该条目
   └─ entry.path 存在 → 正常

4. 完整性（遍历 config.sources + ~/.syncskill/skills/）
   ├─ 发现 skill 目录存在但 registry 中无对应条目 → REGISTRY_ORPHAN
   │   --fix 时根据来源推断 origin/type 并补充条目
   └─ 全部覆盖 → 正常
```

**重建逻辑（`rebuildSkillsRegistry`）**：

从 config.yaml + 文件系统推断所有 skill 的 registry 条目：

```
rebuildSkillsRegistry(config):
  registry = { version: 1, skills: {} }

  1. 扫描 ~/.syncskill/skills/ 下所有含 SKILL.md 的目录
     → origin: "manual", type: "manual", status: "active"

  2. 遍历 config.sources，对每个 source：
     ├─ discoverSourceSkills(source) 获取 skill 列表
     ├─ 对每个 skill：
     │   ├─ 在 source.ignore[] 中 → status: "ignored"
     │   └─ 不在 ignore 中 → status: "active"
     ├─ origin: sourceName, type: source.type
     └─ 如果 type: "http" → 计算当前 skill hash，写入 last_update_hash
        （重建后的状态 = "当前内容就是 baseline"，避免误判为 dirty）

  3. 重名冲突时，保留 config.links 中存在的那个，其余标记 ignored

  返回 registry
```

### 10.4 CLI 命令

```
syncskill doctor [--fix] [--rebuild-registry] [-y/--yes]
```

| 参数 | 说明 |
|------|------|
| （无参数） | 只诊断，输出报告，不修复（等同于 dry-run） |
| `--fix` | 交互式修复（逐项确认） |
| `--fix -y` | 自动修复所有可修复项 |
| `--rebuild-registry` | 仅重建 `skills-registry.json`（跳过其他诊断） |

**`--rebuild-registry` 行为**：
- 从 config.yaml + 文件系统重新扫描所有 skill，生成全新的 `skills-registry.json`
- 如果旧文件存在且可解析，先备份为 `skills-registry.json.bak`
- 输出重建结果摘要（manual / source skill 数量、ignored 数量）

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

**触发范围**：所有需要读取 config 的命令（与 `autoRefreshManifests` 相同，除 `init`、`config`、`doctor` 外）

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
$ syncskill link my-skill

⚠ Config has 2 issues (run `syncskill doctor` to fix)

✓ Linked my-skill to: claude, agents
```
