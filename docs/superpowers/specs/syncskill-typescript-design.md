# syncskill — TypeScript 实现设计

> 日期：2026-04-30
> 状态：草稿
> 作者：biran.bi

## 1. 概述

`syncskill` 核心用途：管理多 AI Agent（Claude/Hermes/Qoder 等）的 Skill 文件，在本地开发机和远程服务器之间双向同步。

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
| `source add <name> --type git|http --url <url> --store <path>` | 添加外部来源 |
| `source update [--all | <name>]` | 更新来源 |
| `source list` | 列出来源 |
| `scan [--all-agents]` | 扫描 skill 并添加到 config links |
| `push [--all | <server>]` | 推送到远程 |
| `pull <server>` | 从远程拉取 |
| `sync [--all | <server>]` | 一键全量同步：先 pull 所有远程变更到本地，再 push 本地变更到所有服务器。等效于 relay |
| `status` | 显示同步状态 |
| `diff <server>` | 显示待同步变更 |
| `resolve <skill> --take local|remote` | 解决冲突 |
| `refresh [--local | --remote | --status] [server]` | 刷新 manifest |
| `config [section]` | 交互式编辑配置文件 |
| `config show` | 打印当前配置 |
| `config set <key> <value>` | 设置单个配置项 |

全局参数：`--no-refresh` 跳过自动刷新。所有命令（除 `init` 和 `config`）执行前自动调用 `autoRefreshManifests()` 钩子。

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

使用 `@inquirer/prompts` 实现 TUI（终端用户界面）交互式编辑配置。

**`config`（无参数）**：交互式菜单主界面
```
配置管理
├─ agents — 管理 agent 目录
├─ links — 管理 skill 到 agent 的链接映射
├─ servers — 管理远程同步服务器
├─ sources — 管理外部来源 (git/http/local)
└─ conflict_resolution — 冲突解决策略
```

每个子菜单使用 `select` / `input` / `checkbox` 实现增删改：
- **agents 管理**：列出已检测/手动配置的 agent，支持 `add` / `remove` / `auto-detect`（重新运行 detectAgents）
- **links 管理**：列出 skill -> agent 映射，支持 `add`（选择 skill + 选择 target agents 支持多选通配符）/ `remove` / `edit`
- **servers 管理**：列出远程服务器（host/user/port/ssh-key），支持 `add` / `remove` / `edit` / `test-connection`（SSH 连通性测试）。`add` 流程中，输入 server name 后自动解析 `~/.ssh/config`，若找到匹配 Host 则提取 HostName/IP、Port、User、IdentityFile 等字段供用户确认，确认即自动填入；未找到则回退到逐项输入（Hostname/IP/Port/User/IdentityFile）
- **sources 管理**：与 `source list/add/update` 命令对等，提供交互式引导添加
- **conflict_resolution 管理**：下拉选择 `manual` / `keep-local` / `keep-remote`

编辑完成后提示确认，然后调用 `saveConfig()` 写入 config.yaml。

**`config show`**：打印当前配置（JSON 格式化，`console.log(JSON.stringify(config, null, 2))`）

**`config set <key> <value>`**：非交互式设置单个配置项。`key` 使用点分隔路径（如 `agents.claude`、`conflict_resolution`）。`value` 自动解析：`"{}"` / `"[]"` / 数字 / JSON 字符串优先作为 JSON 解析，否则视为字符串。

### 3.4 `repo.ts` — 仓库初始化

- 创建 `~/.syncskill/` 目录（含 `skills/`, `manifests/` 子目录）
- 生成 `~/.syncskill/config.yaml`（含自动检测的 agent）
- 复制 `config.example.yaml` 作为参考
- **迁移已有 skills**：按顺序扫描 `~/.claude/skills/` → `~/.agents/skills/`，将发现的 skill 复制到 `~/.syncskill/skills/`。重名 skill 不覆盖，以前面扫描到的为准。跳过已存在的 skill。`--skip-sources` 参数跳过此步骤。
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

- **Git 来源**：`git clone --single-branch --depth 1`（仅克隆默认主分支，不拉历史和其他分支，减小体积）；`source update` 时用 `git fetch --depth=1 origin <branch> && git reset --hard origin/<branch>`，确保始终只拉当前分支最新单条提交，不增长历史
- **HTTP 来源**：`fetch()` 下载 → `tar` / `node:zlib` + `node:stream` 解压
- **Local 来源**：通过软链接直接指向本地指定目录（不复制），适合共享网络盘或未推送到 git 的本地 skill 仓库；推送到远程服务器时才会实际复制文件内容
- 支持 `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.zip`
- 解压使用 Node 原生模块，不依赖系统工具

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

用于一键解决"本地改了 skill1、服务器1改了 skill2、服务器2改了 skill3"的多服务器多 skill 同步场景。等效于原来的 `relay` 命令。

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
