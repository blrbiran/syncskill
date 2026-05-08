# Syncskill — TypeScript 实现设计

> 日期：2026-04-30
> 状态：草稿
> 作者：biran.bi

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
    └── receiver/
        ├── bootstrap_remote.sh    # 远程部署脚本
        └── sync_receiver.mjs      # 远程零依赖接收脚本

~/.syncskill/                    # init 后创建的本地数据目录
├── config.yaml                    # 用户配置
├── skills/                        # 手动管理的 skill
├── manifests/                     # 各服务器同步状态 (JSON per server)
│   └── <server>.json
├── manifest_history.json          # hash 变更历史
├── skills-index.json              # skill → 来源映射索引（由 link --all / discover 自动生成）
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

### 3.1 `index.ts` — CLI 入口

使用 `commander` 实现，与 Python `cli.py` 对等。命令列表：

| 命令 | 说明 |
|------|------|
| `init [--skip-sources]` | 创建 `~/.syncskill/` 目录结构和 config.yaml |
| `link [--all | <skill> | --status | --unlink <skill>]` | 管理 agent 目录软链接 |
| `source add <name> [--type git|http|local] [--url <url>] [--store <path>] [--skill-subdir <dir>]` | 添加外部来源（支持 GitHub URL 直接解析） |
| `source update [--all | <name>]` | 更新来源 |
| `source list` | 列出来源 |
| `discover [--all-agents]` | 发现 `~/.syncskill/skills/` 和已配置 sources 中新 skill 目录，注册到 config links。当 `~/.syncskill/skills/` 为空时，行为同 `init`：按优先级扫描 `~/.claude/skills/` → `~/.agents/skills/` → `~/.hermes/skills/` 等 agent 目录，将非软链接、不重名的 skills 复制到 `~/.syncskill/skills/`，重名以先扫描到的为准，然后注册到 links |
| `push [<server>]` | 推送到远程；不加参数时默认 --all 推送到所有服务器 |
| `pull [<server>]` | 从远程拉取；不加参数时默认 --all 拉取所有已配置服务器 |
| `sync [<server>]` | 一键全量同步：先 pull 所有远程变更到本地，再 push 本地变更到所有服务器。不加参数时默认 --all 遍历所有已配置服务器 |
| `status` | 显示同步状态 |
| `diff <server>` | 显示待同步变更 |
| `resolve <skill> --take local|remote [--manual]` | 解决冲突：`--take` 一键覆盖，`--manual` 生成 `.sync-conflict` 标记文件供用户逐文件抉择 |
| `refresh [--local | --remote | --all | --status] [server]` | 刷新 manifest。`--local`：重算本地 hash；`--remote`：SSH 重算远程 hash；`--all`：等效于 `--local && --remote`；`--status`：仅打印状态不刷新。默认不带参数时执行 `--all` 后接 `--status`；加 `[server]` 限定目标服务器，省略则遍历所有 |
| `config [section]` | 交互式编辑配置文件（主菜单） |
| `config show` | 打印当前配置 |
| `config set <key> <value>` | 设置单个配置项 |
| `config link` | 直接进入 Link 矩阵编辑器（skills × agents） |
| `config server` | 直接进入服务器管理菜单 |
| `config remote` | 直接进入远程配置矩阵（skills × servers） |
| `source remove <name>` | 移除外部来源（连同本地 store 目录，可选保留） |

全局参数：`--no-refresh` 跳过自动刷新。所有命令（除 `init` 和 `config`）执行前自动调用 `autoRefreshManifests()` 钩子。`config link`、`config server`、`config remote` 三个子命令也跳过自动刷新。当服务器数量 ≥ 3 时，`init` 命令结束后打印提示："检测到多台服务器，自动刷新可能较慢。可使用 `--no-refresh` 参数跳过刷新，手动执行 `syncskill refresh` 按需刷新。"

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
配置管理
├─ agents — 管理 agent 目录
├─ links — 管理 skill 到 agent 的链接映射（矩阵编辑器）
├─ servers — 管理远程同步服务器
├─ sources — 管理外部来源 (git/http/local)
├─ remote — 管理 skills → servers 同步映射（矩阵编辑器）
└─ conflict_resolution — 冲突解决策略
```

每个子菜单使用 `select` / `input` / `checkbox` 实现增删改：
- **agents 管理**：列出已检测/手动配置的 agent，支持 `add` / `remove` / `auto-detect`（重新运行 detectAgents）
- **links 管理**：使用矩阵编辑器（见下方），skills × agents 二维网格，↑↓ 切换 skill，←→ 切换 agent 列，Space/Tab 切换选中状态，Enter 保存，Esc 返回主菜单
- **servers 管理**：列出远程服务器（host/user/port/ssh-key），支持 `add` / `remove` / `edit` / `test-connection`（SSH 连通性测试）。`add` 流程中，输入 server name 后自动解析 `~/.ssh/config`，若找到匹配 Host 则提取 HostName/IP、Port、User、IdentityFile 等字段供用户确认，确认即自动填入；未找到则回退到逐项输入。每个 server 还支持配置远程 agents（远程机器上的 AI agent 目录映射）
- **remote 管理**：使用矩阵编辑器（见下方），skills × servers 二维网格，控制哪些 skill 在哪些远程服务器上生效
- **sources 管理**：与 `source list/add/update` 命令对等，提供交互式引导添加
- **conflict_resolution 管理**：下拉选择 `manual` / `keep-local` / `keep-remote`

**所有子菜单均支持 Esc 返回功能**：
- 统一行为：从子菜单进入的嵌套层级中，Esc 始终返回上一级；在主菜单（第一层）按 Esc 退出 CLI
- 嵌套子菜单（如 Servers → Configure remote agents）：Esc 返回上一级
- `select` 组件通过 `ExitPromptError` 捕获实现 Esc 返回，`safeSelect` 包装函数统一处理

**Esc 保存行为**：
- **矩阵编辑器（`config link` / `config remote`）**：按 `Esc` 退出子菜单时自动调用 `saveConfig()` 写入修改（即使放弃修改也保存当前 config 中尚未持久化的状态）
- **agents / servers / sources / conflict_resolution 子菜单**：通过 `select` 菜单或 `input` 完成的增删改操作即时生效，Esc 退出子菜单时自动调用 `saveConfig()` 写入 config.yaml
- 所有子菜单的保存逻辑一致：从子菜单返回上一级时 `saveConfig()`，主菜单按 Esc 退出 CLI 时也 `saveConfig()`

**矩阵编辑器（Matrix Editor）** — `@inquirer/core` `createPrompt` 自定义组件

使用 `createPrompt` + `useKeypress` 实现二维网格交互。渲染示例：

```
  Skills → Agent Assignment       Page 1/3       ↑↓ navigate  ←→ move  Space: toggle  Tab: next  Enter: save  Esc: back

  Skill              claude     hermes     qoder
  ──────────────────────────────────────────────────────
→ skill-one        [  ✓  ]    [     ]    [  ✓  ]
  skill-two        [     ]    [  ✓  ]    [     ]
```

内部状态：`cursorRow`（当前 skill 行）、`cursorCol`（当前 agent/server 列）、`currentPage`（当前页码）。
- `↑/↓`：上下移动行光标
- `←/→`：左右移动列光标
- `Space/Tab`：切换光标所在单元格的选中/未选中状态（Tab 同时移到下一列）
- `Page Up/Page Down` 或 `n/p` 键翻页
- `a` 键：全选/全不选当前 skill 行的所有 agent/server
- `Enter`：保存修改到 config 并退出
- `Escape`：放弃修改，返回上一级（遵循统一 Esc 行为）

单元格渲染：`[✓]`（选中）/ `[ ]`（未选中），光标所在行高亮为 `[ ✓ ]`，紧凑排列。

**分页**：skills 数量超过 25 时自动分页，每页最多显示 25 行。页码显示在标题行右侧（如 `Page 1/3`）。翻页时 cursorRow 保持在页内相同位置（若超出则移到页末）。

矩阵编辑器同时用于：
- **config link**：skills × agents 映射 → 写入 `config.links`
- **config remote**：skills × servers 映射 → 写入 `config.servers[name].skills.include`

**config link 保存时的通配符优化**：如果某个 skill 选中了所有已配置的 agents，保存时写入 `["*"]` 而不是逐个列出所有 agent 名称。这样配置文件更简洁，也便于后续 agents 增减时自动生效。

**`config link`**：直接调用矩阵编辑器，不经过主菜单。`Esc` 退出时自动保存修改到 config.yaml。

**`config server`**：直接进入服务器管理菜单。所有子菜单项增加 `← Back` 选项，`Esc` 等效于选择 Back。所有修改即时生效，Esc 退出时自动保存。

**`config remote`**：直接调用矩阵编辑器，skills × servers 映射。`Esc` 退出时自动保存修改到 config.yaml。

**`config show`**：打印当前配置（JSON 格式化，`console.log(JSON.stringify(config, null, 2))`）

**`config set <key> <value>`**：非交互式设置单个配置项。`key` 使用点分隔路径（如 `agents.claude`、`conflict_resolution`、`servers.prod.agents.claude`）。`value` 自动解析：`"{}"` / `"[]"` / 数字 / JSON 字符串优先作为 JSON 解析，否则视为字符串。`config set --show-paths` 打印所有合法路径及其当前值。

**新增类型：`ServerConfig.agents`**

每个远程 server 可独立配置 AI agent 目录映射，结构同 `ConfigV1.agents`：
```json
{
  "agents": {
    "claude": "~/.claude/skills",
    "hermes": "~/.hermes/skills"
  }
}
```
用于远程 receiver 在服务器上为不同 agent 创建正确的软链接。

### 3.4 `repo.ts` — 仓库初始化

- 创建 `~/.syncskill/` 目录（含 `skills/`, `manifests/` 子目录）
- 生成 `~/.syncskill/config.yaml`（含自动检测的 agent）
- 复制 `config.example.yaml` 作为参考
- **自动迁移已有 skills（默认行为）**：当 `~/.syncskill/` 目录不存在或 `~/.syncskill/skills/` 为空时，按顺序扫描 `~/.claude/skills/` → `~/.agents/skills/` → `~/.hermes/skills/` → `~/.qwen/skills/` → `~/.qoder/skills/` → `~/.aone_copilot/skills/`，将发现的 skill 复制到 `~/.syncskill/skills/`。重名 skill 不覆盖，以前面扫描到的目录为准。仅复制普通文件，跳过软链接。所有 agent 目录遍历完毕后再停止。`--skip-sources` 参数跳过此步骤。
- **自动更新 links**：如果迁移了 skills，自动将迁移的 skill 名写入 `config.yaml` 的 `links` 字段（设为 `["*"]` 即所有 agent）。如果 config.yaml 已存在，则追加缺失的 link。
- 所有目录/文件仅在不存在时才创建，已存在则跳过，不覆盖。`--skip-config` 跳过 config.yaml 创建。
- 不再依赖当前目录的 `config.yaml`，所有操作基于 `~/.syncskill/`

### 3.5 `linker.ts` — 软链接管理

三级降级策略：
1. `fs.symlink()` — 标准软链接
2. Windows Junction（通过 `fs.symlink(target, link, 'junction')`）
3. `fs.cp(source, target, { recursive: true })` — 拷贝（带警告）

支持：创建链接、状态检查、删除、扫描（walk 目录发现新 skill）。

### 3.6 `manifest.ts` — Hash 计算与 Manifest

**Hash 算法**（与 Python/Hermes 完全兼容）：
```
遍历 skill 目录 sorted 文件
  对每个文件：md5.update(相对路径_utf8 + 文件内容)
  忽略目录和软链接，只 hash 普通文件
  返回 hex digest (32 字符)
```

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

**Manifest 变更历史** (`manifest_history.json`)：

用于追踪 hash 变更事件，仅在 hash 实际变更时追加记录。

```json
{
  "version": 1,
  "entries": [
    {
      "skill": "skill-name",
      "server": "server-name",
      "old_hash": "old123...",
      "new_hash": "new456...",
      "direction": "push",
      "updated_at": "2026-04-30T12:00:00Z"
    }
  ]
}
```

- 追加写入，不删除旧记录
- 刷新/同步时对比旧 hash，仅在实际变更时追加
- `server` 字段：本地刷新为 `local`，远程操作为对应服务器名
- **容错处理**：文件不存在或被删除时视为空历史（`entries: []`），不阻断主流程，自动创建新文件。刷新时首次计算 hash 的 skill 不会记录历史（因为无旧 hash 可对比）

**Delta 比较逻辑**：
- 本地 = recorded, 远程 = recorded → skip
- 本地 ≠ recorded, 远程 = recorded → push
- 本地 = recorded, 远程 ≠ recorded → pull
- 本地 ≠ recorded, 远程 ≠ recorded → conflict
- 新增 skill → new/push

### 3.7 `source.ts` — 外部来源管理

- **Git 来源**：克隆前通过 `git ls-remote --symref <url> HEAD` 自动探测远程默认分支名（可能是 `main`、`master` 或其他），然后执行 `git clone --single-branch --depth 1 --branch <detected>`；`source update` 时用 `git fetch --depth=1 origin <branch> && git reset --hard origin/<branch>`，确保始终只拉当前分支最新单条提交，不增长历史
- **HTTP 来源**：`fetch()` 下载 → `tar` / `node:zlib` + `node:stream` 解压
- **Local 来源**：以 `store` 为基准目录，通过 `store` 和 `skill_subdir` 定位 skills；推送到远程服务器时实际复制文件内容。`--path` 和 `--store` 对 local 类型等效：未指定 `--store` 时默认使用 `--path` 的值。`store` 目录也支持 git 类型的自动检测逻辑（见下方"多 skill 目录自动检测流程"）
- 支持 `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.zip`
- 解压使用 Node 原生模块，不依赖系统工具

**`source add` 命令参数增强：**

- `--store` 可选：`--type` 为 git 或 http 且未指定时，默认为 `~/.syncskill/sources/<github_repo_name>`（从 URL 提取仓库名，如无法提取则回退到 skill 名称）；`--type` 为 local 且未指定时，默认使用 `--path` 的值
- `--path` 可选：local 类型下等效于 `--store`，两者指定其一即可
- `--skill-subdir` 可选：手动指定来源仓库内某个子目录作为 skill 目录
- 支持 GitHub URL 直接解析：`syncskill source add https://github.com/openclaw/openclaw/tree/main/.agents/skills/openclaw-ghsa-maintainer` 等价于 `syncskill source add openclaw-ghsa-maintainer --type git --url https://github.com/openclaw/openclaw.git --store ~/.syncskill/sources/openclaw --skill-subdir .agents/skills/openclaw-ghsa-maintainer`
- 无法解析为标准 GitHub URL 模式时，打印错误提示并列出期望格式（`https://github.com/<org>/<repo>/tree/<branch>/<path>` 或 `https://github.com/<org>/<repo>.git`），回退到 `--type git` 默认行为等待用户输入

**多 skill 目录自动检测流程（`source add` 执行时）：**

按以下优先级自动判断来源目录结构：

1. **多 skill 模式（默认优先）**：来源目录包含 `skills/` 子目录 → 扫描 `skills/` 下所有子目录，每个含 `SKILL.md` 的子目录为一个独立 skill
2. **单 skill 模式（默认降级）**：来源目录**不**包含 `skills/` 子目录且根目录有 `SKILL.md` → 来源目录本身为单个 skill，skill 名取自用户指定的名称
3. **用户指定子目录模式**（用户未指定 `--skill-subdir` 且上述 1、2 均不满足时，交互式提示用户填写）：
   - 指定路径下有 `SKILL.md` → 该子目录为单个 skill
   - 指定路径下没有 `SKILL.md` → 该子目录为多 skill 容器，扫描其下所有含 `SKILL.md` 的子目录

**重名检测与处理：**

- `source add` 执行前，扫描 `~/.syncskill/skills/` 和所有已配置 sources 中的 skill 名称，检查是否有重名
- 发现重名时：提示用户，在对应 source 配置段中写入 `ignore` 字段列出重名 skill 路径，跳过该 skill 的添加
- 未重名时：自动在 `config.yaml` 的 `links` 段中新增该 skill 并设为 `["*"]`（全 agent 选择）

**同仓库合并：**

总原则：同一 git 仓库只保留一份 clone（共享 `url` 和 `store`）。合并时根据新旧 `skill_subdir` 的层级关系，分为 4 种场景：

> 目录类型判断规则：目录下有 `SKILL.md` → 单 skill 目录；目录下没有 `SKILL.md` 但子目录中有 `SKILL.md` → 多 skills 目录。

| 场景 | 现有 `skill_subdir` | 新请求 `skill_subdir` | 关系 | 处理 |
|------|---------------------|----------------------|------|------|
| **1** | `skills/`（多 skills） | `skills/skill1`（单 skill） | 新 ⊂ 现有 | 若 `skill1` 在 ignore list 中 → 从 ignore 移除，检查重名后加入 links（走场景1逻辑可恢复之前被忽略的 skill）；若不在 ignore list 中 → 该 skill 已被覆盖，提示用户 |
| **1.1** | `skills/`（多 skills） | `skills/skill1`（单 skill） | 新 ⊂ 现有 | 同上 |
| **2** | `skills/skill1`（单 skill） | `skills/`（多 skills） | 新 ⊃ 现有 | 修改 `skill_subdir` 为新的多 skills 目录，列出新增 skills 清单；不重名的加入 links，重名的加入 ignore |
| **3** | `skills/skill1`（单 skill） | `skills/skill2`（单 skill） | 同父目录相邻 | 提示用户确认；询问是否引入同父目录下其他 skills（默认不引入）。引入 → `skill_subdir` = 共同父目录，发现所有 skills；不引入 → `skill_subdir` = 共同父目录，其他兄弟 skills 加入 ignore，新 skill 加入 links |
| **4** | `skills/skill1`（单 skill） | `examples/skill2`（单 skill） | 不同父目录 | 创建新 source entry：相同 `type`/`url`/`store`，不同 `skill_subdir`；source name 加数字后缀（`nuwa-skill` → `nuwa-skill.2` → `nuwa-skill.3`）。不修改现有 source |

**命名规则：**

- 多 skills 目录 → source name = git 仓库名（从 URL 提取）
- 单个 skill 目录 → source name = skill 目录名
- 数字后缀递增：已有 `.2` 则用 `.3`，以此类推

**其他：**

- 合并前若 `--type` 为 git，先执行 `git fetch + reset` 将本地 store 仓库更新到最新版本
- 重名检查：新增 skill 加入 links 前检查是否与 `~/.syncskill/skills/` 或其他 sources 重名

**`source remove` 命令行为（交互式确认）：**

移除 source 前，列出该 source 提供的 skill 及其状态，按来源类型询问用户选择：

**Git type source**（有本地 store 仓库，skill 可能已复制到 `~/.syncskill/skills/`）：
1. **转为 local source** — 保留 skill 文件，将 source 类型从 git 改为 local，指向现有 store 目录（skill 继续生效，不再需要 git clone）
2. **删除 links + source 配置** — 移除 source 配置和对应 skill 的 links，保留 skill 文件在磁盘上（skill 变手动管理）
3. **删除 links + source 配置 + local 文件** — 完全清理：移除 source、links、skill 文件

**HTTP / Local source**：
1. **确认删除 links + source 配置** — 移除 source 配置和对应 skill 的 links，保留 skill 文件在磁盘上
2. **删除 links + source 配置 + local 文件** — 完全清理：移除 source、links、skill 文件

**孤立 skill 判断**：`source remove` 执行前，扫描该 source 提供的所有 skill，判断每个 skill 是否还被其他 source 或 `~/.syncskill/skills/` 手动目录提供。仅由当前 source 提供的 skill 标记为"孤立"，展示给用户并在确认选项中说明影响范围。

所有删除操作需要用户二次确认（`@inquirer/prompts` confirm）。

**Skill 发现函数：**

`discoverSourceSkills()` 按上述优先级自动发现所有 skill 名称。`resolveSkillPath()` 通过 sources 参数定位技能所在的具体目录（来源 store + skill_subdir + skill 名称）。

**全局 skill 发现：**

配置好 source 后，`syncskill config link`、`syncskill config remote`、`syncskill discover`、`syncskill status` 等所有涉及 skill 列表的命令都能自动检测到来源中的 skills。统一通过集中的 skill 发现函数 `discoverAllSkills(config)`，合并 `~/.syncskill/skills/` 和所有 sources 的 skill。

**Skills 索引文件（`skills-index.json`）：**

当 `link --all` 或 `discover` 命令执行时，自动生成 `~/.syncskill/skills-index.json` 文件，方便用户确认每个 skill 的出处。

```json
{
  "version": 1,
  "skills": {
    "manual-skill": {
      "path": "~/.syncskill/skills/manual-skill",
      "origin": "manual",
      "type": "manual"
    },
    "source-skill": {
      "path": "~/.syncskill/sources/my-repo/.claude/source-skill",
      "origin": "my-repo",
      "type": "local"
    }
  }
}
```

- `path`：skill 目录的绝对路径
- `origin`：来源标识——`"manual"` 表示 `~/.syncskill/skills/` 手动管理，否则为 source 名称
- `type`：`"manual"` | `"git"` | `"http"` | `"local"`
- 手动目录的 skill 优先级高于来源中的同名 skill

### 3.8 `sync_engine.ts` — 核心同步流程

**Push 流程**：
1. 检查远程 receiver → 不存在则部署 `bootstrap_remote.sh` + `sync_receiver.mjs`
2. 推送 receiver config（remote_agents 映射）
3. 计算本地 hash（Local 来源的 skill 基于软链接指向的实际文件内容）
4. 拉取远程 manifest
5. 对比 → delta
6. 检测冲突
7. rsync 将具体 skill 目录直接推送到远程 `~/.syncskill/skills/<skill_name>/`（推文件内容，不推软链接本身；Local 来源的 skill 此时实际复制文件）
8. 更新本地 manifest + 追加变更历史
9. 推送 manifest
10. SSH exec `sync_receiver.mjs apply`

**Pull 流程**：
1. 拉取远程 manifest
2. 对比本地 hash
3. rsync 拉取
4. 更新本地 manifest

**Sync 流程（`sync` 命令）**：
1. 遍历所有配置的服务器
2. 对每个服务器执行 pull，将远程变更合并到本地
3. 刷新所有 manifest
4. 再次遍历所有服务器，对有本地变更的 skill 执行 push
5. 汇总输出每个 skill 的最终同步状态

用于一键解决"本地改了 skill1、服务器1改了 skill2、服务器2改了 skill3"的多服务器多 skill 同步场景。

### 3.9 `transport.ts` — SSH/rsync 传输

- `fetchRemoteManifest()` — rsync/scp manifest.json
- `pushSkillsRsync()` — rsync -avz --delete
- `pullSkillsRsync()` — rsync -avz 反方向
- `pushManifest()` — 推送 manifest
- `deployReceiver()` — 首次推送时部署 receiver
- `checkRemoteReceiver()` — 检查 receiver 是否存在
- `sshExec()` — 执行 SSH 命令

降级：rsync 不可用时，Node 原生逐文件传输（对比 hash 只传变更文件）。

### 3.10 `conflict.ts` — 冲突检测与解决

三路比较：
- `local_hash` vs `recorded_local` → 本地是否变更
- `remote_hash` vs `recorded_remote` → 远程是否变更

策略：
- `manual`（默认）：跳过，生成 `.sync-conflict` 标记
- `keep-local`：本地覆盖远程
- `keep-remote`：远程覆盖本地

### 3.11 `refresh.ts` — 自动刷新钩子

```
所有命令前 → autoRefreshManifests()
  遍历所有服务器
    refreshLocalManifest() → 重算本地 hash
    refreshRemoteManifest() → SSH 重算远程 hash
  try-catch：刷新失败只打印 WARNING，不阻断主流程
```

### 3.12 `receiver/sync_receiver.mjs` — 远程接收脚本

纯 ESM Node 20+ 脚本，零外部依赖：
- `apply` 命令：遍历 `~/.syncskill/skills/` 下 skill
- 根据 `receiver_config.json` 中的 remote_agents 映射创建软链接
- 更新 `manifest.json`

### 3.13 `receiver/bootstrap_remote.sh` — 远程部署脚本

- 创建 `~/.syncskill/` 目录结构
- 确保 `node` 可用
- 验证权限

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
  "scripts": {
    "build": "tsc",
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
