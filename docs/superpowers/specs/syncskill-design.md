# Syncskill — TypeScript 实现设计

> **当前版本**：v2.9（2026-06-06）
> **版本历史**：[CHANGELOG.md](CHANGELOG.md)
>
> 主要里程碑：v2.9 健壮性强化（L1 config 保护 + L2 saveConfig 退化检测 + L3 宽容加载 + Fix-A 远端 hash 回写 + Fix-B conflict 可见性 + scp SFTP 兼容 + config-sandbox lint + W_CONFLICT_SKIPPED/W_CONFIG_RESET 注册）| v2.8 CLI 表面积优化（`--on-deletion` → `--on-remote-deletion` + `--strict`/`--no-pull-backup` 降级为 env-var-only + 5 个 extended error code 合并 + `--plan`/`--dry-run` 关系明确化）| v2.7.5 spec/code 对账（版本头补齐 v2.7.4 round-4 内容 + §3.2 函数描述简化 + `--cwd` 移除 + `restore` preAction 排除补齐 + 残留 "Tier 1" 术语清理）| v2.7.4 round-4 `--yes-destructive` BREAKING + `remote add/rm/list` + `no-baseline` guard + reconcile-engine 框架 + `server` → `remote` rename + `install` 无参数行为变更 | v2.7.3 round-3 spec/code/docs 收口（§3.7 status 枚举 6→7 文字同步 + `install --type` flag 注册补齐 + docs hygiene） | v2.7.2 round-2 spec/code 收口 + 单一 canonical error code 注册表（Plan P + P5 lint 不变量）+ 死 executor 与死 code 清理（E_CONFLICT / E_SOURCE_DIRTY / W_PULL_BACKUP_SKIPPED）+ 5 个共享 helper 抽取（emitNeedsInput / findActionId / emitError / finalizeSyncCommand / expandLinkAgentNames）+ `--strict` 范围收紧到 4 命令 | v2.7.1 spec/code 收口 + v2.6 兼容包袱清零（sidecar 路径 + cross-server 裸名） + 全 Tier 1 命令 plan_ref 落地 + force-hint 架构不变量 | v2.7 -y 破坏性 verb 规则 + plan_ref 可追溯 + sidecar backup 统一目录 + plan flag `-`=stdin + link audience 自省 + cross-server-policy `server:` 前缀 + unresolved resolve_phase | v2.6 source merge 重设计 + takeover 独立命令 + --on-conflict 统一 + cross-server-policy server-name + --plan-file 移除 + per-server result | v2.5 spec 清理 + UnresolvedKind 重命名 + remote refresh 合并 + link build 降 Tier 2 | v2.4 sidecar backup + restore 命令 + conflict 决议接通 | v2.4.1 receiver Node 18 | v2.3 远端备份模型 + remote 命令族 + takeover 协议 | v2.2 plan-then-execute + --strict | v2.1 install self + --apply 命名规则

**相关文档**：
- [E2E 测试框架设计](e2e-test-design.md) — End-to-End 测试框架规范

## 1. 概述

`syncskill` AI Agent Skills 同步工具。核心用途：管理多 AI Agent（Claude/Hermes/Qoder 等）的 Skill 文件，在本地开发机和远程服务器之间双向同步。

**设计约束**：
- **Controller (CLI)**: Node 20+（`package.json` engines 锁定，受 commander / @inquirer/prompts 等依赖约束）
- **Receiver (远端脚本)**: Node 18+（v2.4.1 起；spec §3.13 详）。Controller 与 receiver Node 版本要求**解耦**——一台 controller 可推送到 Node 18 的远端
- 运行时依赖 `yaml` + `commander` + `@inquirer/prompts` + `compressing` 四个 npm 包（`@inquirer/core` 通过 `@inquirer/prompts` 间接引入），其余全部 Node 原生 API
- ESM 优先，远程 receiver 脚本也用 `.mjs`（Node 18+ 原生运行）
- Hash 算法与 Python 版本完全兼容（MD5 + sorted 文件遍历）
- 跨平台：macOS / Linux / Windows
- CLI 命令名：`syncskill`
- 远程部署目录：`~/.syncskill/`
- **所有用户交互信息使用英文**

> 各版本详细增量变更已归档至 [CHANGELOG.md](CHANGELOG.md)（含 v2 ~ v2.6 的逐条变更与决策上下文）。本 spec 主体始终反映当前最新规范。

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
    ├── index.ts                   # CLI 入口 (commander) — 命令路由 + preAction 钩子 + --help --json 自省
    ├── repo.ts                    # init 命令：目录结构 + 配置模板 + 首次迁移
    ├── install.ts                 # install 实现层：buildInstallPlan / executeInstallPlan / installBuiltinSkill / installFromSource
    ├── linker.ts                  # 软链接管理（三级降级）+ reconcileStaleLinks + expandLinkTargets
    ├── link-build-plan.ts         # link build apply 执行（spec §3.0.B + §3.6 — 单阶段，仅 `--dry-run`）
    ├── source.ts                  # 外部来源顶层入口（re-export source/ 子模块）
    ├── refresh.ts                 # 全局自动刷新钩子 + refreshLocalManifest / refreshRemoteManifest
    ├── commands/                  # CLI 命令注册层（一行 register 函数 + 编排 src/core 与 src/ 实现层）
    │   ├── index.ts               # Barrel — 注册所有命令到 program
    │   ├── config.ts              # config 命令
    │   ├── dashboard.ts           # 无参数调用的仪表盘
    │   ├── diff.ts                # diff 命令
    │   ├── doctor.ts              # doctor 命令
    │   ├── init.ts                # init 命令
    │   ├── install.ts             # install 命令注册（编排 src/install.ts）
    │   ├── link.ts                # link/unlink 命令（含 edit/add/remove/clear/set/build/list 子命令）
    │   ├── link-display.ts        # link list 显示逻辑（符号/文字两种模式）
    │   ├── link-edit.ts           # link edit 交互式矩阵编辑（单 skill / 全局）
    │   ├── refresh.ts             # refresh 命令注册
    │   ├── remote.ts              # remote 命令（v2.7.4 PR 5b: add/rm/list + show/agent/link/takeover 子树；合并自旧 server.ts）
    │   ├── remote-server.ts       # SSH scan-agents 编排层（被 refresh <server> / push auto-synthesize 共用）
    │   ├── resolve.ts             # resolve 命令
    │   ├── scan.ts                # scan 命令
    │   ├── skill.ts               # skill 命令
    │   ├── source.ts              # source 命令 + update 两阶段 plan/execute 实现
    │   ├── status.ts              # status 命令
    │   ├── push.ts                # push 命令注册（编排 src/commands/sync-helpers）
    │   ├── pull.ts                # pull 命令注册（编排 src/commands/sync-helpers）
    │   ├── sync.ts                # sync 命令注册（编排 src/commands/sync-helpers）
    │   ├── sync-helpers.ts        # push/pull/sync 共享 plan-builder + execute-runner
    │   ├── restore.ts             # restore 命令（从 ~/.syncskill/.backups/skills/<skill>/pre-pull 回滚）
    │   └── update.ts              # update 命令注册（编排 src/commands/source.ts）
    ├── config/
    │   ├── types.ts               # TypeScript 类型定义 (SyncSkillConfig, SourceConfig, etc.)
    │   ├── config.ts              # JSON 加载（含 YAML 自动迁移）+ 自动检测 agent 目录
    │   ├── config-ui.ts           # 交互式 TUI 配置菜单 (@inquirer/prompts)
    │   ├── config-doctor.ts       # 配置健康诊断与修复 (agents/links/sources/registry)
    │   └── matrix-editor.ts       # 二维矩阵编辑器组件 (@inquirer/core createPrompt)
    ├── core/                      # 业务逻辑层（不依赖 src/commands/；可被 src/commands/ + src/ 实现层共用）
    │   ├── manifest.ts            # MD5 hash + manifest 读写/比较 + classifySkillDelta + compareManifests + W_MANIFEST_CORRUPT
    │   ├── pull-backup.ts         # pull sidecar backup 读写 + restore 辅助
    │   ├── backup-paths.ts        # 统一 sidecar 备份路径常量（pre-pull / pre-restore / pre-update）
    │   ├── sync_engine.ts         # push/pull/sync 编排入口 + 跨 server 冲突检测 + 远程 receiver 调用
    │   ├── sync-push.ts           # push 流程实现：plan builder + auto-synthesize backup + pushToServer executor（v2.5 从 sync_engine.ts 拆出）
    │   ├── sync-pull.ts           # pull 流程实现：plan builder + sidecar backup + pullFromServer executor（v2.5 从 sync_engine.ts 拆出）
    │   ├── sync-utils.ts          # 同步层工具函数（getIncludedSkills, computeLocalHashes, buildDirectionMap）
    │   ├── transport.ts           # SSH/rsync 传输 + 降级
    │   ├── conflict.ts            # 三路冲突检测与解决
    │   ├── server.ts              # 服务器配置格式化输出
    │   ├── skills-registry.ts     # 统一 skills 注册表 (skills-registry.json)
    │   ├── registry-builder.ts    # v2 registry 重建（仅 ignored + http_baselines；REGISTRY_CORRUPT 自动恢复）
    │   ├── receiver-backup.ts     # 远端 receiver_config.json 本地备份 schema v1 读写（§3.3）
    │   ├── remote-scanner.ts      # SSH scan-agents primitive（receiver `scan-agents` 子命令调用）
    │   ├── reconcile-engine.ts    # push/sync reconcile 框架：远端 skill set 清理 + no-baseline guard（v2.7.4 round-4）
    │   ├── takeover.ts            # remote-takeover preflight + resolutions 决议
    │   ├── plan.ts                # Plan-then-execute 框架类型 + 协议 helper（§3.0.B）
    │   ├── plan-execute-runner.ts  # Plan-then-execute runner（PLAN_COMMANDS 统一脚手架）
    │   ├── context.ts             # CommandContext：per-invocation 上下文 + emitter + 解析后的 flags
    │   ├── events.ts              # JSONL 事件协议（§11.2）
    │   ├── json-output.ts         # --json 渲染共享 helper
    │   ├── error-codes.ts         # 错误码 / 警告码注册表（§11.4）+ 退出码映射（§11.3）
    │   ├── log-level.ts           # SYNCSKILL_LOG_LEVEL 解析 + 文本日志过滤
    │   └── prompt-utils.ts        # guardPrompt + @inquirer/prompts 动态 import 封装
    ├── source/                    # 外部来源子模块（从 source.ts 拆分）
    │   ├── index.ts               # Barrel — re-export 所有公共 API
    │   ├── core.ts                # 核心来源操作（installFromSource, runSourceUpdate）
    │   ├── detect.ts              # 输入类型检测（detectSourceInput）+ GitHub URL → skill_subdir 推断
    │   ├── dirty.ts               # Dirty 检测逻辑（git status / http baseline）
    │   ├── discover.ts            # Skill 发现（discoverSourceSkills）
    │   ├── install-flow.ts        # 安装流程（含同 URL 合并 Case 1-3）
    │   ├── remove-flow.ts         # source remove 两阶段 plan/execute（buildRemovePlan/executeRemovePlan）
    │   └── update-flow.ts         # source update 两阶段 plan/execute + skill-removed 决议
    ├── utils/
    │   ├── utils.ts               # 共享工具函数 (isNotFoundError, pathExists, expandTilde)
    │   ├── archive.ts             # 归档检测 + 跨平台解压 (compressing → CLI fallback)
    │   └── backup.ts              # HTTP source --force 更新时的备份 (~/.syncskill/.backups/sources/<source>/pre-update)
    └── receiver/
        ├── bootstrap_remote.sh    # 远程部署脚本
        └── sync_receiver.mjs      # 远程零依赖接收脚本（含 scan-agents / apply / Node 18 guard）

~/.syncskill/                    # init 后创建的本地数据目录
├── config.json                    # 用户配置（JSON 格式，见 §11.11）
├── skills/                        # 手动管理的 skill
├── manifests/                     # 各服务器同步状态 (JSON per server)
│   └── <server>.json
├── receivers/                     # 远端 receiver_config.json 的本地备份（per server）
│   └── <server>.json
├── manifest_history.json          # hash 变更历史
├── skills-registry.json           # skill 注册表（来源映射 + 忽略状态，统一管理）
├── sources/                       # 外部来源 clone/下载目录（git clone、HTTP 解压）
├── .backups/                      # 统一 sidecar 备份目录
│   ├── skills/<skill>/pre-pull/   #   pull/sync 写盘前的本地快照（§3.9 B1）
│   ├── skills/<skill>/pre-restore/#   restore 执行前的安全兜底（§3.17）
│   └── sources/<source>/pre-update/ # update --force 的 HTTP source 旧内容（§3.8）
└── .tmp/                          # 临时文件（运行时创建，自动清理）
```

`syncskill init` 会在用户 home 目录下创建 `~/.syncskill/` 目录，所有运行时数据（配置、skill、manifest、历史记录）均存放于此。源码仓库不包含用户数据。

## 3. 模块职责

**通用设计原则**：

- **CLI 输出只显示变化**：命令执行后只输出实际发生变化的条目（新增、删除、错误等），不输出未变化的条目（如 already-linked）。如果完全没有变化，输出一条简短的汇总消息（如 `All links are up to date.`）。`--dry-run` 模式同样遵循此原则，显示"将要变化"的条目。
- **复合命令复用核心逻辑**：当一个命令在功能上组合了多个其他命令的能力（如 `install` 兼有 source 注册 + auto-link 的语义），禁止重新实现持久化逻辑，必须复用核心命令的写入路径。这确保核心逻辑发生变更时，所有入口点自动获得修复。
- **Skill/Source 变更的不变量**：所有会改变 skill 或 source 状态的入口点（`install`、`update`、`scan`）都必须保证以下三个副作用完整执行：
  1. config.sources 持久化（新增/修改 source 条目）
  2. config.links 持久化（新增 skill 映射）
  3. skills-registry.json 刷新（保证 registry 与实际状态一致）

### 3.0 Flag 语义统一定义

所有命令共享同一套全局 flag 语义。本节是后续所有命令章节的语义基准；具体命令章节引用本节而非重复定义。

#### 3.0.1 `--dry-run`

| 项 | 定义 |
|---|---|
| 含义 | 不修改任何外部状态：不写 fs、不发起任何**写** SSH/rsync 请求、不修改远端 |
| 允许例外 | 只读探查 — 包括只读网络请求（`git ls-remote`、`ssh <host> "cat manifest"`、HTTP HEAD 探针）和本地只读操作（`git status --porcelain`、`stat`、`ls`、本地 hash 计算）—— 用于产出 plan |
| 输出（text 模式） | 显示"将要发生的变更"，每行前缀 `[dry-run]` |
| 输出（json 模式） | 完整 plan JSON，等价 `--plan` |
| 与 `--plan` 关系 | **等价**：`--dry-run` ≡ `--plan` + text 渲染；`--json --dry-run` ≡ `--json --plan`。人类用 `--dry-run`（直觉名）；AI agent 用 `--json --plan`（精确语义）。两者共享同一份 plan-builder 函数，输出内容完全一致 |

#### 3.0.2 `-y` / `--yes` 和 `--yes-destructive`

| 项 | 定义 |
|---|---|
| 含义 | 所有 prompt 选**文档化的 safe default**——统一规则，无 verb 例外 |
| 强制约定 | spec 中每个 prompt 必须显式标注 "default under -y"；该默认值同时出现在 plan 的 `unresolved[].default_under_y` 字段 |
| 不暗示 | 不暗示 `--force`；不暗示 `--cross-server-policy=first-wins`；不暗示 `--on-conflict=keep-local`；**不暗示执行破坏性 verb（v2.7.4 BREAKING）** |
| 适用范围 | 仅影响 prompt 选择，不改变命令的破坏性行为 |

**破坏性 verb 规则（v2.7.4 round-4 议题 2.1，BREAKING）**：

`-y` 永远 = safe default。破坏性 verb（`unlink` / `link clear` / `remote takeover` / push 在无 baseline manifest 下的 `force-push` 路径 / 任何 `rsync --delete` 路径）在**非交互模式**（`-y` / `--no-interactive` / `--json`）下**必须显式 `--yes-destructive`** 才能执行；否则以 `E_USAGE` (exit 2) abort 并提示加 flag。

| 命令类别 | 交互模式（无 flag） | 仅 `-y` / `--no-interactive` | 加 `--yes-destructive` |
|---|---|---|---|
| **破坏性 verb**（`unlink` / `link clear` / `remote takeover` / no-baseline push） | 保守 prompt 默认 `N` | **abort `E_USAGE` exit 2** + hint | 执行该 verb |
| **非破坏命令**（`update` / `pull` / `sync` / `install` 等） | 保守 prompt | 保守 default（`skip` / `keep-*`，与 §3.0.5 一致） | （无作用） |

迁移：旧 `syncskill -y unlink X` → 新 `syncskill --yes-destructive unlink X`。无 deprecation 窗口（v2.7.4 无生产用户）。

判定标准：**verb 本身是否就是破坏动作**。破坏性 verb 的非交互执行必须双因子触发（用户敲该 verb + 加 `--yes-destructive`），消除"同一 flag 在不同 verb 下意思反转"的 footgun。非破坏命令内部遇到的破坏性子决策（如 `--on-local-deletion=delete`、cross-server 选边）仍走各自的 `--on-*` 政策 flag 或 `--resolutions`，`-y` 取保守 default。每个 prompt 站点仍按"强制约定"标注其 `default-under-y`，据本规则取值。

实现：`ensureYesDestructive(ctx, verb)` in `src/core/context.ts` —— 两个 callsite 直接调用 helper（`unlinkSkill` in `src/commands/link.ts`、`remote takeover` action handler in `src/commands/remote.ts`）；第三个 callsite `applySyncResolutions` 的 `no-baseline` 分支（`src/commands/sync-helpers.ts`）使用等价的内联条件 `(yes || noInteractive || json) && !yesDestructive → abort`（因该分支需要在 abort/force-push 之外保留 `refresh-first` / `promptSelect` 路径，不适合直接复用 helper 的 `process.exit(2)` 行为）。三处共享同一 3-mode 非交互触发规则；C14.5 (commit follow-up to cc6a5e0) 修复 PR 5a 仅在 `-y` 读 `--yes-destructive` 的内联不一致。

#### 3.0.3 `--force`

| 项 | 定义 |
|---|---|
| 含义 | **单一含义** = "绕过 dirty 保护"（覆盖 dirty source、强制 `git reset --hard` 等） |
| 不暗示 | 不暗示 `-y`（force 仍可能弹其他确认）；不暗示文件删除 |
| 不用于 | 删除文件用专门 verb 或显式 `--delete-files`；跳过确认用 `-y` |
| 误用纠偏 | force/yes 正交是有意设计（agent 需独立控制"绕 dirty"与"跳确认"）。但为纠正人类肌肉记忆：当 `--force` 在**非 dirty 场景**传入、命令仍弹出其它 prompt 时，输出一次性 `info` hint —— `\`--force\` only bypasses dirty protection; use \`-y\` to auto-confirm prompts`。仅提示，不改变行为 |

**触发模型（架构不变量）**：

`maybeEmitForceHint(ctx)` 在 `--force=true` 时，**任何** prompt 一旦真正调用 `promptConfirm` / `promptSelect`，hint 必然 emit 一次（每 `CommandContext` 一次去重）。**不区分 prompt 类型** —— 区分依靠 callsite 自身的守卫：

- **dirty-相关 prompt** callsite 必须被 `if (!ctx.flags.force)` 块短路，使 `--force=true` 时 prompt 根本不被调用。参考实现：`src/commands/source.ts` 的 dirty 分支：

  ```typescript
  if (!force) {              // ← --force 时根本不走这条路径
    action = await promptSelect(ctx, "P_UPDATE_DIRTY_ACTION", ...);
  }
  if (force) {               // ← --force 走这条：自动 stash/backup，无 prompt
    // ...
  }
  ```

- **非 dirty prompt** callsite 不读 `ctx.flags.force`（force 与 prompt 正交）

**为什么这个设计自治**：违反不变量（dirty prompt 没被 `if (!force)` 守卫）→ `--force` 下 hint 错误触发 → 测试 / 用户立刻在 callsite 暴露 bug,而非藏在 `maybeEmitForceHint` 内的字符串匹配规则里。曾经的 `promptCode.includes("DIRTY")` heuristic 已移除——所有 dirty callsite 已正确守卫,heuristic 永远不命中,纯属脆弱的防御性代码。

**架构不变量 lint（v2.7.4 round-4 议题 2.2）**：上述 "dirty-related callsite 必须被 `if (!force)` 守卫" 不变量由 `tests/force-callsite-lint.test.ts` 静态强制——扫 `src/` 下所有 `promptConfirm` / `promptSelect` 调用，对 promptCode 含 `DIRTY` 的调用点用 brace-counting 算法验证存在 `!force` / `!ctx.flags.force` 的外层守卫块。新增 dirty 相关 prompt 时漏守卫会立即被 CI 抓出（同 round-2 Plan P 用 lint 替代脆弱约定的哲学）。

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
| ✗ | skip + `W_SOURCE_DIRTY`；exit 码按 §11.3 多 target skip 规则 |
| ✓ | 执行更新（git reset --hard / http overwrite） |

| `SYNCSKILL_STRICT=1` | 触发条件（partial skip 时） |
|---|---|
| 未设置 | 默认；多 target 命令至少 1 个成功就 exit 0，skip 列表反映在 `data.skipped[]` |
| `=1` | 任何 skip 都升级为 exit 6（CI / 严格 AI agent 场景显式 opt-in） |

适用范围：`SYNCSKILL_STRICT=1` 影响**`update` / `push` / `pull` / `sync` 这 4 个多 target 命令**。`install` 的 partial skip 多源于用户决策（skill-selection 阶段 deselect），不在范围内 —— install 真正的失败应走 `E_INSTALL` exit 1 而不是 partial-skip exit 6。（v2.8：`--strict` CLI flag 已移除，仅保留环境变量 `SYNCSKILL_STRICT=1`。）

| `--dry-run` 组合 | 行为 |
|---|---|
| `--dry-run -y` | plan 显示"将要做"（含 `-y` 下的默认决策） |
| `--dry-run --force` | plan 显示"force 下将要做"（dirty source 也算入） |
| `--dry-run --no-interactive` | plan 照常输出，遇 unresolved 也列出（plan 阶段允许 unresolved 存在，不 exit 4） |
| `--dry-run` + `SYNCSKILL_STRICT=1` | plan 标注哪些项"将会触发 exit 6"，便于 CI 预判 |

### 3.0.B Plan-then-Execute 全局协议

所有 mutate 状态的命令遵循同一份 plan/execute 契约。本节定义协议；具体命令章节引用本节而非重复定义。

#### 3.0.B.1 通用 flag

| Flag | 行为 |
|------|------|
| `--plan` | 只跑 plan 阶段，输出结构化 plan 后 exit 0 |
| `--apply <path\|->` | 跳过 plan，直接执行预生成的 plan。`<path>` = 文件；`-` = 从 stdin 读（Unix 惯例，流式版本） |
| `--resolutions <path\|->` | 提供决议绕过所有 prompt。`<path>` = 文件；`-` = 从 stdin 读，避免临时文件 |

`-` 作为参数值表示 stdin,是各 agent / shell 通用的约定;用 `--apply -` / `--resolutions -` 即可流式传入,无需临时文件。

`--dry-run`（§3.0.1）等价 `--plan` + text 渲染；两者共享同一份 plan-builder 函数。

**Deprecation**：旧 flag `--apply-stdin` / `--resolutions-stdin` 降级为对应 `--apply -` / `--resolutions -` 的 alias，保留一个大版本并在 `result.summary.deprecations` 列出，下个大版本移除。

#### 3.0.B.2 通用 plan schema

```json
{
  "version": 1,
  "command": "install",
  "generated_at": "2026-05-21T12:00:00Z",
  "actions": [
    { "id": "a1", "op": "clone", "url": "...", "to": "..." },
    { "id": "a2", "op": "register-source", "name": "my-repo", "type": "git" },
    { "id": "a3", "op": "link-skill", "skill": "skill-a", "agents": ["claude", "cursor"] },
    { "id": "a4", "op": "create-symlink", "from": "...", "to": "..." }
  ],
  "unresolved": [
    {
      "kind": "skill-selection",
      "resolve_phase": "execute",
      "candidates": [{"name": "skill-a", "path": "..."}],
      "default_under_y": ["skill-a", "skill-b"]
    }
  ],
  "warnings": []
}
```

`actions[].op` 与 `unresolved[].kind` 字段名稳定（视作 API 表面）。`actions[].skill` 字段在多数 op 下必填，但跨 skill 的 op（如 `clone` / `register-source` / `download`）允许省略 — AI agent 解析时应判定该字段为 `string | undefined`。

**`actions[].id`（可追溯）**：每个 action 带一个**在单个 plan 内稳定唯一**的 id（如 `a1`/`a2`…，生成规则 = 顺序计数器,buildPlan 内确定性）。result 的每个变更项通过 `plan_ref` 回指该 id（§11.6.0），使 plan↔result 对账退化为机械 join，无需语义猜测。id 仅在单个 plan 作用域内有意义，不跨调用持久化。

**action id 格式**：约定为 `a<N>`（正则 `/^a\d+$/`），由 `tests/spec-json-examples.test.ts` 锁定所有 §11.6.x JSON 示例的 `plan_ref` 字段必须匹配此格式（v2.7.4 round-4 议题 3.1，PR 1 Task 1.4）。让 plan_ref regex 的来源在 spec 内显式可查，避免读者反查测试源码。

**`unresolved[].resolve_phase`**：取值 `"plan"`（默认）或 `"execute"`,显式标注该决议项**能在哪个阶段解决**:

| `resolve_phase` | 含义 | agent 影响 |
|---|---|---|
| `"plan"`（默认） | plan 阶段即可枚举完整 candidates，可在 plan 输出后用 `--resolutions` 解决 | 该 plan 可被无脑 `--apply`（配 `--resolutions`） |
| `"execute"` | candidates 只有 execute 阶段（如 clone 完成后）才能枚举，plan 阶段无法穷举 | 含此项的 plan **不能盲 apply**;`--apply` 时必须配 `--resolutions`,否则 `E_UNRESOLVED` + exit 7 |

目前唯一的 `"execute"` 项是 `install` 的 `skill-selection`（git source 的真实 skill 列表只有 clone 后才能枚举，见 §3.0.B.4 约束 2）。agent 据此字段机读判断"这个 plan 能否直接重放"，无需把"install 是特例"硬编码进 prompt。

**`unresolved[].kind` 规范化枚举**（命令章节引用本表，禁止自创新 kind 名）：

| Kind | 出现命令 | 触发场景 | `default_under_y` 含义 |
|------|---------|---------|----------------------|
| `skill-selection` | `install` / `update` | 新 source 中检测到多个 skill，需用户选 install 子集 | 默认全选 |
| `dirty-source` | `update` | source 目录有未提交改动 | `skip`（保留 dirty，跳过该 source） |
| `skill-removed` | `update` | source 中某 skill 被上游删除 | `keep`（保留为本地 manual skill） |
| `link-cleanup` | `link build` | 检测到 config 不再引用的 stale symlink | `approve`（删除 stale link） |
| `cross-server-conflict` | `sync` / `pull` | 同一 skill 在多个 server 上 hash 不同 | `abort`（停止 plan，exit 7） |
| `content-conflict` | `push` / `pull` / `sync` | 单 server 上 local/remote/recorded 三方冲突。所有命令统一 `options[]`：`["keep-local", "keep-remote", "skip"]`。push 下 `keep-local` = force push（本地覆盖远端）；`keep-remote` = skip（保留远端现状）。**v2.4 C2/C3**：pull 侧决议起作用——`applySyncResolutions` 把决议写入 `SyncDecisionSink.conflicts`，`pullFromServer.conflictResolutions` 真正消费（v2.4 B1 sidecar backup 兜底数据丢失风险） | `skip`（不动；与 §3.0.5 一致——`-y` 不暗示破坏性操作） |
| `remote-deletion` | `sync` / `pull` | 远端 manifest 中已删除某 skill，但本地仍存在。Policy flag: `--on-remote-deletion`（旧名 `--on-deletion` 保留为 alias） | `keep-local`（保留本地） |
| `local-deletion` | `push` / `sync` | 本地已删除某 skill（baseline 中存在、当前文件不在），远端未改 → 用户可能本地 `rm` 想推送删除，syncskill 默认不主动跨设备删 | `keep-remote`（保留远端，本地下次 pull 会拉回；需用户显式 opt-in） |

**`options[]` 与 `abort` 的关系**：`options[]` 列举的是**per-skill 决议项**（决定该 skill 如何处理）；`abort` 不在任何 `options[]` 中，因为它是**元决策**（停止整个 plan 的执行，不属于"对这个 skill 做什么"的选项）。`abort` 仅出现在 `default_under_y` 字段、`--cross-server-policy=abort`、`--on-conflict=abort` 等 orchestration-level 配置中。这一规则适用于所有 kind。

#### 3.0.B.3 应用范围（v2.7.4 round-4 重述）

命令按 plan-execute 复杂度分为两类，**机读判定式 = `plan_schema !== null`**（CLI 自省 `syncskill <cmd> --help --json` 直接暴露；§11.10）。代码侧单一真源 = `src/index.ts` 的 `PLAN_COMMANDS` Set。

**两阶段命令 — 完整 plan/execute**（`plan_schema !== null`；昂贵或多决议项，提供 `--plan` / `--apply <path|->` / `--resolutions <path|->`;旧 `--apply-stdin` / `--resolutions-stdin` 降为 alias 一版,见 §3.0.B.1）：

| 命令 | plan 应列出 |
|------|------------|
| `install <url>` / `install self` | clone/download + 待 link 的 skill 列表 + skill-selection 决议项 |
| `update [name]` | 哪些 source 会更新、dirty 状态、删除/新增的 skill |
| `source remove <name>` | 待删 config 条目 + 待删文件路径 + 待清理 symlink |
| `sync` / `push` / `pull` | 远程 delta + cross-server / content / deletion 未决项（§3.9 详） |

清单与 `PLAN_COMMANDS` Set 一致；新增两阶段命令须同时更新 Set + 本表 + §11.10 自省 fixture。

**单阶段命令 — 轻量 dry-run**（`plan_schema === null`；执行成本低、决议项少，只提供 `--dry-run` + `--json`，输出与 plan **同 schema**）：

| 命令 | dry-run 应列出 |
|------|---------------|
| `scan` / `scan --migrate-unmanaged` | 待 register 的新 skill + 待迁移的 unmanaged skill |
| `link build` | reconcile 的 symlink 增删（多 agent 多 skill 时涉及几十次 fs 写，但均为本地 ms 级操作） |
| `link set/add/remove/clear` | config 前后 diff + reconcile 的 symlink 增删（执行成本低，单 skill 作用域） |
| `resolve <skill>` | 待覆盖方向 + 涉及 server |
| `doctor --fix` | 待修复项列表 |

单阶段命令的 `--dry-run --json` 输出复用 §3.0.B.2 通用 schema（`actions[]` + `unresolved[]` + `warnings[]`），AI agent 可统一解析；但不提供 plan-then-apply 两阶段调用（轻量命令直接执行更高效）。

**历史注（v2.7.4 round-4，议题 1.2）**：v2.5–v2.7.3 spec 曾以 "Tier 1 / Tier 2" 术语区分两类命令；round-4 删除该术语 — 概念与 `plan_schema` 字段冗余、术语只在 spec 内部使用、CLI 自省未暴露。代码侧同步：`TIER1_COMMANDS` Set 改名为 `PLAN_COMMANDS`，`describeCommand()` 内 `isTier1` 局部变量改名为 `isPlanCommand`。残留旧术语只出现于 CHANGELOG / decisions / round-1~3 历史文档 + `src/core/tier-one-runner.ts` 文件名（v2.7.5 P3 #29 已 rename 为 `plan-execute-runner.ts`）。

#### 3.0.B.4 硬性约束（保护人类体验）

1. **plan 阶段不允许做昂贵操作**：clone / 大型 archive 下载 / `rsync` 文件传输必须发生在 execute 阶段。plan 允许的范围是**常数级网络元数据查询 + 本地探查**：
   - 本地：`fs.stat`、本地 hash 计算、读 config / manifest
   - 网络元数据（允许）：`git ls-remote`、HTTP HEAD 探针、**SSH 元数据命令（`ssh <host> ls/stat/cat`、receiver `scan-agents` / `refresh-manifest` 等输出 KB 量级 JSON 的调用）**
   - **禁止**：`git clone`、HTTP body 下载（MB+ archive）、`rsync` 真实文件传输
   - 准则：每次网络请求的数据量必须为**常数级（KB 量级）**，不依赖 skill 数量、仓库大小或目录文件数。否则用户回车后会"卡住"。
2. **`buildPlan()` 与 `executePlan()` 都是纯函数**：从不 prompt、从不写盘、从不发起写网络请求。两者完全可重放。
   - **`resolve_phase: "execute"` 的 unresolved**：少数决议项的 candidates 只有 execute 阶段才能枚举（plan 阶段连"候选集"都拿不到）。这些项在 plan 中已用 `resolve_phase: "execute"` 显式标注（§3.0.B.2），agent 据此机读判断。目前唯一的此类项是 `install` 的 `skill-selection`（凡需 materialize/clone/download 后才能可靠枚举实际 skill 集合的 external install 路径，均可使用该 kind；不限于 git source）。`executeInstallPlan()` 允许在 materialize 完成后、TTY + 无 `--apply` + 无 `--no-interactive` 组合下，弹出 inquirer prompt 收集 skill 子集决议；其他所有命令、其他所有 kind（`resolve_phase: "plan"` 项）都**不允许** execute 阶段 prompt。
   - `resolve_phase: "execute"` 项在以下模式下**仍不弹 prompt**，按下表降级：
     - `--apply <plan>` / `--apply -`：plan 含此类 unresolved 时必须用 `--resolutions` 提供决议；缺决议直接 `E_UNRESOLVED` + exit 7（不弹 prompt）。
     - `--no-interactive` 单独使用：输出 `prompt` 事件 + `E_NEEDS_INPUT` + exit 4。
     - `-y` / `--yes`：按 `default_under_y = 全选` 自动决议，不弹 prompt。
     - 非 TTY 环境：等价 `--no-interactive`。
3. **prompt 在 orchestration 层、按模式开关**：
   - **模式 A — 显式 plan/apply**（`--plan` / `--apply <path|->` 任一,含旧 `--apply-stdin` alias）：orchestration 也**不得 prompt**。unresolved 通过 plan 输出 + `--resolutions <path|->` 解决。
   - **模式 B — 非交互**（`--no-interactive`、`--yes`、或非 TTY 环境，不带 `--plan`/`--apply`）：orchestration 也**不得 prompt**。unresolved 按 `-y` 时的 `default_under_y` 自动决议；`--no-interactive` 单独使用则输出 `prompt` 事件 + `E_NEEDS_INPUT` + exit 4。
   - **模式 C — 纯交互**（TTY ＋ 无以上任何 flag）：orchestration 允许在 buildPlan 之后、executePlan 之前一次性 prompt 收集决策。Ctrl+C 视同 abort，整个命令以 exit 4 结束。
4. **TTY + 无 flag 时 prompt 体感与今天一致**：用 `@inquirer/prompts` 原生组件，不让用户感知底层有 plan 抽象（模式 C）。

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

# 离线决策后携带决议执行（用 `-` 从 stdin 流式传决议，免临时文件）
syncskill --json --no-interactive \
  --resolutions - install https://github.com/... <<< "$resolutions"

# 或直接重放上一步生成的 plan：命令名从 plan.command 自动读取
syncskill --json --apply plan.json

# 流式重放（plan 从 stdin）
cat plan.json | syncskill --json --apply -
```

**`--apply` 与命令名规则**：

- plan 文件必含 `command` 字段（§3.0.B.2 schema）。**action id 格式**：约定为 `a<N>`（`/^a\d+$/`），由 `assignActionIds()` 自动分配；`tests/spec-json-examples.test.ts` 锁定此格式（v2.7.5 P3 #25）。
- 当 CLI 行同时显式给出命令名时，**两者必须一致**，否则报 `E_PLAN_COMMAND_MISMATCH` + exit 2。
  - 例：`syncskill --apply plan.json install ...` 时，`plan.command === "install"`。
- 当 CLI 行**不给**命令名（如 `syncskill --apply plan.json`）时，从 `plan.command` 读取并路由到对应命令。

这让 AI agent 既可"无脑重放 plan"（不指定命令名），也可"显式指定命令并复用 plan 子集决议"，两种用法语义对齐。

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
| `init [--skip-scan] [--skip-self] [-y/--yes]` | 创建 `~/.syncskill/` 目录结构和 config.json；默认安装 syncskill skill（`--skip-self` 跳过；TTY + 未安装时会询问，默认 Y） |
| `install` | 无参数 → 打印 help + exit 0（首次用户请用 `syncskill init`）；`--json` 无参数 → `result.ok=true` + hint |
| `install self` | 安装内置 syncskill skill（`self` 是保留位置关键字；本地 `./self` 目录请显式写 `install ./self`） |
| `install <url-or-path>` / `i <url-or-path>` | 安装外部来源 |

`install` 完整参数：

- `self`（保留位置关键字）：安装内置 syncskill skill
- `--name <name>`：指定 source 名称
- `--path <path>`：指定存储路径
- `--skill-subdir <dir>`：指定 skill 所在子目录
- `--type git|http|local`：强制 source 类型（detectSourceInput 99% 情况下可推断）
- `--branch <branch>`：Git 分支（默认自动检测）

通用 flag 见 §3.0；plan/execute 行为见 §3.0.B。

**Link 管理**

链接命令双轨：人类用 verb（`edit`/`add`/`remove`/`clear`/`build`）表达增量意图；AI agent 用 declarative（`set` + `build`）表达终态。

| 命令 | 模式 | 受众 | 说明 |
|------|------|------|------|
| `link edit [skill]` | 交互（需 TTY） | 人类 | 进入矩阵编辑器 |
| `link add <skill> <agent>...` | 增量 | 人类 | 在 `config.links[skill]` 上追加 agents |
| `link remove <skill> <agent>...` | 增量 | 人类 | 从 `config.links[skill]` 移除 agents |
| `link clear <skill>` | 增量 | 人类 | 删除该 skill 的所有 link + 从 config 移除 |
| `link build` | 批量（单阶段） | 人类 / AI | 按 config reconcile：创建/删除 symlink；支持 `--dry-run` + `--json` |
| `link set <skill> <agent>...` | 声明式 | AI agent | 覆盖 `config.links[skill]` 为给定 agents |
| `link list` / `link ls` | 只读 | 人类 / AI | 显示已落盘的链接状态矩阵（realized state） |

**`unlink <skill>`**：顶级别名，等价 `link clear <skill>`。

**AI agent 推荐用法**：先 `link set <skill> <agents>...` 写 config（declarative），再 `link build` 执行 reconcile。避免用 `add`/`remove` —— 这些是人类 verb，多次调用会被多个 agent 互相覆盖。

**子选项**：

- `-v` / `--verbose`（仅 `list`）：显示文字状态而非符号
- 通用 flag 见 §3.0；plan 行为见 §3.0.B

**通配符语义（`'*'`）**：

`link set <skill> '*'` 写入 `["*"]`：**通配符语义**——将来新增的 agent 自动包含。希望"当前快照"用显式列表。

**参数校验**：所有 `<agent>` 参数必须在 `config.agents` 中存在（除 `'*'`），否则报 `E_AGENT_NOT_CONFIGURED` + exit 2。

**`link list` 与同名 skill 歧义**：保留子命令名（`list`/`ls`/`edit`/`add`/`remove`/`clear`/`build`/`set`）始终优先匹配子命令。同名 skill 通过 `link edit <skill>` 操作。注：`unlink` 是顶级命令（等价 `link clear`），不在 link 子命令命名空间，因此 skill 名为 `unlink` 时不冲突——`syncskill unlink unlink` 即"unlink 名为 unlink 的 skill"。

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
- `--force`：强制更新 dirty source（git 走 `git stash`；http 写 `~/.syncskill/.backups/sources/<source>/pre-update/`,详见 §3.8）

注：dirty source 默认 skip + warning（exit 6），hint 字段输出"如何手动备份"的可执行命令片段。`--force` 是 escape hatch，多数情况推荐用户用原生 `git stash` 处理后再跑 `update`。

**Scan 扫描**

| 命令 | 说明 |
|------|------|
| `scan [--migrate-unmanaged]` | 扫描 sources 中新增的 skill；同时检测 agent 目录中未纳管的 skill。`--migrate-unmanaged` 同时迁移未纳管 skill 到 `~/.syncskill/skills/` |

通用 flag 见 §3.0；plan 行为见 §3.0.B。

**Remote 管理**（v2.7.4 BREAKING：原 `server` 命令族并入 `remote`）

`remote` 命令族同时管 **SSH 端点（`config.servers[<name>]`）** 和 **远端 receiver 配置的本地备份**（`~/.syncskill/receivers/<server>.json`，详见 §3.3）。本地备份是远端 `receiver_config.json` 的真相源：所有编辑通过 `remote` 命令操作本地备份，push 时同步到远端，避免每次配置变更都走 SSH 往返。

**注**：config.yaml 顶层字段名 `servers:` 保留（不破坏既有用户 config）。CLI 文字面 `server` 在 v2.7.4 BREAKING 中彻底删除——原 `server` 命令族 (`server` / `server list` / `server show <name>`) 合并到 `remote add/rm/list` 下；`server probe` 早已删除（其功能由 `status <server>` 和 `refresh <server>` 覆盖）。

命令面采用 **action-first** 词序（`remote <action> <server> [...args]`）。无参数 `remote` 仍是矩阵编辑器入口。

| 命令 | 说明 |
|------|------|
| `remote` | 进入 skills × servers 矩阵编辑器 |
| `remote add <name> --host=... [--user=... --port=... --identity-file=... --remote-repo=...]` | v2.7.4 PR 5b：注册 SSH 端点；写 `config.servers[<name>]`（替代旧 `server add`）；`--host` 必传，缺失 → `E_USAGE` exit 2 |
| `remote rm <name>` | v2.7.4 PR 5b：删除 SSH 端点（替代旧 `server rm`）；不存在 → `E_REMOTE_NOT_FOUND` exit 2 |
| `remote list` / `remote ls` | v2.7.4 PR 5b：列出所有已配置的 SSH 端点（替代旧 `server list`） |
| `remote show <server>` | 打印本地备份内容（remote_agents + links 矩阵）。backup 不存在 → **in-memory 返回空 backup，不写盘**（只读命令不应该有副作用） |
| `remote agent ls <server>` | 列出本地备份中的 `remote_agents`。backup 不存在 → **in-memory 返回空列表，不写盘** |
| `remote agent add <server> <name> <path>` | 向本地备份的 `remote_agents` 加一条；backup 不存在 → 自动建空 backup + 完成写入并落盘 |
| `remote agent rm <server> <name>` | 移除一条 agent；同时移除 `links` 中对该 agent 的引用；backup 不存在 → **in-memory 空 backup，no-op，不写盘** |
| `remote link ls <server>` | 显示 skill × agent 矩阵（仅该 server）；backup 不存在 → **in-memory 返回空矩阵，不写盘** |
| `remote link add <server> <skill> <agent>` | 在 `links[skill]` 中追加 agent（接管意图）；backup 不存在 → 自动建空 backup + 完成写入并落盘 |
| `remote link rm <server> <skill> [<agent>]` | 移除 `links[skill]` 中的某 agent；省略 agent = 清空该 skill 的 links；backup 不存在 → **in-memory 空 backup，no-op，不写盘** |
| `remote takeover <server> <skill> [--agent <a>]` | 显式接管远端非 symlink 真目录：SSH 删除 + 重建 symlink。详见 §3.18 |

**Backup 创建语义（v2.3 audit-4 修订）**：
- **只读命令**（`show` / `agent ls` / `link ls`）：backup 不存在时返回 in-memory 空备份（`{version:1, remote_agents:{}, links:{}}`），**绝不落盘**。这避免 AI agent 跑 `remote show` 探测时悄悄制造空文件，符合"读操作零副作用"原则。
- **空操作命令**（`agent rm` / `link rm` 在 backup 不存在时）：与只读命令同语义——in-memory no-op，**不落盘**，info 提示"backup 不存在，操作 no-op"。
- **写入型命令**（`agent add` / `link add`）：backup 不存在时先 `createEmptyReceiverBackup(server)` in-memory 再叠加写入，**最终原子落盘**一次。这让用户从未跑 `refresh <server>` 也能开始配置 — `remote agent add prod claude ~/.claude/skills` 在 `prod` 是新 server 时直接工作。

注：远端拓扑的刷新（SSH scan-agents → 创建/合并 backup）由顶层 `refresh <server>` 命令承担，不是 `remote` 子命令族的一部分。

**默认 `links=[]` 的含义**：远端独有的 skill（用户手动放在 agent 目录下的真目录）首次被 `refresh <server>` 的 scan-agents 发现时，备份的 `links[skill] = []` 表示"已知该 skill 存在但未激活同步"。push union(links) 不会包含它（不主动推送 / 不主动 link 到任何 agent），远端原 agent 目录下的真目录也不会被动（保护机制详见 takeover 决议项，§3.0.B.2 / §3.9）。用户后续用 `remote link add <server> <skill> <agent>` 显式激活同步。

**重置 backup**：需要从零重建时使用 shell 工具：

```bash
rm ~/.syncskill/receivers/<server>.json
syncskill refresh <server>
```

`refresh <server>` 会重新做 SSH 扫描，从零生成与现状对齐的备份。

**Receiver 部署依赖**：`refresh <server>` 首次运行时若远端尚未部署 receiver，会先调用 `deployReceiver()`（含 `bootstrap_remote.sh` 自动执行），再走 SSH 扫描流程。

**通用 flag 与 plan/execute 协议**：

- `remote agent {add|rm}` / `link {add|rm}` 是纯本地命令，直接 execute，不支持 plan/apply。
- `remote show` / `agent ls` / `link ls` 是只读命令。

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
| `restore <skill> [--server <s>] [--all-servers]` | 从 `~/.syncskill/.backups/skills/<skill>/pre-pull/` 回滚最近一次 pull / sync 覆盖。同时把所有（或指定）server 的该 skill manifest 条目标记为 `status=conflict + direction=conflict`，强制后续 `resolve` 决定推/拉方向。无 backup → `E_BACKUP_NOT_FOUND` exit 3 |
| `refresh [server]` | 刷新本地 + 远程 manifest 后显示状态；带 `[server]` 时**同时刷新远端拓扑**（SSH scan-agents → 更新 `receivers/<server>.json` 备份，合并语义同原 `refresh <server>`：不覆盖手动 `link add` 设过的条目，仅追加新发现） |
| `refresh --local` | 只刷新本地 hash，不显示状态 |
| `refresh --remote` | 只刷新远程 hash + 远端拓扑，不显示状态 |

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
- `--apply <path|->`：执行预生成 plan(`-` = stdin;旧 `--apply-stdin` 为 alias)
- `--resolutions <path|->`：携带决议绕过 prompt(`-` = stdin;旧 `--resolutions-stdin` 为 alias)
- `--config <path>`：覆盖 config 文件路径
- `--sync-dir <path>`：覆盖 `~/.syncskill/` 目录
所有命令（除 `init`、`config`、`refresh`、`doctor`、`restore`）执行前在同一个 `preAction` 钩子里自动调用 `autoDiagnoseConfig()` + `autoRefreshManifests()`。两个钩子排除集相同（详见 §10.5）。`restore` 是纯本地 backup 恢复操作，不需要网络刷新。

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
- **Default Link Targets 计算**：`install`、`init` 迁移、`scan` 等场景自动为新 skill 计算默认 link target。
  - **`ensureDefaultLinkTargets(config)`**：统一入口。先保证 `~/.agents/skills/` 存在（必要时创建目录、写入 `config.agents.agents` 字段并 `saveConfig()`，首次创建时打印提示），再计算默认 link target 数组。规则：
    1. 默认 target 为 `["agents"]`（即 `~/.agents/skills/`，跨客户端标准目录）
    2. 遍历已检测到的 agent，若该 agent 属于 `private_agents`（不读取共享目录），则追加到 target 列表
    3. 返回最终 target 数组，如 `["agents", "cursor", "kiro"]`
  - `install` / `init` 迁移 / `scan` / `update` 等需要"自动给新 skill 算默认 link 目标并立刻可用"的入口点统一调用此函数。
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
- **宽容加载（v2.9 L3）**：`loadConfig()` 对 optional 字段缺失不 throw，改为填充默认值：`sources` → `{}`，`servers` → `{}`，`private_agents` → `DEFAULT_PRIVATE_AGENTS`，`conflict_resolution` → `"manual"`。仅 `version`/`agents`/`links` 三个字段保持 strict throw。这减少代码升级后因旧 config 缺少新字段而触发 L1 backup 的概率
- **`saveConfig` 退化检测（v2.9 L2）**：`saveConfig()` 写入前读取磁盘上的旧 config。如果旧 config 的 `servers` **和** `links` **同时**有非空条目、但新 config 两者**同时**变为空对象 → 视为"意外重置"签名，拒绝写入 + throw `E_CONFIG_REGRESSION`。单独一个字段归零是合法操作（`unlink` 清空所有 links / `remote rm` 删除最后一个 server），只有两者同时归零才是代码 bug 的信号。`initRepo` 的显式重建路径用内部 `saveConfigForce()` 绕过此检查
- **测试沙箱 lint（v2.9）**：`tests/config-sandbox-lint.test.ts` 静态扫描所有 `.test.ts` 文件，对进程内调用 `saveConfig` / `saveConfigForce` / `ensureDefaultLinkTargets` / `buildInstallPlan` / `installBuiltinSkill` / `initRepo` 的测试文件，验证存在 `process.env.SYNCSKILL_DIR = ...` 的沙箱化设置。违反 → CI 立刻失败。防止测试通过进程内调用覆盖真实的 `~/.syncskill/config.json`。与 `force-callsite-lint.test.ts`（round-2 Plan P）同一哲学：用 lint 替代脆弱的人类约定
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
  Configured Skills → Agent Assignment       Page 1/3

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

**`link edit`**（无 skill 参数）：直接调用矩阵编辑器。矩阵行集合 = managed local skills ∪ active source-derived skills ∪ `config.links` 中已存在的 skill key；其中 source-derived skills 按 leaf-skill 规则发现，并过滤 `config.sources[*].ignore[]`。这样 source 安装得到的 skill 可直接配置，且坏状态下残留的 `config.links` 条目不会从 UI 中消失。退出矩阵编辑器后，若 links 配置发生了变更，交互式询问用户是否立即 build（等效于 `link build`，创建/清理 symlink 使实际状态与配置一致）。用户确认则执行 reconcile，拒绝则仅保存配置不操作 symlink。

**`link list`** / **`link ls`**：显示已落盘的链接状态（realized state），不是配置意图矩阵。

默认符号版输出：
```
Realized Link Status
Current on-disk state for managed skills × agents. Use `syncskill link` to edit configured targets.
Symbols: `-` = not configured, `·` = configured but missing on disk.

Skill                    claude*   agents    cursor*   kiro*
────────────────────────────────────────────────────────────
web-artifacts-builder    ⚠         ·         ✓         -
web-design-guidelines    ⚠         ·         ✓         -
webapp-testing           ✓         ·         ✓         -
xlsx                     ✗         ·         -         -

Legend: ✓ linked  ⚠ copied  · missing  ✗ broken  - unconfigured
        * = private agent (requires separate link)
```

`-v` / `--verbose` 文字版输出：
```
Realized Link Status
Current on-disk state for managed skills × agents. Use `syncskill link` to edit configured targets.
Symbols: `-` = not configured, `·` = configured but missing on disk.

Skill                    claude*        agents         cursor*       kiro*
───────────────────────────────────────────────────────────────────────────
web-artifacts-builder    copied         missing        linked        unconfigured
web-design-guidelines    copied         missing        linked        unconfigured
webapp-testing           linked         missing        linked        unconfigured
xlsx                     broken         missing        unconfigured  unconfigured

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

**`ServerConfig.agents`（降级为 hint）**

远端 agent 集合由 **本地备份 `~/.syncskill/receivers/<server>.json`** 表达（详见下方"远端 receiver 本地备份"）。`ServerConfig.agents` 字段在以下场景作为 hint 使用：

1. `refresh <server>` 执行时若 SSH 扫描完全发现不到任何 agent（极少数无标准 agent 目录的远端），`ServerConfig.agents` 中的条目作为初值写入新备份。
2. **scan-based auto-synthesize**（v2.3 audit-3）：push / sync 时若 `~/.syncskill/receivers/<server>.json` 不存在（未跑 `refresh <server>`、新用户跳过 remote 命令直接 push），push 路径**先 SSH `scan-agents` 拉真实远端布局**，按下表分类填 `links` 后持久化为新备份：

   | 远端发现 | 写入 `links[skill]` |
   |---------|--------------------|
   | agent 目录下是 **symlink**（已被 syncskill 管理） | `[<agent>]`（追加，多 agent 累加） |
   | agent 目录下是 **真目录**（用户手放） | `[]`（保护；不创建 link，push 时 skip + `W_TAKEOVER_NEEDED`；接管需显式 `remote takeover`，详见 §3.18） |
   | 仅出现在 `~/.syncskill/skills/`（远端 manifest 有但 agent 下无） | `[]` |
   | 本地 push 集中、远端完全不存在 | 取 `config.links[skill]` 若非空，否则 fallback `Object.keys(remote_agents)`（用户本地已声明的 link 意图优先；未声明视为全 agent） |

   合成完成后持久化为 backup（与 `refresh <server>` 等效），info 提示 `Created receiver backup … (auto-synthesized from remote scan)`。**SSH 扫描失败**（网络、receiver 未部署、远端 Node 太旧等）→ **硬失败**，抛 `E_RECEIVER_SCAN_FAILED`（exit 5），hint：`Cannot auto-synthesize: remote scan failed (<reason>). Run \`syncskill refresh <server>\` manually to retry, or check SSH/receiver setup.` **不软回退**到老的 "config-based 全连合成"——避免拿到伪 backup 后所有 remote 命令基于错误状态。
新部署 / 新 server 维护远端 agent 集合的推荐流程：① 跑 `refresh <server>` 主动 preview（也会落盘 backup），② 按需 `remote agent/link add` 微调，③ `push` 应用。也可以省略 ① 直接 `push <server>`，scan-based auto-synthesize 会做等价工作（前提是 SSH 通）；`refresh <server>` 因此从"必跑"变成"可选 preview / 调试"。

```json
{
  "agents": {
    "claude": "~/.claude/skills",
    "hermes": "~/.hermes/skills"
  }
}
```

**远端 receiver 本地备份（`~/.syncskill/receivers/<server>.json`）**

每个 server 一份独立 JSON 文件，是远端 `~/.syncskill/receiver_config.json`（§3.13）的**本地真相源**。push 时 scp 同步到远端，远端 receiver 按此文件决定 link 行为。所有编辑通过 `remote` 命令族（§3.1）操作本地备份，避免每次配置变更走 SSH 往返。

schema（v1）：

```json
{
  "version": 1,
  "server": "prod",
  "updated_at": "2026-05-25T00:00:00Z",
  "remote_agents": {
    "claude": "~/.claude/skills",
    "agents": "~/.agents/skills"
  },
  "links": {
    "skill-a": ["claude", "agents"],
    "skill-b": ["claude"],
    "skill-c": []
  }
}
```

- `remote_agents`：远端实际存在的 agent 名 → 远端目录路径映射。由 `refresh <server>` 通过 SSH 扫描候选目录（§3.2 候选路径列表的远端版）发现并填充。
- `links`：per-server skill × agent 矩阵。`links[skill]` 为 agent 名数组（支持通配符 `'*'`）；**空数组 `[]` 表示"已知但不激活"**——常见于 `refresh <server>` 发现的远端独有 skill。push 推送集 = `union(links[skill] 非空的所有 skill)`（§3.9）。
- `updated_at`：备份本身的最后修改时间（供调试 / 比较使用，不参与同步逻辑）。

文件由 `remote` 命令族原子写入（先写 `<server>.json.tmp` 再 `rename`），doctor 检测到 JSON 解析失败时备份为 `<server>.json.bak` 后重建为空 schema（与 `skills-registry.json` 处理一致）。

### 3.4 `repo.ts` — 仓库初始化

- 创建 `~/.syncskill/` 目录（含 `skills/`, `manifests/` 子目录）
- 生成 `~/.syncskill/config.json`（含自动检测的 agent）
- 复制 `config.example.yaml` 作为参考
- **Config 保护（v2.9 L1）**：当 `config.json` 文件存在但 `loadConfig()` 抛异常时（验证失败、JSON 损坏等），`initRepo` **先备份**再创建新默认 config。备份路径：`config.json.pre-init-<ISO-date>.bak`。同时在 stderr 打印 `W_CONFIG_RESET` 警告（含备份路径 + 恢复命令）。`--json` 模式同时 emit warning 事件。这防止代码升级引入新验证规则时静默丢失用户的 servers/links/sources 数据
- **自动迁移已有 skills（默认行为）**：当 `~/.syncskill/` 目录不存在或 `~/.syncskill/skills/` 为空时，按顺序扫描 agent 目录，将发现的**顶层 skill 目录**复制到 `~/.syncskill/skills/`。迁移单位是各 agent `skills/` 根下的一层目录；允许该目录作为 bundle / namespace 容器存在，即使顶层本身没有 `SKILL.md`，只要其子目录承载实际 leaf skills。重名 skill 不覆盖，以前面扫描到的目录为准。仅复制普通文件，跳过软链接。`--skip-scan` 参数跳过此步骤。
- **自动更新 links**：如果迁移了 skills，自动将迁移的 skill 名写入 `config.json` 的 `links` 字段（使用 `ensureDefaultLinkTargets()` 计算默认目标，即 `["agents"]` + 已检测到的不支持 `~/.agents/skills/` 的 agent）。
- **本地 managed skill 与 source skill 的发现语义不同**：`~/.syncskill/skills/` 下按顶层目录识别 managed skill，不要求顶层目录直接包含 `SKILL.md`；而 source / install 的发现继续遵循 leaf-skill 规则：single-skill root 直接包含 `SKILL.md`，multi-skill root 通过 `skills/<leaf>/SKILL.md` 识别。`syncskill link` 与 `doctor` 的可见 skill 集合 = managed local skills ∪ active source-derived skills；其中 source-derived 集合按 leaf-skill 规则发现，并过滤 `config.sources[*].ignore[]`。另外 `syncskill link` 仍保留 `config.links` 中已存在但当前文件缺失的 skill 行，便于修复坏状态。
- **默认安装 syncskill skill（first-run 入口）**：v2.7.4 PR 5c（议题 1.5）起，`init` 是 first-run 安装内置 skill 的官方入口（`install` 命令的无参数 inquirer 菜单已删除）。流程末尾安装内置 syncskill skill 到 `~/.syncskill/skills/syncskill/` 并 link 到默认 agent（计算规则见 §3.2 `ensureDefaultLinkTargets()`）。
  - **TTY + 未安装时**：弹出 `confirm` prompt "Install built-in syncskill skill now? [Y/n]"（默认 Y）。用户按 N → 跳过安装；按 Ctrl-C → 跳过安装但 init 仍报成功。
  - **非 TTY / `--no-interactive` / `--json` / 已安装**：跳过 prompt，按默认行为执行（未安装则直接安装 → 保持 CI / script 中 `init` 一键即用的长期期望）。
  - **`--skip-self`**：始终跳过（最高优先级，覆盖上述所有路径）。

### 3.5 `install.ts` — Skill 安装

处理 `syncskill install` / `syncskill i` 命令。**`source add` 已合并到此命令**——通过 `install <url-or-path>` 统一入口安装外部来源。

`install` 内部统一遵循 §3.0.B plan-then-execute 协议。

**无参数调用**（v2.7.4 PR 5c BREAKING，议题 1.5）：

`install` 无参数始终打印 help + exit 0。早期版本（≤ v2.7.3）在 TTY 下弹出 inquirer 菜单（self / url / cancel），但菜单仅 2 个真实选项，价值低且与 install 真正职责（从外部 source 安装）混淆 —— 已删除。**first-run 自安装内置 syncskill skill 的官方入口是 `syncskill init`**（见 §3.4 末尾的 prompt 描述）。

```
syncskill install
├─ --json → emit {"type":"result","command":"install","ok":true,
│             "summary":{"message":"no target provided; use `install self` or `install <url>`"},
│             "data":{"hint":"first-run users: run `syncskill init` for guided setup"}}
└─ 其他模式（TTY、--no-interactive、非 TTY） → 打印 commander help + exit 0
```

**v2.7.3 → v2.7.4 行为差异**：

<!-- 注：此 diff table 待 v2.7.5 后第 N 个 BREAKING 落地时移到 CHANGELOG (spec only keep current behavior)。
     v2.7.4 BREAKING 仍是 fresh，留作上一版迁移参考；P3 #27 (v2.7.5)。 -->

| 调用 | v2.7.3 | v2.7.4 |
|------|--------|--------|
| `install`（TTY）           | inquirer 菜单（self/url/cancel） | help + exit 0 |
| `install`（非 TTY）        | help + exit 0                    | help + exit 0（不变） |
| `install --no-interactive` | P_INSTALL_SELECT + E_NEEDS_INPUT + exit 4 | help + exit 0 |
| `install --json`           | E_NEEDS_INPUT + exit 1           | `result.ok=true` + hint + exit 0 |

迁移：习惯了从菜单选"Built-in syncskill skill"的人类用户改用 `syncskill init`（一键完成 first-run 全流程，包括 self skill 安装）。脚本 / CI 仍可用 `install self` / `install <url>` 精确调用。

**安装内置 syncskill skill**：

```
syncskill install self
├─ Plan: 探查 ~/.syncskill/skills/syncskill/ 是否已存在
│   ├─ 已存在 → plan.actions 为空 + info "already installed"
│   └─ 不存在 → plan.actions: [copy-builtin, link-skill, create-symlink]
├─ Pre-execute 检测：cwd 存在 ./self/ 目录？
│   └─ 是 → 打印 W_INSTALL_SELF_AMBIGUOUS 警告（不阻断）
│        例：`warning: A directory named "./self" exists in the current
│        working directory. "install self" installs the built-in syncskill
│        skill (not your local directory). To install ./self, run
│        \`syncskill install ./self\` instead.`
├─ Execute:
│   ├─ 定位 dist/skills/syncskill/ 目录（通过 import.meta.url）
│   ├─ 复制到 ~/.syncskill/skills/syncskill/
│   └─ 调用 link reconcile（使用 ensureDefaultLinkTargets() 计算目标 agent）
└─ 输出 result.summary.data（schema 见 §11.6）
```

**`self` 保留位置关键字**：`install self` 直接调用此分支，**不再有 `--self` flag**。如果用户本地有名为 `self` 的目录需要安装，使用显式路径 `install ./self`（任何含 `/` 或 `.` 前缀的输入都按"路径"解析）。cwd 含 `./self/` 时会发 `W_INSTALL_SELF_AMBIGUOUS` 警告（exit 0，不阻断）。

**从 URL/路径安装**：

```
syncskill install <url-or-path> [--name <n>] [--path <p>] [--type git|http|local] [--branch <b>]
├─ Plan 阶段（只读探查）：
│   ├─ detectSourceInput(input) — 类型推断
│   ├─ git source: git ls-remote 拿 HEAD ref（轻量）
│   ├─ http source: HEAD 请求拿 Content-Type / Content-Disposition
│   ├─ local source: fs.stat 验证存在
│   ├─ 计算默认 name / path（推断或显式 --name/--path 覆盖）
│   ├─ 推断会发现的 skill 集合（凡需 materialize 后才能可靠枚举实际 skill 集合的 external source →
│   │   plan 标 unresolved.kind="skill-selection" + resolve_phase="execute"
│   │   （§3.0.B.2）。execute 阶段 materialize 完成后列出 candidates 并按 flag 处理：
│   │     - TTY → 弹 prompt（§3.0.B.4 约束 2 允许 resolve_phase=execute 的
│   │       项在 execute 内部作为 sub-plan 周期处理；非"例外"，是正规化的契约）
│   │     - `-y` / `--resolutions <path|->` 提供 → 应用决议
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

**参数说明**：`install self`（保留位置关键字）安装内置 skill；其余 flag 用于外部来源安装。

**输出示例**：

```bash
# 无参数 → 打印 help（v2.7.4 PR 5c BREAKING：菜单已删除）
$ syncskill install
Usage: syncskill install|i [options] [url-or-path]
...

# 无参数 + --json → result.ok=true + hint
$ syncskill install --json
{"type":"result","command":"install","ok":true,"summary":{"message":"no target provided; use `install self` or `install <url>`"},"data":{"hint":"first-run users: run `syncskill init` for guided setup"}}

# first-run 用户应改用 init
$ syncskill init
✓ Created ~/.syncskill/
? Install built-in syncskill skill now? (Y/n) Y
✓ Installed syncskill skill

# 安装内置 skill（保留位置关键字）
$ syncskill i self
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
| `link build` | 人类 / AI | 按 config reconcile symlinks |
| `link set <skill> <agent>...` | AI agent | declarative 覆盖 |
| `link list` / `link ls` | 人类 / AI | 只读查询 |

**AI agent 优先用法**：`link set <skill> <agents>...`（写 config）+ `link build`（reconcile）。避免 `add` / `remove` —— 这些是人类 verb，多个 agent 并发调用容易互相覆盖；`set` 是 declarative，可幂等重放。

**三级降级策略**：
1. `fs.symlink()` — 标准软链接
2. Windows Junction（通过 `fs.symlink(target, link, 'junction')`）
3. `fs.cp(source, target, { recursive: true })` — 拷贝（带警告）

支持：创建链接、状态检查、删除、扫描（walk 目录发现新 skill）。

**Stale Link Reconcile**：

`link build`、`link set/add/remove/clear` 落盘后、以及矩阵编辑器退出后的 build 操作，都需要清理 stale 的 syncskill 管理的软链接。当用户通过矩阵编辑器（或 `link set`）将某个 skill 从 `["*"]` 改为 `["claude"]` 后，其他 agent 目录中残留的旧链接应被自动清理。

- `link edit <skill>`：单 skill 矩阵编辑器，退出后 reconcile 该 skill 的链接状态
- `link edit`：全局矩阵编辑器，退出后 reconcile 所有变更的 skill
- `link set/add/remove/clear`：落盘前先 reconcile 受影响 skill 的链接（dry-run 时仅打印）
- `link build`：按 config 配置 reconcile 所有 skill 在所有 agent 目录中的链接状态

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
- **`-y/--yes`**：显示摘要，自动确认（**default under -y = 同意清理**，与 prompt 默认 `Y` 一致）
- **`--dry-run`**：只显示，不执行也不询问

**`link build` dry-run 协议**（单阶段命令）：

`link build` 是单阶段命令（`plan_schema === null`，见 §3.0.B.3），仅支持 `--dry-run` + `--json`（不提供 `--plan` / `--apply` / `--resolutions`）。多 agent 多 skill 时可能涉及几十次 fs 写，但均为本地 ms 级 symlink 操作，无需 plan-then-apply 两阶段。

**dry-run 输出 schema**（复用 §3.0.B.2 通用 plan schema）：

```json
{
  "version": 1,
  "command": "link build",
  "actions": [
    { "op": "create-symlink", "skill": "skill-a", "agent": "claude", "from": "...", "to": "..." },
    { "op": "remove-symlink", "skill": "skill-b", "agent": "hermes", "path": "..." }
  ],
  "unresolved": [
    {
      "kind": "link-cleanup",
      "to_remove": [{ "skill": "skill-b", "agent": "hermes", "path": "..." }],
      "default_under_y": "approve"
    }
  ],
  "warnings": []
}
```

**`command` 字段约定**：含子命令时直接用空格连接（`"link build"` / `"source remove"`），与 CLI 行书写一致。不引入 `subcommand` 字段。

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
$ syncskill link build

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
$ syncskill link build -y

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

**v2.7.4 round-4 议题 2.1（BREAKING）**：`-y` 永远 = safe default；`link clear` / `unlink` 在 `-y` / `--no-interactive` / `--json` 下默认 abort（`E_USAGE` exit 2），必须显式 `--yes-destructive` 才执行。人类无 flag 时 prompt 仍默认 `N`。迁移：`syncskill -y unlink X` → `syncskill --yes-destructive unlink X`。详见 §3.0.2 与 `decisions-2026-06-02-spec-cleanup-round4.md` §议题 2.1。

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
- `status`：同步状态，取值固定为 7 态枚举之一 —— `in-sync` / `local-changed` / `remote-changed` / `remote-deleted` / `local-deleted` / `conflict` / `new`（`remote-deleted` / `local-deleted` 分别对应远端 / 本地删某 skill 但另一端仍在 baseline 的场景，详见下方 §3.7 case 7 / 7b）。所有写入 manifest 的代码路径都通过 `classifySkillDelta(local, remote, recorded)` 派生该值，避免出现 `changed`、`pending` 等非枚举值。

`recorded_hash` 作为 3-way merge 的基准点，用于判断"谁改了"：
- `local_hash ≠ recorded_hash` → 本地相对基准有变化
- `remote_hash ≠ recorded_hash` → 远程相对基准有变化

这种设计天然解决了"syncskill 外部操作"（如 `git checkout`）的场景：即使本地文件被外部工具还原，`recorded_hash` 保持不变，系统仍能正确检测到本地变化并触发 push。

**Manifest 变更历史** (`manifest_history.json`)：用于追踪 hash 变更事件，仅在 hash 实际变更时追加记录。

**Manifest 健壮性（v2.4 C6）**：

`loadManifest(path)` 的行为按文件状态分桶：

| 文件状态 | 行为 | 调用方理解 |
|---|---|---|
| 文件不存在 (`existsSync` false) | 返回 `null`，无日志 | 合法 "first-time / never synced" |
| 文件存在但 `JSON.parse` 失败 | **`renameSync(path, path + ".bak")` + `console.warn(W_MANIFEST_CORRUPT)` + 返回 `null`** | 损坏路径——绝不静默吞错。下次访问视为 first-time，结合 §3.9 B1 sidecar backup 兜底数据安全 |
| 文件存在且解析成功 | 返回解析结果 | 正常路径 |

警告码 `W_MANIFEST_CORRUPT`（§11.4）说明文案：`"<path> is corrupted; moved to <path>.bak. Re-classified as first-time sync — running pull/sync may overwrite local. Run \`syncskill refresh <server>\` first."`。

**为什么不静默 null**：把"不存在"和"解析失败"混入同一个 `null` 路径，会导致用户**误删 manifest** / 半写损坏 / 跨机器复制漏 `manifests/` 等真实场景被当作 "first-time sync"——在 pull / sync 时与远端同名 skill 发生 `classifySkillDelta` case 6 conflict 时，sink 决议链未通使本地被静默覆盖。通过 rename + 显式 warn 让用户立刻看到信号；结合 doctor 新增的 "config 有 server 但 manifest 缺失" 检查（§10.3）形成完整诊断。

**recorded_hash = null 的歧义**：

`classifySkillDelta` 的 case 6（`recorded_hash === null && local_hash && remote_hash && local_hash ≠ remote_hash`）会被以下**所有真实路径**触发——不是 corner case：

1. 首次 sync 新 server（正常）
2. 用户 `rm ~/.syncskill/manifests/<server>.json`（清理 / 想 reset）
3. Manifest JSON 损坏 → rename `.bak` 后等价 null（§3.7 Manifest 健壮性）
4. 从另一台机器复制 `~/.syncskill/` 但漏了 `manifests/` 子目录（最常见的"复制 config 不复制 manifest"）
5. `~/.syncskill/` 被整目录删除后 `syncskill init` 重建（保留 config，manifest 没了）
6. 磁盘满 / 写入中断导致部分写 → 下次解析失败 → 同上
7. `doctor --fix` 误清

所有 pull 写盘前一律做 sidecar backup（§3.9 B1），即便用户跑了 `sync` 且本地版本被覆盖，也能通过 `restore <skill>` 回滚。


**Delta 比较逻辑**（`classifySkillDelta`）：

返回二元组 `{ action, status }`：

- `action` 取值 `skip` / `push` / `pull` / `delete` / `push-delete` / `conflict` / `init`（同步动作，给 push/pull 引擎消费）
  - `init`：首次同步（recorded 为 null），具体方向（推/拉）由调用方根据哪一侧有 hash 推断
  - `delete`：v2.3 audit-2 S1 引入。远端已删除该 skill 而本地仍在 baseline；plan 把它表面为 `remote-deletion` unresolved（§3.0.B.2），由 `--on-deletion` 决议是否删本地（pull-side deletion）
  - `push-delete`：v2.3 audit-4 G3 引入。本地已删除该 skill 而远端仍在 baseline；plan 把它表面为 `local-deletion` unresolved（§3.0.B.2），由 `--on-local-deletion` 决议是否同步删除远端（push-side deletion）
  - 注意 action 与 status 词表共享 `conflict` 但**不共享 `new`**：状态用 `new`，动作用 `init`；同样 action 用 `delete` / `push-delete`、status 用 `remote-deleted` / `local-deleted`
- `status` 取值 `in-sync` / `local-changed` / `remote-changed` / `remote-deleted` / `local-deleted` / `conflict` / `new`（写入 manifest 的当前状态）

```text
1. local_hash === remote_hash                                                     → skip, in-sync
2. local_hash ≠ recorded_hash && remote_hash === recorded_hash                    → push, local-changed
3. remote_hash ≠ recorded_hash && local_hash === recorded_hash                    → pull, remote-changed
4. recorded_hash === null && local_hash && !remote_hash                           → init, new   (首次同步,推方向)
5. recorded_hash === null && !local_hash && remote_hash                           → init, new   (首次同步,拉方向)
6. recorded_hash === null && local_hash && remote_hash && local_hash ≠ remote_hash → conflict, conflict   (双方独立创建,内容冲突)
7. recorded_hash !== null && remote_hash === null && local_hash === recorded_hash → delete, remote-deleted        (S1 audit-2: 远端删了, 本地未改)
7b. recorded_hash !== null && local_hash === null && remote_hash === recorded_hash → push-delete, local-deleted    (G3 audit-4: 本地删了, 远端未改)
8. local_hash ≠ remote_hash && 以上都不满足                                        → conflict, conflict
```

**新增 `--on-local-deletion` flag（push/sync）**：与 §3.9 既有 `--on-remote-deletion`（pull-side；旧名 `--on-deletion` 保留为 alias）平行。

| 取值 | 行为 |
|------|------|
| `keep-remote`（默认 + `-y` safe default） | 保留远端 skill 原样，本地下次 pull 会拉回——表示"我只是临时删了，不想同步" |
| `delete` | 执行 push 时同步删除远端 skill（rsync 不带特殊参数即可；接着把 manifest 中该 skill 条目从 baseline 移除） |
| `prompt`（仅模式 C） | orchestration 在 buildPlan 之后 executePlan 之前一次性弹 inquirer prompt 逐项 y/N |

`-y` 的 safe default 是 `keep-remote` 而非 `delete`，与 §3.0.5 "`-y` 不暗示破坏性操作" 一致。删除远端 skill 必须显式 opt-in（`--on-local-deletion=delete` 或 resolutions `"choose": "delete"`）。

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

source / install discovery 基于 **SKILL.md** 规则，而本地 managed skills 不是同一套语义。

- **managed local skills**：`~/.syncskill/skills/` 下按顶层目录识别，每个顶层目录就是一个 managed skill；该顶层目录可以是 bundle / namespace 容器，不要求直接包含 `SKILL.md`
- **source / install discovery**：给定一个 source subdir，在该目录下按 leaf-skill 规则发现 skill——single-skill root 直接包含 `SKILL.md`，multi-skill root 通过 `skills/<leaf>/SKILL.md` 识别

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

**default under -y**（skill-selection）：自动选中**所有**发现的 skills（最宽松默认；不会有 skill 被 silently 忽略）。`-y` 同时跳过任何确认。

**同仓库合并逻辑**：

核心原则：**一个 URL 对应一个 source entry**，通过调整 `skill_subdir` 层级和 `ignore` 列表来管理。

**统一原则**：`install <url>` 表达用户对 scope S 的意图——"我要 S 范围内的 skill"。S 内 previously-ignored skills 被 un-ignore（重新激活）；S 外且不属于 existing 区域的 skills 被 auto-ignore。已有 source 的 install 操作**永远不弹 prompt**（source 已受信，与 `scan`/`update` 一致）。

**设计理由**：ignore list 不一定是用户意图（可能是 syncskill 自动添加的，如 Case 3 的 auto-ignore 或首次安装时的 skill-selection 跳过）。用户再次 install 时，新的显式意图应 override 旧的 ignore 决策。

**Case 判定分支**：

```
install <url> 时检测到同 URL source 已存在：

  subdirContains(existing, new)?
    → Case 1: new 在 existing 内

  subdirContains(new, existing)?
    → Case 2: new 比 existing 广（含 identity: new = existing）

  otherwise?
    → Case 3: 互不包含
```

注：Identity（完全相同 URL + subdir）归入 Case 2（`subdirContains(".", ".") = true`）。

**各 Case 行为**：

```
Case 1 — new 在 existing 内：
  → subdir 不变
  → new subdir 内的 ignored skills → un-ignore + link
  → 无 auto-ignore
  → 无 prompt
  例：existing=".", new="examples/skill-a" → un-ignore skill-a

Case 2 — new 比 existing 广（含 Identity）：
  → subdir expand 到 new（Identity 时不变）
  → ALL previously-ignored skills → un-ignore + link
  → 新发现的 skill → 直接 link（source 已受信，与 scan/update 一致）
  → 无 auto-ignore（new scope 覆盖一切）
  → 无 prompt
  例：existing="examples/andrej", new="." → expand to ".", un-ignore all, link all

Case 3 — 互不包含：
  → subdir expand 到 common parent（通常 "."）
  → new subdir 内的 ignored skills → un-ignore + link
  → new subdir 内首次发现的 skill → 直接 link（source 已受信）
  → 跨区域 skill（不在 existing 也不在 new subdir）→ auto-ignore
  → existing 区域保持原状（ignored 仍 ignored）
  → 无 prompt
  例：existing="tools/", new="examples/demo"
      → expand to ".", activate demo
      → tools/ 区域不变, 跨区域 auto-ignore

裸仓库 URL（无 /tree/branch/subdir）：
  → GitHub URL 无 /tree/... 部分时，等同于 skill_subdir="."
  → 若 existing 范围比 "." 窄，走 Case 2 扩大到 "."
  → 若 existing 已是 "."，走 Case 2 Identity
  例：existing="examples", new=bare URL → Case 2, expand to ".", un-ignore all
```

**包含关系判断**：`subdirContains(parent, child)`
- `"."` 包含一切（仓库根）
- `"a/b"` 包含 `"a/b/c"` 但不包含 `"a/x"`
- 同一路径视为包含（identity）

**Un-ignore 联动 skills-registry.json**：当 skill 从 `source.ignore[]` 中移除时，`skills-registry.json` 的 `ignored` map 中对应条目也必须同步清除（`removeIgnore(skillName)`）。

**示例**（nuwa-skill 仓库）：
```
仓库结构：
  /SKILL.md
  /examples/andrej-karpathy-perspective/SKILL.md
  /examples/steve-jobs-perspective/SKILL.md
  ... (~15 个 examples/*/SKILL.md)

# 首次安装（全新 source，多 skill → skill-selection prompt）
syncskill i https://github.com/alchaincyf/nuwa-skill
→ 递归搜索发现 ~16 个 skills
→ 交互式选择：用户选中 "nuwa-skill"，其余加入 ignore
→ config: skill_subdir: ".", ignore: [其余 15 个]

# 后续添加子目录 skill（Case 1: new 在 existing 内）
syncskill i .../tree/main/examples/andrej-karpathy-perspective
→ source 已存在，"." 包含 "examples/..."
→ un-ignore "andrej-karpathy-perspective"，加入 links
→ skill_subdir 保持 "."，无 prompt

# 裸 URL 重装（Case 2 Identity: un-ignore all）
syncskill i https://github.com/alchaincyf/nuwa-skill
→ source 已存在，subdir 均为 "."
→ un-ignore ALL previously-ignored skills（15 个 examples 全部激活）
→ 新发现的 skill（如有）直接 link
→ 输出：Activated 15 previously-ignored skills: steve-jobs, ...
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
│       └─ http source: 将 dirty skills 复制到 `~/.syncskill/.backups/sources/<source>/pre-update/`
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
├─ 对每个被删除的 skill 进入 `unresolved` 决议流（kind = `skill-removed`）：
│   "Skill <X> was removed from source <Y>. Keep it as a local skill?"
│   ├─ TTY 纯交互（无 --no-interactive / --yes）→ inquirer prompt
│   ├─ `-y/--yes`（不论是否非交互）→ 自动选 safe default = `keep`（保留为 manual skill）
│   ├─ `--no-interactive` 但无 `-y` → 输出 prompt 事件 + E_NEEDS_INPUT + exit 4
│   └─ 用户/默认选择：
│       ├─ `keep` → 复制 skill 到 ~/.syncskill/skills/<name>，registry 更新为 manual
│       └─ `remove` → 从 links 中移除，清理软链接，registry 标记删除

Step 5: 输出更新报告（result.summary.data，schema 见 §11.6）
```

**简化决定**（vs 旧版）：

- 不再有 `update-history.json` —— 用户 `--force` 即接受手动恢复成本
- 不再有 `source restore` 命令 —— hint 字段直接输出可执行命令片段
- HTTP source 备份位于 `~/.syncskill/.backups/sources/<source>/pre-update/`（与 pre-pull/pre-restore 同根）
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

**Schema 迁移**：v1 (旧 schema) → v2。`install self` / `init` 升级路径：检测到 v1 registry 时只读取 `ignored` 状态和 `last_update_hash`，丢弃其他派生字段后重写为 v2。doctor 在 v1 → v2 迁移时不视为错误。

**全局 skill 发现**：

统一通过 `discoverAllSkills(homeDir, config)` 函数，合并 `~/.syncskill/skills/` 和所有 sources 的 skill。

- 本地 `~/.syncskill/skills/` 一侧按顶层目录识别 managed skills
- source 一侧继续通过 `discoverSourceSkills(...)` 按 leaf-skill / `SKILL.md` 规则发现

### 3.9 `sync_engine.ts` — 核心同步流程

**Push 流程**（嵌入 §3.0.B plan-then-execute）：

**Plan 阶段（只读）**：

1. 按需部署 receiver：计算本地 `sync_receiver.mjs` 的 MD5 hash，通过 SSH `md5sum` 获取远程文件 hash，仅在 hash 不同或远程文件不存在时重新部署 `sync_receiver.mjs` + `bootstrap_remote.sh`（首次部署时同时 `ssh bash bootstrap_remote.sh` 做目录预创建 + Node 存在性预检）
2. 读取本地 receiver 备份 `~/.syncskill/receivers/<server>.json`（§3.3）：
   - 若备份不存在 → 走 **scan-based auto-synthesize**：详细规则见 §3.3 节场景 2。简述：先 SSH `scan-agents` 拉真实远端布局，按 symlink/真目录/远端独有/本地新建 4 类分别填 `links`；持久化后推流程继续。SSH 失败 → abort + `E_RECEIVER_SCAN_FAILED`（exit 5），用户需先跑 `syncskill refresh <server>` 或修 SSH 后重试。
   - 备份存在 → 提取 `remote_agents` + `links` 矩阵进入下游步骤
3. **计算推送集**：`pushSet = { skill | links[skill] 非空 且 该 skill 在本地存在 }`。push 不"推所有本地 skill"，而是按 per-server `links` 矩阵筛选，避免 server A 拉回的远端独有 skill 污染 server B 的远端
4. 计算本地 hash（仅 pushSet 内的 skill）
5. 拉取远程 manifest
6. 对比 → delta（注：`compareManifests` 对不在远程 manifest 中的 skill **无论本地 hash 是否变化**都标记为 `"new"`，确保新增到 `links` 的 skill 一定会被 push）
7. 检测冲突（同 §3.7 三方比较）
8. **Reconcile remote skill set**：一次性 SSH `ls` 远端 `~/.syncskill/skills/` 得到实际存在的 skill 列表：
   - **8a (always — cleanup)**：远端 `skills/` 中存在但不在 pushSet 中的 skill → 列入 plan 待删除项
   - **8b (`--no-refresh` only — safety net)**：delta 标 "skip" 但远端缺失的 skill → 强制改为 "push"。正常流程下 `refreshRemoteManifest()` 已经从 manifest 删除消失的远端 skill（§3.12），8b 仅在 `--no-refresh` 场景下命中
9. 生成 SyncPlan（schema 见 §3.9 SyncPlan）含 `actions` + `unresolved` + `warnings`

**Execute 阶段（写盘，禁止 prompt）**：

10. rsync 把 pushSet 内的 skill 目录推到远端 `~/.syncskill/skills/`
11. **对远程有变更但本地不需要 push 的 skill**：打印 warning `Skipping <skill>: remote has changes. Use syncskill pull to update local.`，**不执行隐式 pull**。push 命令只推送，不拉取
12. **更新本地 manifest**（3-field 模型）：区分实际推送的 skill 和未推送的 skill。实际 pushed 的 skill 设置 `remote_hash=local_hash, recorded_hash=local_hash, status="in-sync"`；未 pushed 的 skill（skip/pull/conflict）保留旧的 `remote_hash` 和 `recorded_hash`
13. 推送本地 receiver 备份到远端 `~/.syncskill/receiver_config.json`（覆盖式 scp，因为本地是真相源）
14. 推送 manifest 到远端
15. SSH exec `sync_receiver.mjs apply`：receiver 按 `receiver_config.json` 的 `links` 矩阵创建 symlink。远端目标位置为非 symlink 真目录时，receiver 跳过并在 stderr 输出 `W_TAKEOVER_NEEDED:` 行（不视为错误；v2.7.4 round-4 议题 3.5 起 prefix 与 controller 警告码对齐，旧 receiver 输出 `protected:` 由 controller `classifySyncError` 同时识别）。接管真目录需通过 `remote takeover` 独立命令（详见 §3.18）

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

**Pull 流程**（step 4 含 sidecar backup 与 conflict 决议消费）：
1. 拉取远程 manifest
2. 对比本地 hash
3. 确定 pull 目标路径（见下方路径解析规则）
4. **对每个待写盘 skill 写盘前**（B1 sidecar backup）：
   - 4a: 若 `<localSkillDir>` 存在 且 未传 `--no-pull-backup`/`config.pull_backup=false`/`SYNCSKILL_PULL_BACKUP=0`：令 `BK = ~/.syncskill/.backups/skills/<skill>/pre-pull/`。先 `rmSync(BK, { recursive: true, force: true })` 清旧 backup，再 `cpSync(<localSkillDir>, BK, { recursive: true, dereference: false })`。父目录 `~/.syncskill/.backups/skills/<skill>/` 不存在时 `mkdirSync({ recursive: true })`
   - 4b: rsync 拉取到目标路径
   - 4c: 若 rsync 失败 → **不删 backup**（保留供 restore）；成功则保留 backup 至下次 pull 才覆盖
   - 适用范围：`action: "pull"`、`action: "init"` with remote_hash、`action: "conflict"` choose `keep-remote`、`action: "delete"` choose `delete`
5. 更新本地 manifest + skills-registry.json
6. **Conflict 决议消费（v2.4 C3）**：`pullFromServer.options.conflictResolutions` 决定 `action: "conflict"` 的 skill 是否入选 `toPull`——仅 `keep-remote` 拉取；`skip`/`keep-local` 不动；未提供决议默认 `skip`。决议由 `sync.ts` / `pull.ts` 从 `SyncDecisionSink.conflicts` 切片后传入
7. **Conflict 可见性（v2.9 Fix-B）**：`pullFromServer` 在 `toPull` 和 `toDelete` 均为空时，检测 delta 中是否有 `action: "conflict"` 的 skill。若有，输出 `N skill(s) skipped (conflict — no recorded baseline). Use --on-conflict=keep-remote to force pull.` 而非误导性的 "No changes to pull"。`--json` 模式下 emit `W_CONFLICT_SKIPPED` warning 事件

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

**通用 flag**（语义见 §3.0.B）：`--plan` / `--apply <path|->` / `--resolutions <path|->`（旧 `--apply-stdin` / `--resolutions-stdin` 降为 alias 一版）

**sync / push / pull 共享 flag**（统一接口）：

| Flag | 适用命令 | 行为 |
|------|---------|------|
| `--cross-server-policy <p>` | sync / `pull --all` | 跨 server 冲突（同一 skill 在多个 server 给出不同 hash）批量策略。取值:`first-wins` / `last-wins` / `abort` / `prompt`（默认）/ **`server:<name>`**（指定该 server 获胜,如 `server:prod`）。`-y` 不暗示 `first-wins`；`-y` 在跨 server 冲突上使用 safe default `abort`（与 §3.0.5 一致，避免误自动选某 server）。push 不暴露此 flag（push 是单向覆盖，远端不会回写到本地）。`server:<name>` 中 `<name>` 不在 `config.servers` → `E_REMOTE_NOT_FOUND` exit 2。**裸 server 名**（如 `--cross-server-policy=prod`）一律 `E_REMOTE_NOT_FOUND` exit 2 |
| `--on-conflict <p>` | push / pull / sync | 单 server 内容冲突批量策略。**统一值域**：`keep-local` / `keep-remote` / `skip` / `abort`。push 下语义映射：`keep-local` = force push（本地覆盖远端）；`keep-remote` = skip（保留远端，不推）；`skip` = skip；`abort` = abort |
| `--on-remote-deletion <p>` | pull / sync | 检测到远端 manifest 已删除但本地仍存在时的策略：`keep-local`（默认，等价"保留本地复制为 manual"）/ `delete` / `prompt`。旧名 `--on-deletion` 保留为 alias |

Pull 写盘前 backup 仍可通过 `config.pull_backup: false` 或 `SYNCSKILL_PULL_BACKUP=0` 关闭（v2.8：`--no-pull-backup` CLI flag 已移除，仅保留 config 字段与环境变量）。

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

**SyncPlan schema**（`--json --plan` 直接打印 result.summary.data）：

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
      "default_under_y": "abort",
      "if_first_wins": { "server": "prod", "hash": "aaa" },
      "if_last_wins":  { "server": "dev",  "hash": "bbb" }
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
    "diverged": { "choose": "keep-local" }
  },
  "deletion": {
    "removed-on-remote": { "choose": "keep-local" }
  },
  "local_deletion": {
    "deleted-locally": { "choose": "keep-remote" }
  }
}
```

读取规则：未在 resolutions 中列出的条目走对应 `--*-policy` / `--on-*` flag；两者都缺时按各自的 `default_under_y` 处理（cross-server / content 默认 `abort` + exit 7）。

**Cross-server policy 语义**：

| Policy | 行为 |
|--------|------|
| `first-wins` | 按 `Object.keys(config.servers)` 顺序，第一个出现该 skill 的 server 获胜，后续 server 的 pull 跳过 |
| `last-wins` | 顺序最后一个 server 获胜 |
| **`server:<name>`** | 指定该 server 的版本永远获胜（如 `--cross-server-policy=server:prod`）。前缀消除与枚举值的命名空间碰撞——server 即使叫 `abort` / `first-wins` 也能精确指定。`<name>` 不在 `config.servers` → `E_REMOTE_NOT_FOUND` exit 2。**裸 server 名形式已下线**：传 `--cross-server-policy=prod` 而非 `server:prod` 一律报 `E_REMOTE_NOT_FOUND` |
| `abort`（`-y` safe default） | 检测到 cross-server conflict 立即停止 plan，exit 7 |
| `prompt`（默认，仅模式 C） | orchestration 在 buildPlan 之后 executePlan 之前一次性弹出 prompt（详见 §3.0.B.4 模式分层） |

注：`-y` 的 safe default 是 `abort` 而非 `first-wins`，与 §3.0.5"`-y` 不暗示 `--cross-server-policy=first-wins`"原则一致。用户若想自动让某个 server 获胜，请显式 `--cross-server-policy=server:<name>` / `first-wins` / `last-wins`。

**Advanced/低频场景标注**：cross-server 冲突仅在多 server 同时被 pull 且同一 skill 在不同 server 给出不同 hash 时触发,属于多 server best-effort 编排的高级场景。日常单 server 工作流(`push <s>` / `pull <s>` / `sync <s>`)无需关心此 flag,默认 `prompt` / `-y` 下 `abort` 已是安全行为。AI agent 在常规 sync 流程中不必主动指定此 flag——只在 plan 的 `unresolved[].kind === "cross-server-conflict"` 出现时再读它。

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

**scp SFTP 兼容（v2.9）**：OpenSSH 9.0+ 将 scp 默认协议从 legacy 改为 SFTP。SFTP 模式不经过远端 shell，`$HOME` 环境变量不被展开。所有 scp 调用使用 `buildScpRemotePath()` 将 `\$HOME/` 转为 `~/`——`~` 由 scp 协议层原生展开，所有模式通用。`ssh` / `rsync` 路径不受影响（它们通过远端 shell 展开 `$HOME`）。

**Symlink 传输规则**：
- **rsync 路径**：`rsync -avz` 中 `-a` 包含 `-l`（保持 symlink 原样传输），skill 目录内部的 symlink 会被保持为 symlink
- **scp fallback push**：使用 `readlink` 读取 symlink target，通过 JSON 格式 `{files: {...}, symlinks: {...}}` 传递给 receiver，receiver 使用 `symlink()` 重建
- **scp fallback pull**：receiver 导出 `{files, symlinks}` 格式，本地使用 `symlink()` 重建
- **Skill 目录本身是 symlink**：调用方传入已解析的实际路径，rsync/scp 传输的是实际内容
- **安全验证**：创建 symlink 前必须验证 target 不是绝对路径且不会逃逸出 skill 目录（防止路径穿越攻击）

### 3.11 `conflict.ts` — 冲突检测与解决

> **v2.4 优先级修订（C4）**：plan-then-execute 决议优先于 `config.conflict_resolution` 全局策略。
>
> 完整优先级链（高 → 低）：
> 1. `--resolutions` 文件中的 `content.<skill:server>.choose`（per-skill, per-server）
> 2. `--on-conflict` flag（per-command runtime override）
> 3. `-y` safe default = `skip`（plan unresolved 的 `default_under_y`）
> 4. **`config.conflict_resolution`（全局兜底，保留向后兼容）**
> 5. 硬编码 `manual`
>
> push 与 pull / sync 共享同一条链。`pushToServer` / `pullFromServer` 都接受 `conflictResolutions` 参数，未提供时才回落到 `config.conflict_resolution`。

**3-field 模型的三路比较**：
- `local_hash` vs `recorded_hash` → 本地是否相对基准有变更
- `remote_hash` vs `recorded_hash` → 远程是否相对基准有变更

冲突发生条件：两边都相对基准有变更（`local_hash ≠ recorded_hash` 且 `remote_hash ≠ recorded_hash`），且变更内容不同（`local_hash ≠ remote_hash`）。

策略（`config.conflict_resolution` 字段——优先级链最末档）：
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
    syncRemoteHashesIntoLocal() → 下载远端 manifest，回写 remote_hash 到本地 manifest
  try-catch：刷新失败只打印 WARNING，不阻断主流程
```

**远端 hash 回写（v2.9 Fix-A）**：`refreshRemoteManifest()` 在远端重新计算 hash 并写入远端 `manifest.json`，但此前本地 manifest 的 `remote_hash` 字段从不更新——只有成功的 push/pull 才会写入。这导致 manifest 重置后（config 保护 L1 触发、手动删除等），所有 skill 的 `remote_hash` 永远是 null，`classifySkillDelta` 对 local≠remote 的 skill 归类为 `conflict`（规则 6），pull 默认不处理 conflict → 静默跳过 → "No changes to pull"。

修复：`autoRefreshManifests()` 在 `refreshRemoteManifest()` 成功后，用 `fetchRemoteManifest()` 下载远端 manifest，将其中的 hash 值回写到本地 manifest 的 `remote_hash` 字段。这使 `classifySkillDelta` 能得到准确的远端状态，dashboard/status 显示正确，plan 阶段也能产出正确的 pull/push action。

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

**Manifest 损坏的修复入口**：`refresh <server>` 是处理 `W_MANIFEST_CORRUPT` 的标准修复入口。`loadManifest` 检测到 JSON 损坏 → rename 到 `.bak` → 返回 null（§3.7 Manifest 健壮性）；`refreshLocalManifest()` 用当前文件 hash 重建本地 manifest，`refreshRemoteManifest()` 用 SSH 从远端拉重建远端字段。重建后 `recorded_hash` 重置为 null（baseline 丢失），下次 sync 若与远端差异会进入 §3.7 case 6 conflict 路径——但 sidecar backup 兜底数据安全。`doctor` 也会主动检查"config 中有 server 但 `manifests/<server>.json` 缺失"，提示用户跑 `refresh`。

### 3.13 `receiver/sync_receiver.mjs` — 远程接收脚本

纯 ESM Node 18+ 脚本（controller 仍要求 Node 20+），零外部依赖：
- `apply` 命令：遍历 `~/.syncskill/skills/` 下 skill
- 根据 `receiver_config.json` 中的 remote_agents 映射创建软链接
- 更新 `manifest.json`
- `export-symlinks <dir>` 命令：导出目录中的 symlink 为 JSON（供 scp fallback pull 使用）

**hash 一致性要求**：receiver 内部的 `computeHash()` 必须使用 `lstatSync`（而非 `statSync`）来检测文件类型，与本地 `computeHash()`（§3.7）及 `refreshRemoteManifest()`（§3.12）保持一致。使用 `statSync` 会导致 `isSymbolicLink()` 永远返回 false，将 symlink 文件内容错误地纳入 hash 计算。

**Node 版本运行时 guard**：receiver 文件顶部（紧随 import 之后、任何业务逻辑之前）检测 `process.versions.node`。若 major 版本 `< 18`，输出 `E_RECEIVER_NODE_TOO_OLD: ...` 到 stderr 并以 `exit 8` 失败（错误码见 §11.4）。

**为什么 Node 18 是硬下限**：

- **唯一的 post-Node-16 依赖**是 `fs.cpSync(..., { recursive: true })`（Node 16.7.0 引入），用于 symlink 失败的 fallback 拷贝（`sync_receiver.mjs:183`）。其余 fs / path / crypto / os API 与 `node:` 协议 import 全部在 Node 14 时代就稳定可用。
- **技术下限是 16.7**，但 2026 年 5 月仍然在 spec 里推荐 Node 16（EOL 自 2023-09）不负责任。Node 18 在 Ubuntu 22.04 / Debian 12 / RHEL 9 默认模块中均开箱可用，覆盖现实部署，是当前合理的"宽松边界"。
- **失败一旦发生越早越好**，便于调用方（push/pull/refresh）准确归因，而不是在执行中段抛出含糊的 `ReferenceError`。Hint 文案推荐 `nvm install 22`（当前 LTS）作为升级路径。
- **Controller 与 receiver 解耦**：controller 的 `package.json` engines 仍要求 Node 20+（受 commander / @inquirer/prompts 等依赖约束），但 controller 可以推送到 Node 18 的远端 receiver。两套版本要求独立维护。

**Receiver 部署模型（无独立版本）**：receiver 没有独立的版本号或发布流程。每次 `push` / `sync` / `refresh <server>` 执行时，controller 端比较本地打包的 `sync_receiver.mjs` MD5 与远端已部署文件的 MD5；不一致则自动重新 scp 部署。这意味着 receiver 版本**始终等于当前 controller 的打包版本**——用户升级 npm 包后下一次 push 就会自动升级远端 receiver，无需手动操作。唯一会出现版本不一致的窗口是"升级包后尚未 push"的短暂时期，此时远端 receiver 是旧版但 push 会自动更新它。

**远端 `receiver_config.json` schema（schema version 1）**：

push 时通过 scp 把本地备份 `~/.syncskill/receivers/<server>.json`（§3.3）原样推到远端 `~/.syncskill/receiver_config.json`。本地备份是真相源，远端只是镜像。

```json
{
  "version": 1,
  "remote_agents": {
    "claude": "~/.claude/skills",
    "cursor": "~/.cursor/skills"
  },
  "links": {
    "skill-a": ["claude", "cursor"],
    "skill-b": ["claude"],
    "skill-c": []
  }
}
```

- `version`：schema 版本，当前为 `1`。旧版（无 `version` 字段、无 `links` 字段）由 receiver 兼容读取并视为 "links = 所有 SKILLS_DIR 下 skill × 所有 remote_agents"，首次 push 后被新 schema 覆盖。
- `remote_agents`：agent 名 → 远端 skill 目录路径映射。
- `links`：per-server skill × agent 矩阵。`links[skill]` 数组中的 agent 才会被 receiver 创建 symlink；空数组 `[]` = 不主动 link 但保留本地备份记录（详见 §3.3 远端 receiver 本地备份）。

**receiver `apply` 命令面**：

```text
node sync_receiver.mjs apply
```

遍历 `links` 矩阵，对每个 `<skill, agent>` 对：
- 目标位置不存在 → 创建 symlink
- 目标位置是 symlink → 删除旧 symlink 重建（确保指向当前 SKILLS_DIR/skill）
- 目标位置是**非 symlink 实体**（真目录、文件、第三方 symlink target 在 SKILLS_DIR 外）→ **不动**，stderr 输出一行 `W_TAKEOVER_NEEDED: <agent>/<skill> is not a syncskill-managed symlink; use \`remote takeover\` to replace`（不视为错误，不影响其他 skill 的 apply；prefix 与 controller 警告码对齐，旧 receiver 输出 `protected:` 由 controller 兼容识别）

**stale cleanup**：清理 agent 目录中"指向 SKILLS_DIR 但 skill 已不在 `links` 矩阵"的 stale symlink（不清理非 syncskill 管理的 symlink，也不清理真目录）。

注：旧版 receiver 的 `--takeover=skill1,skill2,...` 参数已移除。接管远端真目录现由独立命令 `remote takeover`（§3.18）通过直接 SSH 操作完成，不再通过 receiver 中转。

**`apply` 输出契约**：

receiver 的 stdout / stderr 是给人看的诊断信息，push 端**不解析**这些输出：

- **stdout**: 每个 link 一行 `Linked <skill> -> <agent>` 或 `Copied <skill> -> <agent> (fallback)`；stale 清理写 `Removed stale link <name> from <agent>`；结束写 `Receiver apply complete.`
- **stderr**: 每个被严格保护的项一行 `W_TAKEOVER_NEEDED: <agent>/<skill> is not a syncskill-managed symlink; use \`remote takeover\` to replace`（非致命，apply 继续处理其他项；prefix 与 controller 警告码对齐，旧 receiver 仍输出 `protected:` 由 controller 兼容识别）
- **exit code**: `0` = OK；`1` = receiver_config.json 不存在；`8` = Node version guard（`E_RECEIVER_NODE_TOO_OLD`）

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

### 3.17 `restore.ts` — Pull backup 回滚命令（v2.4 R1）

`restore` 是顶级命令，用于把最近一次 pull / sync 覆盖的本地 skill 从 `~/.syncskill/.backups/skills/<skill>/pre-pull/` 回滚回来。配合 §3.9 B1 backup 形成"备份 → 回滚"完整闭环。

**为什么 pre-restore 没有 legacy fallback**：pre-restore 快照（步骤 3）由 restore 自身写入；pull-side backup（步骤 4 的 `BK`）也已统一切到新路径，因此 `backup-paths.ts` 不需要 `legacyXxxPath` helper。

**命令面**：

```bash
syncskill restore <skill>                  # 默认：所有 server 的 manifest 都标记 conflict
syncskill restore <skill> --server <s>     # 只更新指定 server 的 manifest
syncskill restore <skill> --all-servers    # 显式表达默认语义
```

**Plan/execute 分类 与 flag**：

- 单阶段命令（§3.0.B.3，`plan_schema === null`）：单 skill 作用域、操作成本低，仅提供 `--dry-run` + `--json`，不提供 `--plan` / `--apply` / `--resolutions`
- 通用 flag 见 §3.0（`-y` / `--no-interactive` / `--json` / `--quiet`）
- **`--server` 与 `--all-servers` 互斥**：同时给出两者时报 `E_USAGE` + exit 2（hint: "Cannot specify both --server and --all-servers"）。Commander 通过 `.conflicts('server', 'allServers')` 实现。

**执行流程**：

```
1. 通过 resolveSkillPullTarget(skill, config.sources) 定位 <skill_path>
   ├─ 找不到 skill → E_SKILL_NOT_FOUND, exit 2

2. 检查 backup 是否存在：
   ├─ 路径: `~/.syncskill/.backups/skills/<skill>/pre-pull/`
   └─ 不存在 → E_BACKUP_NOT_FOUND, exit 3
       hint: "No backup found for <skill>. Backups are created only when --no-pull-backup
              is not set and config.pull_backup is true (default)."

3. 安全兜底备份（防 restore 本身误操作）：
   ├─ 令 PR = `~/.syncskill/.backups/skills/<skill>/pre-restore/`
   ├─ 父目录不存在 → mkdirSync({ recursive: true })
   └─ cpSync(<skill_path>, PR, { recursive: true, dereference: false })
       已存在则先 rmSync 覆盖

4. 回滚（BK = 步骤 2 命中的 backup 路径）：
   ├─ rmSync(<skill_path>, { recursive: true, force: true })
   ├─ cpSync(BK, <skill_path>, { recursive: true, dereference: false })
   └─ rmSync(BK, { recursive: true, force: true })
       清掉原 backup（restore 已用掉它）；保留 pre-restore/ 让用户必要时再回滚

5. Manifest 状态更新（按 --server / --all-servers）：
   ├─ 范围内每个 server 的 manifest:
   │   ├─ 该 skill 条目存在 → status: "conflict", direction: "conflict"
   │   ├─ 该 skill 条目不存在（被 pull 后才出现的 manual skill 等） → 跳过该 server，info 提示
   │   └─ 保留 local_hash / remote_hash / recorded_hash 原值（不重算；让 resolve 决定后续走哪个 hash）
   └─ 提示用户：`Run \`syncskill resolve <skill>\` to choose final direction.`

6. 失败回滚：step 3 之后任何 step 失败 → E_RESTORE_FAILED, exit 1
   hint: "Manual recovery: restore from ~/.syncskill/.backups/skills/<skill>/pre-restore/ if it exists."
```

**为什么 manifest 默认标 conflict**：restore 把本地内容换回了 pre-pull 状态，但**远端仍是 pull 时拉下来的内容**——本地与远端确实分歧。如果默认把 status 写成 `local-changed` / `remote-changed`，下一次 sync 会自动选边，可能再次产生数据丢失（绕了一圈又回到原点）。强制 `conflict` 让用户必须显式 `resolve` 选边，符合 §3.0.5 "破坏性操作必须显式 opt-in" 原则。

**多 server 语义**：sidecar backup 是本地 skill 目录的快照，**与 server 无关**（pull 时 rsync 已经覆盖了"上一次同步给某 server 的本地状态"，备份保留的是 pull 前的全局本地状态）。因此默认 `--all-servers` 是正确的语义——所有 server 的同步状态都因这次 restore 进入不确定态。`--server <s>` 是用户**明确知道只有一个 server 跟这次 pull 相关**时的精细化选项。

**dry-run 行为**：text 模式打印 `[dry-run] Would restore <skill> from <backup_path>; would mark conflict in: <server list>`；JSON 模式输出与 result schema 同形的预览（详见 §11.6.17）。

**输出示例**：

```bash
$ syncskill restore my-skill
✓ Restored my-skill from ~/.syncskill/.backups/skills/my-skill/pre-pull/
✓ Pre-restore backup saved at ~/.syncskill/.backups/skills/my-skill/pre-restore/
✓ Marked conflict in manifests: prod, dev

Run `syncskill resolve my-skill` to choose final direction.
```

```bash
$ syncskill restore missing-skill
Error: No backup found for missing-skill (E_BACKUP_NOT_FOUND)
  hint: Backups are created only when --no-pull-backup is not set and config.pull_backup is true (default).
```

### 3.18 `remote takeover` — 远端真目录接管命令

`remote takeover` 是独立的破坏性命令，用于显式接管远端 agent 目录中的非 symlink 真目录（用户手动放置或第三方工具创建的 skill 目录），将其替换为 syncskill 管理的 symlink。

**命令面**：

```bash
syncskill remote takeover <server> <skill> [--agent <agent>]
```

**参数**：

| 参数 | 说明 |
|------|------|
| `<server>` | 目标 server 名称 |
| `<skill>` | 待接管的 skill 名称 |
| `--agent <agent>` | 可选：只接管指定 agent 下的真目录。省略时接管该 skill 在 `links[skill]` 中所有 agent 下的真目录 |

**前置条件**：

- `receivers/<server>.json` 备份必须存在（否则 `E_REMOTE_NOT_INITIALIZED` exit 3，hint: `Run \`syncskill refresh <server>\` first`）
- `links[skill]` 非空（否则 `E_USAGE` exit 2，hint: `Run \`syncskill remote link add <server> <skill> <agent>\` first`）
- 远端 `$HOME/.syncskill/skills/<skill>` 必须存在（即该 skill 已 push 到远端）。takeover 前用一次只读 SSH `test -e` 探测；不存在则 `E_USAGE` exit 2，hint: `Push it first: \`syncskill push <server>\``。否则接管会创建指向不存在目标的 dangling symlink

**SSH 引号约定**：takeover 直接拼 SSH 命令（不经 receiver），远端路径必须让**远端 shell**展开 `~` / `$HOME`。`sshExec` 把命令包在外层双引号里，因此路径统一经 `remoteArg()` 转成 `\"$HOME/...\"`（`~/` 前缀改写为 `$HOME/`，`$` 转义后穿过本地双引号在远端展开，外层远端双引号容忍空格）。**禁止单引号包裹** `~` / `$HOME`——单引号会阻止远端展开，产生 dangling/错误 symlink。

**执行流程**：

```
1. 确定目标 agents：
   ├─ --agent 指定 → 仅该 agent
   └─ 省略 → links[skill] 中所有 agent

2. 对每个目标 agent，SSH lstat 远端 <remote_agents[agent]>/<skill>：
   ├─ 不存在 → skip（info: "not present, nothing to takeover"）
   ├─ 已是 symlink → skip（info: "already managed by syncskill"）
   └─ 非 symlink 实体 → 标记为待接管

3. Execute（v2.7.4 round-4 议题 2.1 BREAKING：交互模式下显式调用 `remote takeover`
   即表达接管意图，无二次确认；**非交互模式下** `-y` / `--no-interactive` / `--json`
   **必须显式 `--yes-destructive`**，否则 abort `E_USAGE` exit 2 + hint；
   `--dry-run` 只列出待删除目录不执行）：
   ├─ SSH exec: rm -rf <remote_agents[agent]>/<skill>
   ├─ SSH exec: ln -s <SKILLS_DIR>/<skill> <remote_agents[agent]>/<skill>
   └─ 失败 → E_TAKEOVER_FAILED exit 5

4. 输出 result
```

**与 push 的关系**：

- Push 遇到远端非 symlink 真目录时**自动 skip + warning** `W_TAKEOVER_NEEDED`（不阻断其他 skill 的 push）
- 用户看到 warning 后显式调用 `remote takeover` 接管
- 下次 push 时该位置已是 symlink，正常 link 不再触发 warning

**AI agent 标准流程**：

```bash
# Push 发现需要 takeover
syncskill --json push prod
# → warning: W_TAKEOVER_NEEDED skill=foo agent=claude

# 显式接管
syncskill --json -y remote takeover prod foo

# 再次 push（此时 foo 已被管理）
syncskill --json push prod
```

**`--dry-run` 行为**：SSH lstat 探测远端状态，输出"将要删除的目录列表"，不执行删除。

**`--json` result schema**：

```json
{
  "server": "prod",
  "skill": "foo",
  "takeovers": [
    { "agent": "claude", "path": "~/.claude/skills/foo", "action": "takeover", "remote_type": "directory" }
  ],
  "skipped": [
    { "agent": "cursor", "path": "~/.cursor/skills/foo", "reason": "already symlink" }
  ]
}
```

**错误码**：

| Code | 触发条件 | exit |
|------|---------|------|
| `E_REMOTE_NOT_INITIALIZED` | receivers backup 不存在 | 3 |
| `E_TAKEOVER_FAILED` | SSH rm/ln 执行失败 | 5 |
| `W_TAKEOVER_NEEDED` | push 时检测到需 takeover 但跳过 | — |

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
    "build": "tsc && shx cp -r skills dist/ && shx rm -rf dist/receiver && shx cp -r src/receiver dist/receiver && shx chmod +x dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run --project unit --project integration",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "vitest run --project e2e",
    "test:all": "vitest run",
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
function diagnoseConfig(config: SyncSkillConfig, skillsDir: string, homeDir: string): Promise<DiagnosticReport>;
function repairConfig(config: SyncSkillConfig, report: DiagnosticReport, options: RepairOptions): SyncSkillConfig;
function formatDiagnosticReport(report: DiagnosticReport): string;
function formatDiagnosticSummary(report: DiagnosticReport): string;
```

### 10.3 诊断码

| Code | Severity | 触发条件 | 修复动作 |
|------|----------|---------|---------|
| `E_NO_VALID_AGENTS` | error | `agents` 中所有路径都不存在 | 阻断，提示运行 `doctor --fix` |
| `W_AGENT_PATH_INVALID` | warning | 单个 agent 路径不存在 | 从 `agents` 中移除 |
| `W_SKILL_NOT_FOUND` | warning | `links` 中引用的 skill 不在 `~/.syncskill/skills/` 顶层 managed local skill 集合，也不在 active source-derived skill 集合中；其中 source-derived 集合按 leaf-skill 规则发现，并过滤 `config.sources[*].ignore[]` | 从 `links` 中移除该 skill |
| `W_AGENT_NOT_CONFIGURED` | warning | `links[skill]` 中引用的 agent 不在 `agents` 中 | 从该 skill 的 targets 中移除该 agent |
| `W_SOURCE_PATH_INVALID` | warning | `sources` 中 local 类型的 `path` 不存在 | 从 `sources` 中移除 |
| `W_REGISTRY_CORRUPT` | warning | `skills-registry.json` 解析失败或 schema 不合法 | 备份损坏文件后重建 `http_baselines` 字段（ignore 状态由 `config.sources[].ignore[]` 持有）。若 `--fix` 模式下重建仍失败 → 升级为 `E_REGISTRY_CORRUPT` exit 3 |

**code 命名规则**：`E_*` = 阻断错误（伴随非 0 exit），`W_*` = 非阻断警告（exit 0）。本节诊断码与 §11.4 的错误码注册表一致 — 同一 logical 问题在 doctor 模式与运行时模式应使用相同的 code 字符串。

**检查顺序**：
1. 检查 `agents` 路径有效性（决定是否 error）
2. 检查 `links` 引用完整性
3. 检查 `sources` 路径有效性
4. 检查 `skills-registry.json` 完整性（见下方）

**注意**：`links[skill]` 的 targets 数组为空是合理情况（临时禁用），不触发诊断。

**skills-registry.json 诊断**：

v2 schema 下 registry 只存 `http_baselines`（ignore 状态由 `config.sources[].ignore[]` 持有）。诊断流程：

1. 文件不存在 → 静默创建空 registry（非错误）
2. JSON 解析失败 / schema 不合法 → `REGISTRY_CORRUPT`，`--fix` 时备份为 `skills-registry.json.bak` 然后重建空 registry
3. v1 schema → 自动迁移到 v2（只从 v1 的 `last_update_hash` 字段提取 http baseline；v1 的 ignore 条目丢弃，不再迁移），不报错

重建逻辑（v2）：扫描 `config.sources` 中所有 HTTP source 的 skill，计算当前 hash 作为新 baseline。

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
{"type":"result","command":"push","ok":true,"data_schema_version":1,"summary":{"pushed":1,"skipped":0,"conflicts":0,"warnings":1}}
```

`result` 事件的 `summary.data` 字段对应每个命令的领域数据（如 `status` 命令返回 per-skill 状态数组），具体 schema 见各命令章节。

`change.op` 取值固定枚举：`add | modify | delete | link | unlink | push | pull | resolve | restore | stash | backup`。`change.entity` 取值固定枚举：`skill | source | agent | server | link | manifest | registry`。

### 11.3 退出码（exit codes）

文档化的退出码，调用方可以**只看 exit code 决策**而不解析输出：

| Exit code | 含义 | 例子 |
|-----------|------|------|
| `0` | 成功 | 命令完成，无错误（多 target 命令至少 1 个成功也算 0） |
| `1` | 通用错误（运行时未分类） | 内部 panic / 未捕获异常 |
| `2` | 用法错误 | 未知参数、缺少必填位置参数、`E_PLAN_COMMAND_MISMATCH`、`E_CONFIG_FORMAT_UNSUPPORTED` |
| `3` | 配置错误 | doctor 检测到 `error`-级问题且无 `--fix`、`E_CONFIG_NOT_FOUND` |
| `4` | 需要输入但无法获取 | `--no-interactive` 模式下遇到 prompt |
| `5` | 网络/远端错误 | SSH / rsync 失败、超时 |
| `6` | Dirty / 安全保护跳过 | 单 target 命中 skip；多 target **全部** skip；多 target partial skip 默认 exit 0，**`--strict` 下升级到 exit 6** |
| `7` | 冲突未解决 | `resolve` 未提供决议、sync 计划中存在未决冲突 |
| `8` | 远端不一致 | receiver 部署失败、远端 manifest 损坏 |

**`-y/--yes` 与 exit code**：`-y` 让 prompt 默认前进，不会触发 `4`。`--no-interactive` 不暗示 `-y`：遇到 prompt 直接 `4`，由调用方决定是否重跑加 `-y`。

**`--strict` 与 exit code 6**：多 target 命令（`update --all` / `sync --all` / `push --all` / `pull --all`）默认走"宽容模式"——只要至少 1 个 target 成功就 exit 0，被 skip 的 target 反映在 `data.skipped[]` 中。`--strict` / `SYNCSKILL_STRICT=1` 让任何 skip 都升级为 exit 6（CI / 严格 AI agent 场景使用）。单 target 命令 / 多 target **全部** skip 时不受 `--strict` 影响（已经是 exit 6）。

**典型场景**：

| 命令 | skip 数 / 总数 | 默认 exit | `--strict` exit |
|------|---------------|----------|----------------|
| `update --all` | 0 / 5 | 0 | 0 |
| `update --all` | 2 / 5 | **0** | **6** |
| `update --all` | 5 / 5 | 6 | 6 |
| `update my-source` | 1 / 1 | 6 | 6 |
| `sync --all` | partial skip | 0 | 6 |

**AI agent 解读建议**：exit code 仅作粗筛——精确判断"哪个 target 被 skip / 失败 / 成功"必须读 `result.data.skipped[]` / `data.servers[]` / `data.failed[]`(各命令 schema 见 §11.6)。多 target partial skip 默认 exit 0 是"宽容模式"(至少一个成功);若 agent 需要"全成功才继续"的语义,要么加 `--strict`/`SYNCSKILL_STRICT=1` 让 exit code 反映,要么解析 `data.skipped.length === 0` 自行判定。不要靠 `exit === 0` 推断"全部成功"。

### 11.4 错误码（error codes）

每条 `error` / `warning` 事件都带 `code` 字段（`E_*` 前缀的稳定字符串），调用方可以基于 code 路由处理逻辑而不依赖 `message` 文本。code 一旦发布即视为 API 表面，**不破坏性变更**。

核心错误码（非穷举，命令章节可定义子集）：

| Code | Severity | 含义 | exit code |
|------|----------|------|-----------|
| `E_USAGE` | error | 参数错误 | 2 |
| `E_PLAN_COMMAND_MISMATCH` | error | `--apply` 显式命令名与 plan.command 不一致 | 2 |
| `E_CONFIG_FORMAT_UNSUPPORTED` | error | `--config` 传入非 `.json` 扩展名 | 2 |
| `E_AGENT_NOT_CONFIGURED` | error | 引用了未配置的 agent | 2 |
| `E_SKILL_NOT_FOUND` | error | skill 不存在 | 2 |
| `E_SOURCE_NOT_FOUND` | error | source 不存在 | 2 |
| `E_REMOTE_NOT_FOUND` | error | remote (`config.servers[<name>]`) 不存在 (v2.7.4 PR 5b：由 `E_SERVER_NOT_FOUND` rename 而来，与 `server → remote` CLI 命令族 rename 同步；config 字段名 `servers:` 不变) | 2 |
| `E_CONFIG_NOT_FOUND` | error | `~/.syncskill/config.json` 与 `config.yaml` 均不存在 | 3 |
| `E_NEEDS_INPUT` | error | `--no-interactive` 下需要输入 | 4 |
| `E_NO_VALID_AGENTS` | error | doctor: 所有 agent 路径都失效 | 3 |
| `E_REGISTRY_CORRUPT` | error | doctor: `--fix` 模式下重建仍失败 | 3 |
| `E_NETWORK` | error | 网络/SSH 失败 | 5 |
| `E_TIMEOUT` | error | 操作超时 | 5 |
| `E_RECEIVER_SCAN_FAILED` | error | scan-based auto-synthesize 触发的 SSH `scan-agents` 失败（网络断、receiver 未部署、远端 Node 太旧等）；不软回退，由用户跑 `refresh <server>` 或修 SSH 后重试 | 5 |
| `E_UNRESOLVED` | error | plan 中存在 unresolved 但 `--no-interactive` 或非 TTY 无 `--resolutions`（v2.7.2 P6：合并自旧 `E_CONFLICT`——后者从未单独 emit） | 7 |
| `E_TAKEOVER_FAILED` | error | `remote takeover` 执行 SSH rm/ln 失败 | 5 |
| `E_RECEIVER_DEPLOY` | error | receiver 部署失败 | 8 |
| `E_RECEIVER_NODE_TOO_OLD` | error | 远端 Node 版本低于 18（receiver 运行时 guard；理由见 §3.13） | 8 |
| `W_AGENT_PATH_INVALID` | warning | doctor warning（agent 路径不存在） | — |
| `W_AGENT_NOT_CONFIGURED` | warning | doctor warning（links 引用未配置的 agent） | — |
| `W_SKILL_NOT_FOUND` | warning | doctor warning（links 引用不存在的 skill） | — |
| `W_SOURCE_PATH_INVALID` | warning | doctor warning（local source 路径不存在） | — |
| `W_REGISTRY_CORRUPT` | warning | doctor warning（registry 损坏，会自动备份重建） | — |
| `W_SOURCE_DIRTY` | warning | update 跳过 dirty source（无 `--force` 时） | — |
| `W_INSTALL_SELF_AMBIGUOUS` | warning | `install self` 执行时 cwd 含 `./self/` 目录 | — |
| `W_TAKEOVER_NEEDED` | warning | push 检测到远端 agent 目录中存在非 symlink 真目录，已 skip；hint 指向 `remote takeover <server> <skill>`（§3.18） | — |
| `E_BACKUP_NOT_FOUND` | error | `restore <skill>` 找不到 backup(路径 `~/.syncskill/.backups/skills/<skill>/pre-pull/`) | 3 |
| `E_RESTORE_FAILED` | error | `restore <skill>` 执行步骤失败（cp/rm/manifest 写入异常）；hint 提示 `~/.syncskill/.backups/skills/<skill>/pre-restore/` 仍可手工恢复 | 1 |
| `W_CONFIG_RESET` | warning | `init` 时 config.json 验证失败，已备份并重建（v2.9 L1）；`--json` 模式 emit 结构化 warning | — |
| `W_CONFLICT_SKIPPED` | warning | pull 跳过 conflict skills（无 recorded baseline）；提示 `--on-conflict=keep-remote`（v2.9 Fix-B）；`--json` 模式 emit | — |
| `W_MANIFEST_CORRUPT` | warning | `loadManifest` 检测到 JSON 损坏，已 rename 到 `.bak` 并返回 null；建议跑 `refresh <server>` 重建 | — |
| `W_MANIFEST_MISSING` | warning | `doctor` 检测到 `config.servers` 中有 server X 但 `manifests/X.json` 缺失；建议跑 `refresh <server>` 重建 baseline，避免下次 sync 走 first-time + 远端差异的 conflict-overwrite 路径 | — |
| `E_INSTALL` | error | **v2.7.2 (Plan P)** 起注册的 install / link / update 兜底码（以下至 `W_TAKEOVER_PREFLIGHT_FAILED` 同源）：install 命令通用失败兜底（具体子错误由 classifySyncError 或更细 code 优先路由） | 1 |
| `E_LINK_FAILED` | error | link build 时 symlink fs 操作失败（createLink / removeLink）；与 `E_NETWORK` 区分（本地 fs 而非 SSH） | 1 |
| `E_ABORT` | error | update 决议对 dirty source 选择 `abort`（用户主动停止） | 1 |
| `W_SOURCE_UNREACHABLE` | warning | install plan 阶段 source 探测失败。`reason` 取值：`git`（`git ls-remote` 失败）/ `http`（HTTP HEAD 失败）。合并自旧 `W_GIT_UNREACHABLE` + `W_HTTP_UNREACHABLE`（v2.8） | — |
| `W_UPDATE_SKIPPED` | warning | update plan：source 被跳过。`reason` 取值：`no-sources`（无 source）/ `no-updatable`（无可更新 source）/ `not-updatable`（指定 source 不可更新）。合并自旧 `W_NO_SOURCES` + `W_NO_UPDATABLE` + `W_NOT_UPDATABLE`（v2.8） | — |
| `W_REFRESH` | warning | refresh 子步骤失败（本地 hash 重算或远端 manifest 获取），主流程继续 | — |
| `W_SERVER_NOT_FOUND` | warning | sync/pull/push plan：`--all` 枚举出的 server 名未在 `config.servers` 中 | — |
| `W_SOURCE_NOT_FOUND` | warning | source / update plan：指定 source 名未在 `config.sources` 中 | — |
| `W_UNKNOWN_TYPE` | warning | install plan：source 类型无法推断；传 `--type` 消歧 | — |
| `W_TAKEOVER_PREFLIGHT_FAILED` | warning | takeover preflight SSH scan 失败；execute 阶段兜底重试（spec §3.18） | — |
| `W_NO_BASELINE_RISK` | warning | push/sync plan：远端 manifest 无 baseline（从未 sync 过），提示可能覆盖远端内容 | — |
| `E_REMOTE_NOT_INITIALIZED` | error | `remote takeover` / `remote show` 等需要 receiver backup 但 `receivers/<server>.json` 不存在 | 3 |
| `I_FORCE_PROMPT_HINT` | info | `--force` 下任何 prompt 真正调用 promptConfirm/promptSelect 时,每个 ctx 一次性 info 提示 ``--force` only bypasses dirty protection; use `-y` to auto-confirm prompts``。dirty-related prompt 在 callsite 已被 `if (!force)` 守卫（不会调用 prompt 函数），因此自然不发；详见 §3.0.3 "架构不变量" | — |

**前缀约定**：`E_*` = error 级别（伴随非 0 exit code），`W_*` = warning 级别（exit 0，但事件流里出现），`I_*` = informational（exit 0,不阻断流程,纯纠偏/迁移提示,例:`I_FORCE_PROMPT_HINT`）。同一逻辑问题可能在不同上下文用不同 severity（例：dirty source 默认 `W_SOURCE_DIRTY` warning + skip + exit 6；`--strict` 下仍走同一 `W_SOURCE_DIRTY` warning + exit 6，行为不变只是 exit code 由 skip-aware 升级）。

**已删除的 deprecated flag / command 名**（一律不再接受，不再发警告）：

`init --skip-skill`、`scan --migrate`、`source add`、`source update`、`install --self`、`link --apply`、`link --status`、`link --unlink`、`refresh --all` — 用户传入这些旧 flag/命令直接由 commander 报 `unknown option/command` 后退出码 1（commander 默认行为；不走 syncskill 的 E_USAGE / exit 2 转换层，与 H5 决议保持一致）。

### 11.5 API Stability Tiers

错误码与 result schema 采用分层 API 承诺。Core 拆为两个独立集合：**Core Errors**（ERROR_CODES entry，受 stability 字段 lint 管）+ **Core Meta**（envelope 顶层版本字段，受各自 schema 测试管）。两集合 lint 互不耦合；分两子节描述。

#### 11.5.1 Core Errors（8 条 ERROR_CODES entry，lint 锁死）

| Code | 类型 | 用途 |
|------|------|------|
| `E_USAGE` | exit 2 | flag/argument 错误（agent 退出码分类锚点）|
| `E_NEEDS_INPUT` | exit 4 | 交互契约违反（agent 决定是否提供 `--resolutions`）|
| `E_UNRESOLVED` | exit 7 | plan 含 unresolved 阻塞（agent 路由到 resolve 流程）|
| `E_NETWORK` | exit 5 | 网络/SSH 失败（agent 决定 retry 策略）|
| `E_RECEIVER_NODE_TOO_OLD` | exit 8 | receiver Node < 18（agent 决定升级提示）|
| `W_MANIFEST_MISSING` | warn | baseline 缺失（agent 提示 refresh）|
| `W_TAKEOVER_NEEDED` | warn | 远端文件非 syncskill 管理（agent 路由 takeover）|
| `I_FORCE_PROMPT_HINT` | info | `--force` 下 prompt 命中提示（架构不变量信号）|

**Core Errors 承诺**：

- 不可删除（`tests/error-codes-core-stability.test.ts` 强制断言 `stability === "core"` 的 entry 恰为这 8 条）
- 不可重命名（同 lint）
- 不可重新分配语义（人工 review）
- exitCode 映射不可变更（lint 强制，PR 3 落地）
- severity 桶不可变更（lint 强制，PR 3 落地）
- data 字段只可 additive

#### 11.5.2 Core Meta（3 个 envelope 顶层版本字段）

| Field | 位置 | 用途 |
|-------|------|------|
| `plan.version` | plan envelope | plan schema 版本号（已存在）|
| `manifest.version` | manifest 文件 | manifest schema 版本号（已存在）|
| `data_schema_version` | result envelope | result.data schema 版本号 |

**Core Meta 承诺**：

- 字段必存在（lint 强制：`tests/result-schema-version.test.ts` / 各自 schema 测试断言）
- 当前值在 v2.8 前不变（plan=1 / manifest=2 / data=1）
- 破坏性 schema 变更必 bump version + CHANGELOG 公告

#### 11.5.3 Extended（37 条 ERROR_CODES entry）

剩余所有错误码（= 45 − 8 = 37 条），包括 generic 兜底（`E_INSTALL` / `E_LINK_FAILED` / `E_ABORT` / `E_RESTORE_FAILED`）、特化 W 码（`W_UPDATE_SKIPPED` / `W_SOURCE_UNREACHABLE` / `W_REFRESH` / `W_NO_BASELINE_RISK` / `W_CONFIG_RESET` / `W_CONFLICT_SKIPPED` 等）、特化 E 码（`E_TIMEOUT` / `E_CONFIG_NOT_FOUND` / `E_AGENT_NOT_CONFIGURED` / `E_SKILL_NOT_FOUND` / `E_SOURCE_NOT_FOUND` / `E_REMOTE_NOT_FOUND` / `E_REMOTE_NOT_INITIALIZED` 等）。

**Extended 承诺**：

- 可删除（需 CHANGELOG 明示）
- 可重命名（需 CHANGELOG 明示）—— 如 v2.7.4 round-4 将 `E_SERVER_NOT_FOUND` 同步 rename 为 `E_REMOTE_NOT_FOUND`（PR 5b）
- 可合并到 generic code（需 CHANGELOG 明示）
- 新增 code 默认进 extended

#### 11.5.4 升级 core 的标准（治理规则）

新 code 默认 extended；升级到 **Core Errors** 需满足全部：

1. **路由价值**：至少一种 agent retry / branch 决策需要它独立分类。
2. **公告**：spec §11.5.1 显式列出 + CHANGELOG 写明。
3. **测试锁**：`tests/error-codes-core-stability.test.ts` 加 entry。

新 envelope 版本字段升级 **Core Meta** 需满足：

1. 字段已存在或本轮引入；
2. spec §11.5.2 显式列出；
3. 对应 schema 测试断言字段必存在。

#### 11.5.5 Stability 字段 schema

`src/core/error-codes.ts` 的 `ERROR_CODES` entry 含 `stability: "core" | "extended"` 字段（required）。Core Meta 字段不在 ERROR_CODES 表内，不打 stability 标。

> 参考决议：[`decisions-2026-06-02-spec-cleanup-round4.md`](./decisions-2026-06-02-spec-cleanup-round4.md) §A5 / §议题 1.1 / §议题 3.4。
>
> `--no-interactive` 契约（涉及 `E_NEEDS_INPUT` core entry 的交互语义）见 §11.12。

### 11.6 各命令的 `--json` 输出契约

下列命令在 `--json` 模式下，`result.summary.data` 字段必须返回结构化数据。本节列出所有 mutate 状态命令的完整 schema。

#### 11.6.0 实现要求（强制约定）

- **任何 mutate state 的命令必须返回 `data.changes` 或等价字段**（不能只返回计数）
- **text 渲染从 data 派生**：`renderText(data)`，不允许独立组装人类文本
- **plan/result 可追溯**：每个 plan action(`actions[].id`,§3.0.B.2)在 result 中必须**机械可定位**——result 的每个变更项必带 `plan_ref: "<action.id>"`。result 不要求与 plan **结构同构**(分类输出 `skills.installed`、`updated[]` 等仍允许),但每项都带 `plan_ref` 让 agent 用一次 `Map<plan_ref, result_item>` 即可对账,无需语义猜测。若某 result 项对应多个 plan actions(如一次 link 创建多个 symlink),用 `plan_refs: ["a3", "a4"]`(数组形式)。无对应 plan action 的 result 项(如 execute 阶段自发的 backup 写盘)可省略 `plan_ref`
- **skill 标识字段命名约定**：父键已表明是 skill 集合（如 `skills.installed`、`removed_skills`、`migrated_skills`）时，子项用 `name`；父键是泛化操作集合（如 `changes`、`deltas`、`local_changes`、`affected_servers`）时，子项用 `skill` 显式标识

**data_schema_version 兼容性承诺**

所有 `type: "result"` JSON 事件顶层含 `data_schema_version: 1`（由 `src/core/events.ts` 的 `createJsonEmitter` wrapper 自动注入）。承诺：v2.8 前此值不变；data schema 任何破坏性变更（删字段、改类型、改语义）必 bump 到 2 并在 CHANGELOG 明示。additive（加新字段）不需 bump。

参见 §11.5.2 Core Meta 段。

**Spec-vs-code lint（v2.7.4 round-4 议题 3.1）**：本节及 §11.6.x 各 JSON 示例与代码契约的一致性由 `tests/spec-json-examples.test.ts` 强制：

- 任何 `type: "result"` envelope 示例（无论位于 §11.2 / §11.6.x / 其他段）顶层必含 `"data_schema_version": 1`
- §11.6.x JSON 示例中 `changes[]` 数组里**带 `op` 字段的原子条目**（如 §11.6.15 push/pull/sync 风格）必含 `"plan_ref": "a<N>"`，匹配 `/^a\d+$/`

示例与代码契约漂移会立即被 CI 抓出（人工 review 不再是唯一防线）。

#### 11.6.1 `syncskill` (dashboard)

```json
{ "skills": {...}, "sources": [...], "agents": [...], "servers": [...], "health": {...} }
```

#### 11.6.2 `status`

```json
{ "servers": [{ "server": "prod", "skills": [{ "name": "skill-a", "status": "in-sync", "action": "skip", "local_hash": "aaaa...", "remote_hash": "aaaa...", "baseline_hash": "aaaa..." }] }] }
```

**v2.7.4 round-4 议题 3.2**（A5 §11.5.3 extended tier）：每个 skill 项追加 hash 三元组字段，让 agent 不必二次调 `diff` 即可判断 delta：

| Field | Type | 说明 |
|-------|------|------|
| `local_hash` | `string \| null` | 本地内容 hash（hex）；缺则 null |
| `remote_hash` | `string \| null` | 远端最后已知 hash（取自 manifest entry）；缺则 null |
| `baseline_hash` | `string \| null` | manifest 中记录的同步基准 hash（对应 `recorded_hash`）；缺则 null |

**alias 关系**：`baseline_hash` 是 manifest 内部 `recorded_hash` 字段（`src/config/types.ts` 的 `ManifestSkillEntry.recorded_hash`）的 public alias。同概念在 `diff --json` (§11.6.3) 历史上叫 `recorded_hash`；两条命令同时 emit 两字段（同值）以避免 break，未来 manifest schema bump 时统一为 `baseline_hash`。

语义：

- **in-sync**：三者相等
- **conflict**：三者皆不同
- **no-baseline**（`W_MANIFEST_MISSING`）：三者皆 null

plain-text 输出（无 `--json`）**不含**这些字段（人类优先 C1：text 不需要 hash 噪音）。

#### 11.6.3 `diff <server>`

```json
{
  "server": "prod",
  "deltas": [
    { "skill": "skill-a", "action": "push", "local_hash": "...", "remote_hash": "...", "baseline_hash": "...", "recorded_hash": "..." }
  ]
}
```

**`baseline_hash` 字段（extended）**：本 `diff --json` 与 `status --json` (§11.6.2) 对齐：每个 delta 同时含 `baseline_hash`（公共名，A5 §11.5.3 extended）与 `recorded_hash`（历史名，与 `baseline_hash` 同值）。两字段并存；**下一次 manifest schema bump 时移除 `recorded_hash`**。Agent 新代码应优先用 `baseline_hash`。

#### 11.6.4 `source list`

```json
{ "sources": [SourceConfig 序列化, ...] }
```

#### 11.6.5 `link list`

返回 realized state，而不是配置意图矩阵。覆盖所有 managed local skills × configured agents；状态枚举包含 `linked` / `copied` / `broken` / `missing` / `unconfigured`。

```json
{
  "matrix": [
    {
      "skill": "skill-a",
      "agents": {
        "claude": "linked",
        "cursor": "missing",
        "hermes": "unconfigured"
      }
    }
  ]
}
```

#### 11.6.6 `install` / `install self`

```json
{
  "source": { "name": "my-repo", "type": "git", "url": "...", "path": "..." },
  "skills": {
    "installed": [{ "name": "skill-a", "path": "...", "plan_ref": "a1" }],
    "ignored": [{ "name": "skill-c", "reason": "user-deselected" }],
    "already_installed": ["skill-d"]
  },
  "links_created": [
    { "skill": "skill-a", "agent": "claude", "path": "~/.claude/skills/skill-a", "plan_ref": "a2" }
  ]
}
```

**plan_ref 语义**：

- `skills.installed[].plan_ref` → 对应的 source-install action id（当前实现为 `install-source`；同一 source 装出多个 skill 时，所有 installed[] 项共享同一 plan_ref —— 1:N fan-out）
- `links_created[].plan_ref` → 对应的 `link-skill` action id（同一 plan 内所有 created link 共享该 id）
- `skills.ignored[]` 由用户决议产生（skill-selection unresolved），无 plan action 对应，省略 `plan_ref`
- `skills.already_installed[]` 仅是字符串列表（spec 未指定子项 schema），无 `plan_ref`

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
      },
      "plan_ref": "a1"
    }
  ],
  "skipped": [
    { "name": "company", "reason": "dirty", "dirty_skills": ["skill-a"], "hint": "git -C ... stash && syncskill update company && git -C ... stash pop", "plan_ref": "a2" }
  ],
  "failed": [
    { "name": "broken-remote", "reason": "Git update failed: ...", "plan_ref": "a3" }
  ]
}
```

**plan_ref 语义**：`updated[]` / `skipped[]` / `failed[]` 每项的 `plan_ref` 回指 `update.fetch`（git）或 `update.download`（http）action id（按 `action.skill === item.name` 匹配）。仅在 plan-then-execute 路径（`--apply <plan>`）下生效；直接调用 `update` 不经过 plan builder 时省略此字段。

#### 11.6.8 `source remove <name>`

```json
{
  "name": "my-repo",
  "mode": "completely",
  "deleted_paths": ["~/.syncskill/sources/my-repo"],
  "removed_skills": ["skill-a", "skill-b"],
  "removed_links": [
    { "skill": "skill-a", "agents": ["claude"], "plan_ref": "a1" }
  ]
}
```

**字段语义**：

- `mode`：`"keep-files"`（用户选 "remove-config",仅删 config）或 `"completely"`（用户选 "remove-all"/`--force`,删 config + 文件 + links）
- `deleted_paths[]`：仅 `mode="completely"` 时填入,列出实际成功 `rm -rf` 的路径
- `removed_skills[]`：扁平名字列表（per spec example,无 plan_ref slot）
- `removed_links[]`：结构化条目,每项 **必带** `plan_ref` 回指 `remove.unlink` action id（按 `action.skill === item.skill` 匹配）

#### 11.6.9 `scan` / `scan --migrate-unmanaged`

```json
{
  "new_in_sources": [{ "name": "skill-x", "source": "my-repo", "registered": true }],
  "unmanaged_in_agents": [{ "name": "local-experiment", "path": "~/.claude/skills/..." }],
  "migrated": [{ "name": "local-experiment", "to": "~/.syncskill/skills/..." }]
}
```

#### 11.6.10 `link set/add/remove/clear/build`

```json
{
  "changes": [
    {
      "skill": "my-skill",
      "config_before": ["claude"],
      "config_after": ["claude", "cursor"],
      "symlinks_created": [{ "agent": "cursor", "path": "...", "plan_ref": "a1" }],
      "symlinks_removed": []
    }
  ]
}
```

**plan_ref 语义**（`link build` only — set/add/remove/clear 不构建 plan）：

- `symlinks_created[].plan_ref` → 对应的 `create-symlink` action id（按 `(action.skill, action.agent)` 匹配）
- `symlinks_removed[].plan_ref` → 对应的 `remove-symlink` action id（同样的 (skill, agent) 匹配）
- `link build` 是单阶段命令（spec §3.0.B.3，`plan_schema === null`）—— 用户不会显式调 `--plan` 然后 `--apply`，plan 在 `runLinkApply` 内部构建仅用于 plan_ref 生成。其他 link 子命令（set/add/remove/clear）不构建 plan，因此 `symlinks_created` / `symlinks_removed` 子项无 plan_ref

**AI agent 优先**：用 `set` + `build`，避免 `add` / `remove`（人类 verb，多 agent 并发时易互相覆盖）。

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
  "ok": true,
  "servers": [
    { "server": "prod", "ok": true, "pushed": 2, "pulled": 0, "skipped": 1, "conflicts": 0 },
    { "server": "dev", "ok": false, "error": "E_TIMEOUT", "message": "push to dev exceeded 60s" }
  ],
  "pushed": 2,
  "pulled": 0,
  "skipped": 1,
  "conflicts": 0,
  "warnings": 1,
  "changes": [
    { "op": "push", "skill": "skill-a", "server": "prod", "before": "abc", "after": "def", "plan_ref": "a1" }
  ],
  "backups": [
    { "skill": "skill-a", "server": "prod", "backup_path": "/Users/me/.syncskill/.backups/skills/skill-a/pre-pull", "size_bytes": 4096 }
  ]
}
```

**`servers[]`（多 server best-effort 语义）**：多 server 命令（`push --all` / `pull --all` / `sync --all` / `sync`）按 config 顺序串行执行，一个 server 失败不阻塞后续 server。`servers[]` 按执行顺序列出每个 server 的独立结果。单 server 命令（`push prod`）`servers[]` 仅含一个条目。顶层 `ok` = 全部成功才 true；exit code = 第一个非 0 错误的 code。顶层 `pushed`/`pulled`/`skipped`/`conflicts` 是所有 server 的合计。

`backups[]` 列出本次 pull / sync 中创建的所有 sidecar backup（§3.9 B1）。每个条目对应一次成功创建（rsync 写盘前）：

- `skill` / `server`：定位信息
- `backup_path`：绝对路径,等于 `<syncDir>/.backups/skills/<skill>/pre-pull`(syncDir 默认 `~/.syncskill/`,受 `SYNCSKILL_DIR` 覆盖)。所有读写统一走此路径,无 legacy 兼容路径
- `size_bytes`：备份目录总字节数（best-effort，cpSync 失败时仍含部分文件）

未触发 sidecar backup 的 pull（`--no-pull-backup`、本地 skill 不存在、push 命令未涉及 pull 阶段）→ `backups: []`。push 命令永远是 `[]`（push 不写本地）；pull / sync 视情况而定。

**Takeover warnings**：push 遇到远端非 symlink 真目录时输出 `W_TAKEOVER_NEEDED` warning 事件（不阻断），hint 指向 `remote takeover <server> <skill>`。详见 §3.18。

#### 11.6.16 `remote <action> <server> ...`

**`refresh <server>`**：

```json
{
  "server": "prod",
  "backup_path": "~/.syncskill/receivers/prod.json",
  "created": false,
  "discovered_agents": [
    { "name": "claude", "path": "~/.claude/skills", "preexisting_skills": ["foo", "bar"] },
    { "name": "agents", "path": "~/.agents/skills", "preexisting_skills": [] }
  ],
  "added_agents": ["cursor"],
  "added_skills_with_empty_links": ["new-skill-x"],
  "managed_skills": ["foo"],
  "remote_only_skills": ["bar"]
}
```

字段含义：

- `created` — 本次 refresh 是否创建了新 backup（首次 refresh = true；增量 refresh = false）
- `discovered_agents` — 远端扫描到的全部 agent + 各自下面的 skill 名（preexisting_skills 含 symlink 与 real dir 混合）
- `added_agents` — 本次合并新增到 `remote_agents` 的 agent 名（去重于已有）
- `added_skills_with_empty_links` — 本次合并新增到 `links` 的 skill 名（默认空数组）
- `managed_skills` — 远端 agent 下作为 symlink 存在的 skill（已被 syncskill 管理）
- `remote_only_skills` — 远端 agent 下作为真目录存在的 skill（用户手动放置，未激活同步；需要 `remote link add` + `remote takeover` 才能接管，详见 §3.18）

**`remote agent {add|rm} <server>` / `remote link {add|rm} <server>`**（config-edit）：

```json
{
  "server": "prod",
  "op": "agent.add",
  "before": { "remote_agents": { "claude": "~/.claude/skills" } },
  "after":  { "remote_agents": { "claude": "~/.claude/skills", "cursor": "~/.cursor/skills" } }
}
```

**`remote show <server>`**：返回完整 backup JSON（§3.3 receiver 本地备份 schema）。backup 不存在时返回新建的空 backup。

**`remote agent ls <server>` / `remote link ls <server>`**：返回各自子字段的内容（`remote_agents` 对象 / `links` 对象）。

#### 11.6.17 `restore <skill>` (v2.4 R1)

```json
{
  "skill": "my-skill",
  "restored_from": "/Users/me/.syncskill/.backups/skills/my-skill/pre-pull",
  "restored_to": "/Users/me/.syncskill/skills/my-skill",
  "pre_restore_backup": "/Users/me/.syncskill/.backups/skills/my-skill/pre-restore",
  "affected_servers": [
    { "server": "prod", "status_set": "conflict", "direction_set": "conflict" },
    { "server": "dev",  "status_set": "conflict", "direction_set": "conflict" }
  ],
  "skipped_servers": [
    { "server": "staging", "reason": "skill not in manifest" }
  ]
}
```

字段含义：

- `restored_from` / `restored_to`：sidecar backup 原路径与恢复目标
- `pre_restore_backup`：restore 执行前对当前内容创建的安全兜底快照（用户可手动从此目录再次回滚）
- `affected_servers[]`：实际被标记 `status=conflict + direction=conflict` 的 server。受 `--server` / `--all-servers` 控制
- `skipped_servers[]`：范围内但 manifest 中没有该 skill 条目的 server（例：pull 后才出现的 manual skill 在其他 server 上从未同步过）

`--dry-run` 模式输出同 schema，但 `restored_to` / `affected_servers` 表示 "would-be"，不实际写盘。

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
| `SYNCSKILL_YES_DESTRUCTIVE` | `--yes-destructive` | 设为 `1` 显式 opt-in 执行破坏性 verb（`unlink` / `link clear` / `remote takeover` / no-baseline `force-push`）；**安全严重**——禁止在共享 shell 中默认导出（持久 `export` 会静默禁用 v2.7.4 BREAKING 引入的双因子安全契约，回退到 v2.7 "-y 即执行"语义） |
| `SYNCSKILL_TIMEOUT` | `--timeout` | 默认网络超时秒数 |
| `SYNCSKILL_STRICT` | `--strict` | 设为 `1` 启用；多 target 命令 partial skip 升级为 exit 6（CI / 严格 AI agent 场景） |
| `SYNCSKILL_PULL_BACKUP` | `--no-pull-backup`（取反） | 设为 `0` 关闭 pull 写盘前的 sidecar backup；默认 `1` 启用。等价 `config.pull_backup` 字段；环境变量优先级高于 config，低于 CLI flag |
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

输出所有命令、子命令、flag、位置参数的结构化描述，以及每个命令的 plan / result / resolutions JSON Schema（取代旧的 `syncskill schema <command>` 子命令）：

```json
{
  "version": "1.x.y",
  "commands": [
    {
      "name": "install",
      "aliases": ["i"],
      "args": [{ "name": "url-or-path", "required": false }],
      "flags": [
        { "name": "--name", "type": "string", "description": "..." }
      ],
      "audience": "both",
      "prefer": null,
      "plan_schema": { "...": "..." },         // 该命令产出的 plan JSON Schema（仅两阶段命令，单阶段为 null）
      "result_schema": { "...": "..." },       // result.summary.data 的 JSON Schema
      "resolutions_schema": { "...": "..." }   // --resolutions 文件的 JSON Schema（仅两阶段命令，单阶段为 null）
    },
    {
      "name": "link add",
      "audience": "human",
      "prefer": "link set",
      "result_schema": { "...": "..." }
    },
    {
      "name": "link set",
      "audience": "agent",
      "prefer": null,
      "result_schema": { "...": "..." }
    }
  ],
  "global_flags": [
    { "name": "--json", "type": "boolean" },
    { "name": "--dry-run", "type": "boolean" }
  ]
}
```

- 单阶段命令（见 §3.0.B.3）的 `plan_schema` / `resolutions_schema` 字段为 `null`，仅保留 `result_schema`（其结构与 `--dry-run --json` 输出对齐）。两阶段 vs 单阶段的机读判定式 = `plan_schema !== null`。
- 单命令查询：`syncskill <command> --help --json` 仅输出该命令对应的条目，避免 AI agent 解析全量树。

**`audience` / `prefer` 字段**：让 agent 在自省阶段直接知道"哪些子命令为我设计、遇到 human-only 子命令该改用哪个"。

| 字段 | 取值 | 含义 |
|---|---|---|
| `audience` | `"human"` / `"agent"` / `"both"` | 该命令的设计受众。`"human"` 子命令通常带交互/增量语义,agent 调用易引发并发覆盖;`"agent"` 子命令幂等、声明式;`"both"` 是中性接口。**默认 `"both"`**——只在 spec §3.1/§3.6 显式标注受众的命令才出现非 `"both"` 值 |
| `prefer` | `string \| null` | 当 `audience: "human"` 时,推荐 agent 改用的等价命令(如 `"link set"`)。`null` = 无替代或当前命令本身就是首选 |

**当前受众分类**(据 §3.1 link 表 + §3.6 双轨设计):

| 命令 | audience | prefer |
|---|---|---|
| `link edit` / `link add` / `link remove` / `link clear` / `unlink` | `human` | `link set` |
| `link set` / `link build` / `link list` | `agent` | `null`(已是首选) |
| 其余所有顶层命令(`install` / `update` / `push` / `pull` / `sync` / ...) | `both` | `null` |

**agent 用法**:`syncskill --help --json` 后过滤 `audience !== "human"` 的命令列表作为"安全候选集";遇到 human 命令时按 `prefer` 字段重定向(若有)。

**设计目的**：未来新增命令 / 修改 schema 时，skill prompt 无需更新——agent 启动时跑一次 `syncskill --help --json` 自动学习全部命令面 + schema + 受众分类。

### 11.11 JSON-only Config（自动迁移）

**`~/.syncskill/config.json` 是唯一配置格式**。JSON 对 AI agent 更友好（无缩进歧义、无 multi-doc、无 anchor），让 AI 读写 config 更可靠。

**读取逻辑**：

1. `--config <path>` / `$SYNCSKILL_CONFIG` 显式指定 → 用该文件（必须以 `.json` 结尾）
2. 默认目录下 `config.json` 存在 → 用 JSON
3. 默认目录下 `config.yaml` 存在（旧版遗留）→ 读取并**自动迁移**（见下方）
4. 两者都不存在 → 报错 `E_CONFIG_NOT_FOUND`

**自动迁移**：`loadConfig()` 在每次读取时立即执行（**不等待首次写**，保证后续所有读路径都看到 JSON）：

1. 读取 `config.yaml`，解析为内存中的 `SyncSkillConfig`
2. **立即**写 `config.json`（即使后续没有 mutate）
3. 将原 `config.yaml` 重命名为 `config.yaml.migrated-<ISO timestamp>.bak`（用于回滚兜底；不会被任何命令自动清理）
4. 输出 `info` 事件：`Migrated config.yaml → config.json (backup: config.yaml.migrated-...bak)`
5. 返回内存对象给调用方继续命令逻辑

为什么"立即迁移"而非"延迟到首次写"：

- AI agent 多次以纯只读命令（如 `status`、`diff`、`source list`）启动时，每次都重做 YAML→对象解析浪费 CPU
- 不同 AI agent 在同一仓库读到的 config 路径必须确定（要么都 JSON 要么都 YAML），延迟迁移让"第一个写者"决定迁移时机，多 agent 并发不可预测
- 立即迁移让 AI agent 在第一次 `loadConfig()` 后就拥有"确定性 JSON 单源真相"

迁移后所有后续操作只读写 `config.json`。用户确认无问题后可手动删除 `.bak` 文件；`doctor --fix` 不负责清理。

**保留时长**：YAML 自动迁移代码长期保留（不打 deprecation 警告），用于兜底极少量旧版用户在大版本跨度后升级时的配置可用性。仅在明确移除决策下线（届时由维护者手动从 §11.11 / 代码同步移除）。

**`init` 命令**：直接创建 `config.json`（不创建 YAML）。

**显式指定路径**：`--config /path/to/custom.json` 必须以 `.json` 结尾。传入 `.yaml` / `.yml` / `.json5` / 其他任何非 `.json` 扩展名 → 立即报错 `E_CONFIG_FORMAT_UNSUPPORTED` + exit 2，hint：`Convert to JSON, or move the file to ~/.syncskill/config.yaml and rerun without --config to trigger auto-migration`。

显式指定路径**不触发自动迁移**（迁移仅作用于默认目录 `~/.syncskill/` 或 `$SYNCSKILL_DIR`）。这是有意为之：当用户用 `--config` 指向自定义路径时，通常是测试/沙盒场景，不应在用户的非默认位置悄悄改写文件。需要把旧 YAML 迁过来的用户，先 `mv ./my-config.yaml ~/.syncskill/config.yaml` 再不带 `--config` 跑一次，让自动迁移产出 `~/.syncskill/config.json`，然后再 `--config /path/to/config.json` 显式引用即可。

### 11.12 `--no-interactive` 契约

> v2.7.4 round-4 编号迁移：原 §11.5 在 round-4 被新章节 "API Stability Tiers" 占用，本节内容（与 `E_NEEDS_INPUT` core entry 紧耦合）整体迁至 §11.12。`src/core/context.ts` / `tests/integration.test.ts` 中残留的 "spec §11.5" 引用待 PR 4 注脚清理时统一修正为 §11.12。

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
