# Syncskill Spec — Version Changelog

> 从 `syncskill-design.md` 归档的历史增量变更公告。Spec 主体始终反映当前最新规范；本文件保留变更原因和决策上下文。

---

## v2.7.1（2026-06-02）

v2.7 ratify 后的 spec/code 收口版。v2.7 spec 是 spec-only 增量（9 项 design-review），v2.7.1 把代码追到 spec 一致 + 清理 v2.6 兼容包袱（用户确认 v2.6 无生产用户）+ 把 spec 内部 5 项不一致定稿。

**决议依据**：[`decisions-2026-06-01-spec-cleanup.md`](./decisions-2026-06-01-spec-cleanup.md) — 5 议题完整讨论 + 选项对比 + 决议。

**用户可见变化**：

- **`legacy` sidecar 兼容路径完全下线**（议题 2/3）：v2.6 sidecar `<skill>.syncskill-pre-pull-backup/` / `<source>.syncskill-pre-update-backup/` 等不再被 restore / update 兼容读。`backup-paths.ts` 的 `legacyXxxPath` helper、`PULL_BACKUP_SUFFIX` 常量、相关测试 case 一并删除。`restore` 找不到 v2 路径 → `E_BACKUP_NOT_FOUND` exit 3（无 fallback）。
- **`--cross-server-policy` 裸 server 名完全下线**（议题 4）：v2.6/v2.7 接受过 `--cross-server-policy=prod` 形式（v2.7 标 deprecation + info hint）；v2.7.1 起一律报 `E_SERVER_NOT_FOUND` exit 2，hint 引导用户写 `server:prod`。`I_CROSS_SERVER_BARE_NAME_DEPRECATED` info code 一并删除。
- **plan_ref 落地到所有 Tier 1 命令**（议题 1 B）：v2.7 spec §11.6.0 要求每个 result 变更项必带 `plan_ref`，但代码只在 push/pull/sync 实现了。v2.7.1 补齐 install (§11.6.6) / update (§11.6.7) / source remove (§11.6.8) / link build (§11.6.10)。install / source remove 同时把 result schema 重构为 §11.6.x 合规的对象列表（之前是裸 count）。
- **`--force` hint 改为架构不变量**（议题 5 option D）：`maybeEmitForceHint(ctx)` 删 `promptCode` 参数 + 删 `includes("DIRTY")` heuristic。spec §3.0.3 加 "架构不变量" 段：dirty-related prompt callsite 必须被 `if (!ctx.flags.force)` 守卫；hint 在 --force 下任何 prompt 真正触发时无条件 emit。

**兼容性**：所有改动属于 additive（plan_ref）或 internal API 简化；唯一两个外部用户可见的"break"是议题 2/4 的兼容路径删除，用户确认 v2.6 无生产用户，可接受。

**错误码 / info code 删除**：

- `I_CROSS_SERVER_BARE_NAME_DEPRECATED` —— 不再产生（裸名直接 E_SERVER_NOT_FOUND）

**测试**：798/798 unit + integration passing；38/38 e2e passing；新增 8 个 plan_ref 回归测试 + force-hint 测试套件重写。

---

## v2（2026-05-21）

flag 语义统一 + plan-then-execute 全局协议奠基。

- §3.0 / §3.0.B：新增 flag 语义统一定义 + plan-then-execute 全局协议
- §3.1：合并 `install`/`source add`、`update`/`source update`、`unlink`/`link clear`；删除 `server probe`、`refresh --status`；`scan --migrate-unmanaged` flag 命名
- §3.5：`install` 内化 source add 逻辑
- §3.6：明确 link 双轨设计（人类用 edit/add/remove/clear，AI agent 用 set + build）；`link apply` 重命名 `link build`
- §3.8：删除 `update-history.json` / `source restore` / `~/.syncskill/backups/`；dirty 默认 abort + hint
- §3.8（registry）：skills-registry.json v2 schema 瘦身到 ignored 元信息 + http baselines
- §10：registry 诊断 4 码合并为 1 码（REGISTRY_CORRUPT）；删 `--rebuild-registry`
- §11.6：补齐 10 个命令的 data schema；明确 plan/result 可追溯、data.changes 强制约定
- §11.8–11.11：新增环境变量表、stdout/stderr 契约、CLI self-introspection、JSON-only config（自动迁移）

---

## v2.1（2026-05-22）

- §3.0.B.6：新增 "`--apply` 与命令名规则"——plan 文件含 `command` 时命令名可省，显式指定必须与之一致，否则 `E_PLAN_COMMAND_MISMATCH` + exit 2
- §3.1：`install --self` flag 列表更新为 `install self`（保留位置关键字）；旧 flag 进入最终 deprecation 周期，曾计划发 `W_DEPRECATED_SELF_FLAG`（**已撤回**：v2.2 末改为由 commander 直接报 `unknown option` exit 1）
- §3.5：`install --self` → `install self` 重命名，新增"`self` 保留位置关键字"说明；本地 `./self` 用显式路径
- §3.9：跨服 cross-server-policy 表格的 "(`-y` 默认)" 移除；`-y` safe default 改为 `abort`（与 §3.0.5"`-y` 不暗示 first-wins"对齐）
- §11.6.6：标题更名 `install` / `install --self` → `install` / `install self`
- §11.11：YAML→JSON 自动迁移从"首次写时触发"改为"`loadConfig()` 读到 YAML 时**立即**迁移并写盘"；`--config <path>` 的 `.json` 校验明确拒绝非 .json 扩展名

---

## v2.2（2026-05-23）

- §3.0.5 / §11.3：新增 `--strict` / `SYNCSKILL_STRICT` 让 partial-skip 升级为 exit 6
- §3.0.B.3：`link build` 从 Tier 2 升级到 Tier 1，正式提供 `--plan` / `--apply` 等两阶段调用（v2.5 又降回 Tier 2）
- §3.5：`install self` 在执行前若 cwd 存在 `./self/` 目录则打印 warning `W_INSTALL_SELF_AMBIGUOUS`
- §3.5 / §3.6 / §3.8：补全所有 prompt 站点的 `default under -y` 标注
- §11.4：错误码表补 `E_PLAN_COMMAND_MISMATCH` (exit 2) / `E_CONFIG_FORMAT_UNSUPPORTED` (exit 2) / `E_CONFIG_NOT_FOUND` (exit 3) / 警告码 `W_INSTALL_SELF_AMBIGUOUS` / `W_SOURCE_DIRTY`
- §11.8：新增 `SYNCSKILL_STRICT` 环境变量（等价 `--strict`）

---

## v2.3（2026-05-25）

> 状态：v2.3（v2.2 基础上：远端 receiver 本地备份模型 + per-server `links` 矩阵 + `remote` 命令族 + `remote-takeover` unresolved + `--on-takeover` flag + receiver `apply --takeover` 参数）

### v2.3 audit-1（2026-05-25 同日）

删除 `remote init`（refresh 单命令处理首次 + 增量）；删除 `remote diff`（暂不实现）；push/sync auto-synthesize backup 不再 fail-fast；plan 阶段允许常数级网络元数据查询（含 SSH），G4 takeover preflight 进 plan；refresh 降为非 Tier 命令；§3.13 补 receiver apply 输出契约。

### v2.3 audit-2（2026-05-26）

S1 `remote-deletion` 完整接入 plan→executor（compareManifests 新增 `delete` action 区分远端删除 vs 首推；pullFromServer 接受 `deleteResolutions`；pushToServer 不再 silent re-push）；S2 `remote` 命令族支持 `--json` 输出（实现 §11.6.16 契约）；S3 `link build` 的 `link-cleanup` kind 统一；S4 push plan 不再产 `kind: "conflict"`，与 pull/sync 共用 `content-conflict`（options 因命令而异）；S5 `refresh <server>` 标注幂等；S6 push 端 takeover 跳过提示改为 actionable 措辞。

### v2.3 audit-3（2026-05-26 同日）

**A** auto-synthesize backup 改为 scan-based — push 触发自动合成时先 SSH `scan-agents` 拉真实远端布局，按 symlink→已激活 / 真目录→`[]` 自动分类；SSH 失败直接 abort + `E_RECEIVER_SCAN_FAILED`（不软回退）。**B** refresh 措辞订正：spec 不再宣称"等价 dry-run"——refresh 始终写盘，"幂等"指"不覆盖手动设的条目"。**C** `--on-conflict` 正式三命令共享（push/pull/sync），但 push 取值限 `push|skip|abort`。**D** `--cross-server-policy` 正式对 `pull --all` 生效。**E** `E_BACKUP_EXISTS` 与 `E_REMOTE_NOT_INITIALIZED` 退出码映射均删除。**F** §2 目录树删除已不存在的 `src/source/history.ts` 占位项。**G** `buildSyncPlan` 加 takeover preflight。

### v2.3 audit-4（2026-05-26 同日）

**A1** §2 目录树刷新到当前 src/ 实际布局。**B1** §3.0.B.4 约束 2 明文化 `skill-selection` 例外。**C2** §3.0.B.2 明文化 `options[]` 与 `abort` 关系。**D2** §3.9 明文化 takeover 是 skill-level 粒度。**E2** §3.3 修订 `remote` 命令族 backup 创建语义：只读命令不落盘。**G3** §3.7 新增 case 7b（`push-delete` / `local-deletion`）+ `--on-local-deletion` flag。**H1** §3.0.B.2 新增 `source-merge` unresolved kind。

全部已落地并配套测试。

---

## v2.4（2026-05-27）

修复 first-time conflict 数据丢失路径 + 引入 pull sidecar backup + restore 命令。

**背景**：v2.3 及之前版本存在数据丢失路径——`recordedHash = null` 时 `pullFromServer` 把 `action === "conflict"` 一律塞进 `toPull` 直接 rsync——本地修改被静默覆盖。

**修复三维度**：
- **B1**: Pull sidecar backup（所有 pull 写盘路径）— `cpSync` 写盘前先备份，`--no-pull-backup` / `SYNCSKILL_PULL_BACKUP=0` / `config.pull_backup: false` 关闭
- **C1-C5**: `SyncDecisionSink.conflicts` 字段 + `applySyncResolutions` 写 sink + `pullFromServer.conflictResolutions` 消费 + `pushToServer` plan-resolutions 优先 + sync/push/pull 接线
- **C6**: `loadManifest` 损坏 JSON → rename `.bak` + `W_MANIFEST_CORRUPT`
- **R1**: `restore <skill>` 命令（从 sidecar backup 回滚）
- **E1/E2/E3**: UX 文案改进（dry-run conflict 措辞、status no-baseline 警告、pull backup 路径提示）

---

## v2.4.1（2026-05-27）

放宽 receiver Node 版本下限到 18（controller 仍 20+）。

**动机**：receiver 实际只用 `fs.cpSync`（Node 16.7+），其余 API 全部 Node 14+ 稳定。降到 18 覆盖 Debian 12 / RHEL 9 / Ubuntu 22.04 默认 Node。

---

## v2.5（2026-05-27）

Spec 清理与重构规划。

- **S1**: 增量公告归档到本文件，spec 顶部留摘要
- **S2**: UnresolvedKind 重命名（6 rename / 4 keep）
- **S4**: 合并 `remote refresh` 到 `refresh <server>`
- **S6**: restore `--server`/`--all-servers` 互斥
- **S7**: 加 receiver 无独立版本说明
- **S8**: `link build` 降 Tier 2

---

## v2.6（2026-05-29）

基于设计评审的 7 项变更（B/C/D/G/H/I/K），核心是 takeover 协议简化 + source merge 重设计，附带 flag 统一与死代码清理。spec 领先代码实现后回填。

**用户可见变更**：

- **B — `--on-conflict` 值域统一**：所有命令（push/pull/sync）统一接受 `keep-local|keep-remote|skip|abort`。push 下语义映射 `keep-local`=强制推送、`keep-remote`=skip。移除原 push 专属的 `push|skip|abort` 受限词表与 per-command 校验分支。
- **C — Takeover 改为独立命令**：移除 `--on-takeover` / `--takeover` flag、receiver `apply --takeover` 参数、`remote-takeover` unresolved kind、resolutions `takeover` 节、takeover 决议链（`resolveTakeoverDecisions` / `buildTakeoverWhitelist`）。push/sync 遇远端非 symlink 真目录恒 skip + 发 `W_TAKEOVER_NEEDED` warning（保留 `detectTakeoverNeeds` 预检）。新增独立命令 `remote takeover <server> <skill> [--agent <a>]`（§3.18），直接 SSH `stat` + `rm -rf` + `ln -s`。
- **D — Source merge 重设计**：对已有 source 的 `install` 永不弹 prompt（source 已受信）。统一原则——用户意图 scope 内 skill 全激活（un-ignore 之前忽略的 + 新发现直接 link），scope 外跨区域 skill auto-ignore。Case 1（new ⊂ existing）/ Case 2（new ⊃ existing，含 Identity）/ Case 3（互不包含→expand 共同父目录 + 跨区域 auto-ignore）。移除 `source-merge` unresolved 与 `mergeStrategy` 参数。
- **G — `--plan-file` 移除**：用 `--plan` + shell 重定向替代。
- **H — `--cross-server-policy` 接受 server 名**：除 `first-wins|last-wins|abort|prompt` 外可直接传 server 名指定获胜方；未知名 → `E_SERVER_NOT_FOUND` exit 2。
- **I — `sync` 顺序文档化**：spec 已注明 `pull → refresh → push`。
- **K — per-server result**：push/pull/sync result 新增 `servers[]`，多 server best-effort，每 server 独立 ok/error/计数（§11.6.15）。

**内部清理（2-2）**：移除 `registry.ignored` 机制——ignore 唯一真相源是 `config.sources[].ignore[]`，`skills-registry.json` 仅保留 `http_baselines`。删除 `IgnoredEntry` / `isIgnored` / `addIgnore` / `removeIgnore`；v1→v2 迁移只迁 http_baselines，旧 ignore 条目丢弃（工具未广发，可接受）。

**错误码新增**：`E_TAKEOVER_FAILED` (exit 5)、`E_REMOTE_NOT_INITIALIZED` (exit 3)、`W_TAKEOVER_NEEDED`。

**StructuredResolutions**：从 7 节缩到 5 节（移除 `source_merge` / `takeover`）。

全部已落地并配套测试（792 tests pass，含 e2e）；文档（README / 4 docs / SKILL.md）同步更新。

---

## v2.7（2026-05-30）

基于设计评审的 9 项 spec-only 变更,核心是消除 spec 内部不一致(`-y` 三人格)、增强 plan/result 可追溯、统一 sidecar 备份目录、提升 CLI 对 AI agent 的可机读性。**v2.7 是 spec-only 升版,代码改造后续单独跟进**。

**v2.7 决策对应 v2.6→v2.7 评审 9 项(B 选项即"维持/最低破坏"的细化方案)**：

- **项 1 — §3.0.2 破坏性 verb 规则**(消除"`-y` 例外"措辞)：增设规则——破坏性 verb(`link clear` / `unlink` / `remote takeover`)的 documented default-under-y = 执行;非破坏命令的 default-under-y = 保守。`-y` 行为不再有"个别例外",而是规则的一致应用。§3.6 `link clear` 说明重写为引用此规则;§3.0.5 与 §3.0.2 不再冲突。**零行为变更**——只是把已有行为从"例外"重新表述为"规则"。
- **项 2 — plan `actions[].id` + result `plan_ref`**：plan 的每个 action 加单 plan 内稳定唯一的 `id`(`a1`/`a2`…);result 的每个变更项必带 `plan_ref` 回指 action id(多对一时用 `plan_refs[]` 数组,无对应 plan 项的 result 项可省略)。agent 用一次 Map 即可对账 plan↔result,无需语义猜测。§3.0.B.2 schema + §11.6.0 强制约定同步更新。**纯新增字段,完全向后兼容**。
- **项 3 — 统一 sidecar 备份目录**：三套 sidecar (pre-pull / pre-update / pre-restore)从散落 skill/source 旁迁到 `~/.syncskill/.backups/` 命名空间:
  - `~/.syncskill/.backups/skills/<skill>/pre-pull/`(原 `<skill_path>.syncskill-pre-pull-backup/`)
  - `~/.syncskill/.backups/skills/<skill>/pre-restore/`(原 `<skill_path>.syncskill-pre-restore-backup/`)
  - `~/.syncskill/.backups/sources/<source>/pre-update/`(原 `<source-path>.syncskill-pre-update-backup/`)
  消除被同步目录污染、命名不一致问题。restore 同时读主路径 + v2.6 兼容路径一版,下版本移除。`result.summary.data.backups[].backup_path` 字段值变更(agent 读字段,不硬编码路径,无破坏)。
- **项 4 — plan flag `-` = stdin (5→3)**：`--apply <path|->` / `--resolutions <path|->`,`-` 按 Unix 惯例表示 stdin。`--apply-stdin` / `--resolutions-stdin` 降级为 alias,在 `result.summary.deprecations` 列出,下个大版本移除。§3.0.B.6 AI workflow 示例与 §3.5 install plan 引用同步更新。
- **项 5 — link 子命令 `audience` / `prefer` 自省**：`syncskill --help --json` 每个命令条目新增 `audience: "human" | "agent" | "both"`(默认 `"both"`)+ `prefer: string | null` 字段。link 子命令据 §3.1/§3.6 双轨设计填充:`link edit/add/remove/clear/unlink` → `audience: "human"` + `prefer: "link set"`;`link set/build/list` → `audience: "agent"`。agent 自省阶段可直接过滤 `audience !== "human"` 得到"安全候选集",遇 human 命令按 `prefer` 重定向。**纯新增字段,兼容**。
- **项 6 — cross-server-policy `server:<name>` 前缀**：`--cross-server-policy=server:prod` 替代 v2.6 引入的裸 `--cross-server-policy=prod`,消除"server 名碰巧叫 `abort`/`first-wins` 时的静默碰撞"。裸名仍接受但发 `info` 提示迁移,下个大版本移除。`E_SERVER_NOT_FOUND` 行为不变。§3.9 flag 表 + policy 语义表同步更新。
- **项 7 — `unresolved[].resolve_phase` 字段**：unresolved 加 `resolve_phase: "plan" | "execute"`,显式标注该决议项能在哪个阶段解决。`"plan"`(默认)= plan 阶段可枚举完整 candidates,可用 `--resolutions` 一次性提供;`"execute"` = candidates 只能 execute 阶段枚举,含此项的 plan **不能盲 apply**。目前唯一的 `"execute"` 项是 install 的 `skill-selection`(git source skill 列表只有 clone 后才能枚举);§3.0.B.4 约束 2 的"唯一例外"措辞退役,改为正规化契约,agent 据字段机读判断而非硬编码"install 特例"。**纯新增字段,兼容**。
- **项 8 — `--force` 非 dirty 场景提示**：维持 §3.0.3 force/yes 正交设计(agent 需独立控制"绕 dirty"与"跳确认")。新增约定:当 `--force` 在非 dirty 场景传入、命令仍弹其它 prompt 时,输出一次性 `info` hint `\`--force\` only bypasses dirty protection; use \`-y\` to auto-confirm prompts`。纠偏人类肌肉记忆,不改变行为。
- **项 9 — exit 6 文档引导 + cross-server 标 advanced**:§11.3 加 AI agent 解读建议——exit code 仅作粗筛,精确判断必须读 `result.data.skipped[]` / `data.servers[]` / `data.failed[]`;不要靠 `exit === 0` 推断"全部成功"。§3.9 cross-server-policy 章节加 advanced/低频标注,引导 agent 常规 sync 流程不必主动指定此 flag,仅在 plan 的 `unresolved[].kind === "cross-server-conflict"` 出现时再读。**纯文档,无行为变更**。

**v2.7 影响面**:

- **零代码改动**(spec-only)——代码层面的实现跟进作为后续单独任务。
- **兼容性**:9 项均无破坏性行为变更——项 1/8/9 是文档/规则重述,项 2/5/7 是纯新增字段,项 3/4/6 提供旧路径/旧 flag/旧值的一版兼容期 + deprecation 提示。
- **预计代码改造工作量**(后续任务参考):项 1 ≈ 调整 prompt-utils + 文案;项 2 ≈ plan/result 模型扩字段 + 全部命令 result 组装回填 `plan_ref`(中);项 3 ≈ pull-backup/restore/utils.backup 路径常量集中 + restore 兼容读旧路径(中);项 4 ≈ commander flag 解析 + alias(小);项 5 ≈ --help --json 渲染加字段(小);项 6 ≈ cross-server-policy 解析加前缀分支(小);项 7 ≈ plan 模型加字段 + install discover 标记(小);项 8 ≈ guardPrompt 加 hint 分支(小);项 9 ≈ 纯文档(无)。
