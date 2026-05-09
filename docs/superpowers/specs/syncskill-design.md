# Syncskill — TypeScript 实现设计

> 日期：2026-04-30（更新：2026-05-09）
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
├── skills-ignore.json             # 被忽略的 skill 及原因
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

### 3.1 `index.ts` — CLI 入口

使用 `commander` 实现，与 Python `cli.py` 对等。命令列表：

| 命令 | 说明 |
|------|------|
| `init [--skip-sources]` | 创建 `~/.syncskill/` 目录结构和 config.yaml |
| `link [--edit \| <skill> \| --status \| --unlink <skill>]` | 管理 agent 目录软链接。无参数或 `--edit` 进入矩阵编辑器 |
| `source add <url-or-path> [--name <n>] [--store <p>] [--type git\|http\|local] [-y/--yes]` | 添加外部来源（支持 GitHub URL 直接解析，自动推断参数） |
| `source update [--all \| <name>]` | 更新来源 |
| `source list` | 列出来源 |
| `source remove <name>` | 移除外部来源（交互式选择处理方式） |
| `discover [--all-agents]` | 发现新 skill 目录，注册到 config links。扫描 agent 目录时询问用户确认迁移 |
| `push [<server>] [--all] [--dry-run]` | 推送到远程；无参数时交互式选择服务器（首选项为 All servers） |
| `pull [<server>] [--all] [--dry-run]` | 从远程拉取；无参数时默认 --all 拉取所有已配置服务器 |
| `sync [<server>] [--all] [--dry-run]` | 一键全量同步：先 pull 所有远程变更到本地，再 push 本地变更到所有服务器 |
| `status` | 显示同步状态 |
| `diff <server>` | 显示待同步变更 |
| `resolve <skill> local\|remote [--manual] [--diff]` | 解决冲突：位置参数指定覆盖方向，`--manual` 生成 `.sync-conflict` 标记文件，`--diff` 显示差异 |
| `refresh [--local \| --remote \| --all \| --status] [server]` | 刷新 manifest。默认 `--all` + `--status` |
| `config [section]` | 交互式编辑配置文件（主菜单） |
| `config show` | 打印当前配置 |
| `config set <key> <value>` | 设置单个配置项 |
| `config server` | 直接进入服务器管理菜单 |
| `config remote` | 直接进入远程配置矩阵（skills × servers） |

**全局参数**：
- `--no-refresh`：跳过自动刷新
- `-y` / `--yes`：跳过交互确认（适用于 source add、push --all 等）
- `--dry-run`：预览变更但不执行（适用于 push、pull、sync、link --all、source add）

所有命令（除 `init` 和 `config`）执行前自动调用 `autoRefreshManifests()` 钩子。当服务器数量 ≥ 3 时，`init` 和 `server add` 命令结束后打印提示：

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

**矩阵编辑器（Matrix Editor）** — `@inquirer/core` `createPrompt` 自定义组件

使用 `createPrompt` + `useKeypress` 实现二维网格交互。渲染示例：

```
  Skills → Agent Assignment       Page 1/3

  Skill              claude     hermes     qoder
  ──────────────────────────────────────────────────────
→ skill-one        [  ✓  ]    [     ]    [  ✓  ]
  skill-two        [     ]    [  ✓  ]    [     ]
```

**快捷键**：

| 快捷键 | 功能 |
|--------|------|
| `↑/↓` | 上下移动行光标 |
| `←/→` | 左右移动列光标 |
| `Space` | 切换当前单元格选中/未选中 |
| `Tab` | 切换并移到下一列 |
| `a` | 全选/全不选当前行（skill 的所有 agents） |
| `A` (Shift+A) | 全选/全不选当前列（agent 的所有 skills） |
| `/` | 搜索 skill 名称并跳转 |
| `g` | 跳转到第一行 |
| `G` | 跳转到最后一行 |
| `Page Up/Down` 或 `n/p` | 翻页 |
| `Enter` | 保存修改并退出 |
| `Escape` | 返回上一级 |

**分页**：skills 数量超过 25 时自动分页，每页最多显示 25 行。

**config link 保存时的通配符优化**：如果某个 skill 选中了所有已配置的 agents，保存时写入 `["*"]` 而不是逐个列出所有 agent 名称。

**`link`**（无参数或 `--edit`）：直接调用矩阵编辑器。

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

**Manifest 变更历史** (`manifest_history.json`)：用于追踪 hash 变更事件，仅在 hash 实际变更时追加记录。

**Delta 比较逻辑**：
- 本地 = recorded, 远程 = recorded → skip
- 本地 ≠ recorded, 远程 = recorded → push
- 本地 = recorded, 远程 ≠ recorded → pull
- 本地 ≠ recorded, 远程 ≠ recorded → conflict
- 新增 skill → new/push

### 3.7 `source.ts` — 外部来源管理

- **Git 来源**：克隆前通过 `git ls-remote --symref <url> HEAD` 自动探测远程默认分支名，然后执行 `git clone --single-branch --depth 1 --branch <detected>`
- **HTTP 来源**：`fetch()` 下载 → 解压（支持 `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`）
- **Local 来源**：以 `store` 为基准目录，通过 `store` 和 `skill_subdir` 定位 skills

**`source add` 命令流程**：

```
source add <url-or-path> [--name <n>] [--store <p>] [--type git|http|local] [-y/--yes]

Step 1: 检测输入类型
├─ 文件系统路径（/, ~, ./, ../, 或当前目录存在的路径）→ local
├─ github.com / gitlab.com（含 /tree/<branch> 格式，无需 .git 后缀）→ git
├─ 以 .git 结尾 → git
├─ 以 .tar.gz / .tgz / .tar.xz / .tar.bz2 / .zip 结尾 → http
├─ 其他 URL → 交互式询问 git 或 http
└─ 当前目录不存在的裸名称 → 交互式询问类型和路径

Step 2: 推断默认参数
├─ name: 从 URL/路径提取（仓库名或目录名）
├─ store: git/http → ~/.syncskill/sources/<name>
│         local → 原路径本身
└─ 显式参数 --name / --store 覆盖推断值

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
├─ 未选中的 skills 加入 skills-ignore.json
├─ 重名冲突的 skills 加入 skills-ignore.json 并记录原因
└─ 更新 skills-index.json

Step 7: -y/--yes 行为
├─ 跳过 Step 5 的交互
├─ 自动选中所有非重名的 skills
└─ 重名的自动加入 ignore（保留现有）
```

**同仓库合并逻辑**：

第一次 clone 仓库时，扫描整个仓库发现所有 skills。用户选择后，选中的加入 links，未选中的加入 skills-ignore.json。

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

**Skills 忽略文件（`skills-ignore.json`）**：

```json
{
  "version": 1,
  "ignored": {
    "skill-a": {
      "path": "~/.syncskill/sources/repo/.claude/skills/skill-a",
      "source": "repo",
      "reason": "duplicate",
      "kept": {
        "path": "~/.syncskill/sources/repo/skills/skill-a",
        "source": "repo"
      },
      "ignored_at": "2026-05-09T10:00:00Z"
    }
  }
}
```

**Skills 索引文件（`skills-index.json`）**：

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
      "type": "git"
    }
  }
}
```

**全局 skill 发现**：

统一通过 `discoverAllSkills(config)` 函数，合并 `~/.syncskill/skills/` 和所有 sources 的 skill。

### 3.8 `sync_engine.ts` — 核心同步流程

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
5. 汇总输出每个 skill 的最终同步状态

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

**resolve 命令语法**：
```bash
syncskill resolve <skill> local     # 本地覆盖远程
syncskill resolve <skill> remote    # 远程覆盖本地
syncskill resolve <skill> --manual  # 手动模式，生成 .sync-conflict 文件
syncskill resolve <skill> --diff    # 显示差异
```

### 3.11 `refresh.ts` — 自动刷新钩子

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

### 3.12 `receiver/sync_receiver.mjs` — 远程接收脚本

纯 ESM Node 20+ 脚本，零外部依赖：
- `apply` 命令：遍历 `~/.syncskill/skills/` 下 skill
- 根据 `receiver_config.json` 中的 remote_agents 映射创建软链接
- 更新 `manifest.json`

### 3.13 `receiver/bootstrap_remote.sh` — 远程部署脚本

- 创建 `~/.syncskill/` 目录结构
- 确保 `node` 可用
- 验证权限

### 3.14 `discover` 命令行为

```
Scanning for new skills...

Found 2 new skills in sources:
  ✓ Added "new-skill-1" from source "my-repo"
  ✓ Added "new-skill-2" from source "my-repo"

Found 1 unmanaged skill in agent directories:
  ~/.claude/skills/local-experiment

Migrate to ~/.syncskill/skills/? [Y/n]
```

- 扫描 sources → 发现新 skill → 直接注册到 links
- 扫描 ~/.syncskill/skills/ → 发现新 skill → 直接注册到 links
- 扫描 agent 目录 → 发现未纳管的 skill → **询问用户**是否迁移

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
