# Syncskill — TypeScript 实现设计

> 更新日期：2026-05-10
> 状态：草稿

## 1. 概述

`syncskill` AI Agent Skills 同步工具。核心用途：管理多 AI Agent（Claude/Hermes/Qoder 等）的 Skill 文件，在本地开发机和远程服务器之间双向同步。

**设计约束**：
- 兼容 Node 20+
- 运行时依赖 `yaml` + `commander` + `@inquirer/prompts` 三个 npm 包，其余全部 Node 原生 API
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
    ├── config.ts                  # YAML 加载 + 自动检测 agent 目录
    ├── repo.ts                    # init 命令：目录结构 + 配置模板
    ├── linker.ts                  # 软链接管理（三级降级）
    ├── manifest.ts                # MD5 hash + manifest 读写/比较
    ├── source.ts                  # 外部来源 (git clone/pull, HTTP tar.gz/zip)
    ├── sync_engine.ts             # push/pull/relay 核心流程
    ├── transport.ts               # SSH/rsync 传输 + 降级
    ├── conflict.ts                # 三路冲突检测与解决
    ├── refresh.ts                 # 全局自动刷新钩子
    ├── utils.ts                   # 共享工具函数 (错误处理、路径检查)
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
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

### 3.1 `index.ts` — CLI 入口

使用 `commander` 实现。命令列表：

**初始化与安装**

| 命令 | 说明 |
|------|------|
| `init [--skip-sources] [--skip-skill] [-y/--yes]` | 创建 `~/.syncskill/` 目录结构和 config.yaml，交互式询问是否安装 syncskill skill |
| `install [url-or-path]` / `i` | 安装 skill。无参数安装 syncskill skill；有参数等同于 `source add` + 自动 link |

`install` 完整参数：
- `--name <name>`：指定 source 名称
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--ref <ref>`：Git ref（branch/tag）
- `-y/--yes`：跳过确认

**Link 管理**

| 命令 | 说明 |
|------|------|
| `link` | 进入 skills × agents 矩阵编辑器 |
| `link <skill>` | 链接指定 skill 到配置的 agents |
| `link --all` | 链接所有已配置的 skills |
| `link list` / `link ls` / `link --list` | 显示链接状态矩阵 |
| `link -v/--verbose` | 与 `list` 组合使用，显示文字状态而非符号 |
| `link --dry-run` | 预览链接操作 |
| `unlink <skill> [-y/--yes] [--dry-run]` | 删除 skill 的软链接 |

注：当存在与 `list` 同名的 skill 时，优先匹配 skill，此时需使用 `link --list` 查看状态。

**Source 管理**

| 命令 | 说明 |
|------|------|
| `source add <url-or-path>` | 添加外部来源（支持 GitHub URL 直接解析） |
| `source list` / `source ls` | 列出来源 |
| `source update [name]` | 更新指定来源，无参数或 `--all` 更新全部 |
| `source remove <name> [--force]` | 移除外部来源（交互式选择处理方式） |

`source add` 完整参数：
- `--name <name>`：指定 source 名称（默认从 URL 推断）
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--type git|http|local`：指定来源类型（默认自动检测）
- `--ref <ref>`：Git ref（branch/tag）
- `-y/--yes`：跳过确认，自动选中所有 skills

**Scan 扫描**

| 命令 | 说明 |
|------|------|
| `scan` | 扫描 sources 中新增的 skill + 检测 agent 目录中未纳管的 skill |
| `scan --migrate` | 将 agent 目录中未纳管的 skill 迁移到 ~/.syncskill/skills/ |
| `scan --dry-run` | 预览扫描结果，不执行任何操作 |

**Server 管理**

| 命令 | 说明 |
|------|------|
| `server` | 快捷入口，等同于 `config server`（进入服务器管理菜单） |
| `server list` / `server ls` | 列出已配置的远程服务器 |
| `server show <name>` | 显示指定服务器的配置详情 |
| `server probe <name>` | 诊断服务器状态（SSH 连通性、Node 版本、receiver 部署状态、最后同步时间） |

**Remote 管理**

| 命令 | 说明 |
|------|------|
| `remote` | 快捷入口，等同于 `config remote`（进入 skills × servers 矩阵编辑器） |

**同步操作**

| 命令 | 说明 |
|------|------|
| `push [server] [--all] [-y/--yes] [--dry-run]` | 推送到远程；无参数时交互式选择服务器 |
| `pull [server] [--all] [-y/--yes] [--dry-run]` | 从远程拉取；无参数时交互式选择服务器 |
| `sync [server] [--all] [--dry-run]` | 一键全量同步：先 pull 再 push |
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
| `config link` | 进入 links 矩阵编辑器（已废弃，请用 `link`） |
| `config server` | 进入服务器管理菜单 |
| `config remote` | 进入 remote 矩阵编辑器 |

**全局参数**：
- `--no-refresh`：跳过自动刷新
- `-y` / `--yes`：跳过交互确认
- `--dry-run`：预览变更但不执行

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
- 自动检测本地 agent 目录（存在即添加）：
  - `claude` → `~/.claude/skills`
  - `agents` → `~/.agents/skills`
  - `hermes` → `~/.hermes/skills`
  - `qwen` → `~/.qwen/skills`
  - `qoder` → `~/.qoder/skills`
  - `aone_copilot` → `~/.aone_copilot/skills`
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

**`link`**（无参数）：直接调用矩阵编辑器。

**`link list`** / **`link ls`** / **`link --list`**：显示链接状态。

默认符号版输出：
```
Link Status

Skill                    claude    agents
──────────────────────────────────────────
web-artifacts-builder    ⚠         ·
web-design-guidelines    ⚠         ·
webapp-testing           ✓         ·
xlsx                     ✗         ·

Legend: ✓ linked  ⚠ copied  · missing  ✗ broken
```

`-v` / `--verbose` 文字版输出：
```
Link Status

Skill                    claude      agents
─────────────────────────────────────────────
web-artifacts-builder    copied      missing
web-design-guidelines    copied      missing
webapp-testing           linked      missing
xlsx                     broken      missing
```

**状态符号说明**：
| 状态 | 符号 | 含义 |
|------|------|------|
| `linked` | `✓` | 软链接正常 |
| `copied` | `⚠` | 降级为拷贝（需要关注） |
| `missing` | `·` | 未链接 |
| `broken` | `✗` | 链接损坏 |

**重名 skill 处理**：当存在与子命令同名的 skill（如名为 "list" 的 skill）时，优先匹配 skill。此时需使用 `link --list` flag 形式显示状态。

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
- **自动迁移已有 skills（默认行为）**：当 `~/.syncskill/` 目录不存在或 `~/.syncskill/skills/` 为空时，按顺序扫描 agent 目录，将发现的 skill 复制到 `~/.syncskill/skills/`。重名 skill 不覆盖，以前面扫描到的目录为准。仅复制普通文件，跳过软链接。`--skip-sources` 参数跳过此步骤。
- **自动更新 links**：如果迁移了 skills，自动将迁移的 skill 名写入 `config.yaml` 的 `links` 字段（设为 `["*"]` 即所有 agent）。
- **交互式安装 syncskill skill**：流程末尾询问是否安装 syncskill skill（默认 Y）。`--skip-skill` 参数跳过此询问，`-y`/`--yes` 参数自动选择 yes。

### 3.5 `install.ts` — Skill 安装

处理 `syncskill install` / `syncskill i` 命令。

**安装 syncskill skill（无参数）**：
```
syncskill install
├─ 检查 ~/.syncskill/skills/syncskill/ 是否已存在
│   ├─ 已存在 → 提示 "syncskill skill already installed"
│   └─ 不存在 → 继续
├─ 定位 dist/skills/syncskill/ 目录（通过 import.meta.url）
├─ 复制到 ~/.syncskill/skills/syncskill/
├─ 自动执行 link syncskill（链接到所有 agents）
└─ 输出 "✓ Installed syncskill skill"
```

**从 URL/路径安装（有参数）**：
```
syncskill install <url-or-path> [--name <n>] [--path <p>] [-y/--yes]
├─ 调用 source add <url-or-path> 的内部逻辑
├─ 自动链接发现的所有 skills 到所有 agents
└─ 输出安装结果摘要
```

**输出示例**：
```bash
$ syncskill i
✓ Installed syncskill skill to ~/.syncskill/skills/syncskill/
✓ Linked to: claude, hermes

$ syncskill i https://github.com/user/my-skills
Cloning https://github.com/user/my-skills...
Found 3 skills: skill-a, skill-b, skill-c
✓ Installed 3 skills
✓ Linked to: claude, hermes
```

### 3.6 `linker.ts` — 软链接管理

三级降级策略：
1. `fs.symlink()` — 标准软链接
2. Windows Junction（通过 `fs.symlink(target, link, 'junction')`）
3. `fs.cp(source, target, { recursive: true })` — 拷贝（带警告）

支持：创建链接、状态检查、删除、扫描（walk 目录发现新 skill）。

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

**Manifest 格式**：
```json
{
  "version": 1,
  "server": "server-name",
  "updated_at": "2026-04-30T00:00:00Z",
  "skills": {
    "skill-name": {
      "hash": "abc123...",
      "remote_hash": "abc123...",
      "direction": "push",
      "status": "in-sync"
    }
  }
}
```

**Manifest 变更历史** (`manifest_history.json`)：用于追踪 hash 变更事件，仅在 hash 实际变更时追加记录。

**Delta 比较逻辑**：
- 本地 = recorded, 远程 = recorded → skip
- 本地 ≠ recorded, 远程 = recorded → push
- 本地 = recorded, 远程 ≠ recorded → pull
- 本地 ≠ recorded, 远程 ≠ recorded → conflict
- 新增 skill → new/push

### 3.8 `source.ts` — 外部来源管理

- **Git 来源**：克隆前通过 `git ls-remote --symref <url> HEAD` 自动探测远程默认分支名，然后执行 `git clone --single-branch --depth 1 --branch <detected>`
- **HTTP 来源**：`fetch()` 下载 → 解压（支持 `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`）
- **Local 来源**：以 `path` 为基准目录，通过 `path` 和 `skill_subdir` 定位 skills

**`source add` 命令流程**：

```
source add <url-or-path> [--name <n>] [--path <p>] [--type git|http|local] [-y/--yes]

Step 1: 检测输入类型
├─ 文件系统路径（/, ~, ./, ../, 或当前目录存在的路径）→ local
├─ github.com / gitlab.com（含 /tree/<branch> 格式，无需 .git 后缀）→ git
├─ 以 .git 结尾 → git
├─ 以 .tar.gz / .tgz / .tar.xz / .tar.bz2 / .zip 结尾 → http
├─ 其他 URL → 交互式询问 git 或 http
└─ 当前目录不存在的裸名称 → 交互式询问类型和路径

Step 2: 推断默认参数
├─ name: 从 URL/路径提取（仓库名或目录名）
├─ path: git/http → ~/.syncskill/sources/<name>
│        local → 原路径本身
└─ 显式参数 --name / --path 覆盖推断值

Step 3: 获取内容
├─ git: clone（支持 /tree/<branch> 解析为 --branch）
├─ http: 下载 + 解压
└─ local: 无需获取

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
├─ 选中的 skills 加入 links（默认 ["*"]）
├─ 未选中的 skills 在 skills-registry.json 中标记为 ignored
├─ 重名冲突的 skills 在 skills-registry.json 中标记为 ignored 并记录原因
└─ 更新 skills-registry.json

Step 7: -y/--yes 行为
├─ 跳过 Step 5 的交互
├─ 自动选中所有非重名的 skills
└─ 重名的自动加入 ignore（保留现有）
```

**同仓库合并逻辑**：

第一次 clone 仓库时，扫描整个仓库发现所有 skills。用户选择后，选中的加入 links，未选中的在 skills-registry.json 中标记为 ignored。

后续添加同仓库的其他 skill 时：

```
source add https://github.com/org/repo/tree/main/examples/demo-skill

Step 1: 解析 URL → repo = github.com/org/repo, path = examples/demo-skill

Step 2: 检测到 repo 已存在 source "repo"
        Store: ~/.syncskill/sources/repo (已 clone)

Step 3: 检查 examples/demo-skill
        ├─ 在 ignore 列表中 → 从 ignore 移除，加入 links
        ├─ 已在 links 中 → 提示 "Skill already added"
        └─ 路径不存在 → 先 git pull 更新，再检查

Step 4: 完成
        ✓ Added "demo-skill" from existing source "repo"
```

**`source remove` 命令行为（交互式确认）**：

统一显示所有选项，不适用的标记为 disabled：

```
Removing source "my-skill" (type: git)

Choose action:
  1. Convert to local source (keep files, no more git)
  2. Remove config only (keep files, becomes manual)
  3. Remove completely (config + files)
  [disabled] 4. ... (only for HTTP type)
```

**Skills 注册表（`skills-registry.json`）**：

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

**全局 skill 发现**：

统一通过 `discoverAllSkills(config)` 函数，合并 `~/.syncskill/skills/` 和所有 sources 的 skill。

### 3.9 `sync_engine.ts` — 核心同步流程

**Push 流程**：
1. 检查远程 receiver → 不存在则部署 `bootstrap_remote.sh` + `sync_receiver.mjs`
2. 推送 receiver config（remote_agents 映射）
3. 计算本地 hash
4. 拉取远程 manifest
5. 对比 → delta
6. 检测冲突
7. rsync 将具体 skill 目录推送到远程
8. 更新本地 manifest + 追加变更历史
9. 推送 manifest
10. SSH exec `sync_receiver.mjs apply`

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
3. rsync 拉取
4. 更新本地 manifest

**Sync 流程**：
1. 遍历所有配置的服务器
2. 对每个服务器执行 pull
3. 刷新所有 manifest
4. 再次遍历所有服务器，对有本地变更的 skill 执行 push
5. **冲突处理**：遇到冲突的 skill 跳过，继续处理其他 skill
6. 汇总输出每个 skill 的最终同步状态，冲突的 skill 单独列出并提示用户执行 `resolve` 命令

**--dry-run 输出格式**：

```
[dry-run] push to dev-server:

  skill-one:
    + file1.md (new)
    ~ file2.ts (modified, 42 lines changed)
    - old-file.js (deleted)

  skill-two:
    (no changes)

Summary: 1 skill changed, 2 files added, 1 file modified, 1 file deleted
```

### 3.10 `transport.ts` — SSH/rsync 传输

- `fetchRemoteManifest()` — rsync/scp manifest.json
- `rsyncPush()` — rsync -avz --delete
- `rsyncPull()` — rsync -avz 反方向
- `pushManifest()` — 推送 manifest
- `deployReceiver()` — 首次推送时部署 receiver
- `checkRemoteReceiver()` — 检查 receiver 是否存在
- `sshExec()` — 执行 SSH 命令

降级：rsync 不可用时，Node 原生逐文件传输（对比 hash 只传变更文件）。

**Symlink 传输规则**：
- **rsync 路径**：`rsync -avz` 中 `-a` 包含 `-l`（保持 symlink 原样传输），skill 目录内部的 symlink 会被保持为 symlink
- **scp fallback push**：使用 `readlink` 读取 symlink target，通过 JSON 格式 `{files: {...}, symlinks: {...}}` 传递给 receiver，receiver 使用 `symlink()` 重建
- **scp fallback pull**：receiver 导出 `{files, symlinks}` 格式，本地使用 `symlink()` 重建
- **Skill 目录本身是 symlink**：调用方传入已解析的实际路径，rsync/scp 传输的是实际内容
- **安全验证**：创建 symlink 前必须验证 target 不是绝对路径且不会逃逸出 skill 目录（防止路径穿越攻击）

### 3.11 `conflict.ts` — 冲突检测与解决

三路比较：
- `local_hash` vs `recorded_local` → 本地是否变更
- `remote_hash` vs `recorded_remote` → 远程是否变更

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

**refresh 命令**：
```bash
syncskill refresh          # --all + --status（刷新所有，然后显示状态）
syncskill refresh --local  # 只刷新本地 hash
syncskill refresh --remote # SSH 刷新远程 hash
syncskill refresh --all    # 刷新本地 + 远程（不显示状态）
syncskill refresh --status # 仅显示状态，不刷新
```

### 3.13 `receiver/sync_receiver.mjs` — 远程接收脚本

纯 ESM Node 20+ 脚本，零外部依赖：
- `apply` 命令：遍历 `~/.syncskill/skills/` 下 skill
- 根据 `receiver_config.json` 中的 remote_agents 映射创建软链接
- 更新 `manifest.json`

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

## 4. 同步协议

```
Phase 1: PREPARE & COMPARE
  ├─ 计算本地 Manifest（MD5 hash）
  ├─ 拉取远程 manifest.json
  ├─ 对比哈希 → 得到 delta
  └─ 检测冲突

Phase 2: TRANSPORT (rsync)
  ├─ 检查远程 receiver → 不存在则部署
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
    "test": "vitest",
    "bootstrap": "npm install && npm run build"
  },
  "dependencies": {
    "commander": "^12.x",
    "yaml": "^2.x",
    "@inquirer/prompts": "^7.x"
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
| 压缩/解压 | `node:zlib` + `node:stream` + `extract-zip`（zip 场景） |
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

**新增文件**：`src/config-doctor.ts`

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

**检查顺序**：
1. 检查 `agents` 路径有效性（决定是否 error）
2. 检查 `links` 引用完整性
3. 检查 `sources` 路径有效性

**注意**：`links[skill]` 的 targets 数组为空是合理情况（临时禁用），不触发诊断。

### 10.4 CLI 命令

```
syncskill doctor [--fix] [--dry-run] [-y/--yes]
```

| 参数 | 说明 |
|------|------|
| （无参数） | 只诊断，输出报告，不修复 |
| `--fix` | 交互式修复（逐项确认） |
| `--fix -y` | 自动修复所有可修复项 |
| `--dry-run` | 预览修复操作，不实际执行 |

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
