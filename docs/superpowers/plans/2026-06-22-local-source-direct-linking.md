# 2026-06-22 Local Source Direct Linking

## Goal

修复 `syncskill install <local-directory>` 的落盘语义，使 local directory source：

1. 不再经过 `~/.syncskill/skills/` 这层 managed store。
2. 直接从 source 的实际 skill 目录链接到各 agent skills 目录。
3. 不再在未确认情况下把 agent 侧现有真实目录替换为 symlink。

## Confirmed Drift

- 当前 local source materialization 会把 `~/.syncskill/skills/<skill>` 建成指向 source tree 的 symlink：`src/source.ts:1262-1294`, `src/source.ts:1771-1779`。
- 当前 install/link 路径固定从 `~/.syncskill/skills/<skill>` 出发给 agent 建链：`src/linker.ts:207-237`。
- 当前 agent 建链前会无条件删除同名目标目录，再重建 symlink：`src/linker.ts:186-205`。
- 用户明确期望：local directory source 应直接 `source skill dir -> agent skills dir`，而不是先进入 `~/.syncskill/skills/`。

## Scope

1. local directory source 不再写入 `~/.syncskill/skills/<skill>`。
2. link 流程能为 local-source-owned skills 解析真实 source skill 目录并直接建链。
3. 若 agent 目标路径已存在且不是 symlink，则默认拒绝覆盖。
4. 补充 unit coverage，锁定上述语义。

## Non-Goals

- 不改 git/http source 的 materialization 语义。
- 不做更大范围的 source/remove/reconcile 架构重构。
- 不新增交互式 takeover 流程；本次只做“默认拒绝覆盖真实目录”。

## Implementation Plan

### 1. source local materialization 改成 state-only

目标：`src/source.ts`

- 保留 local source 的发现、ownership、source state 持久化。
- 对 `source.type === 'local' && !archive_path`，不再在 `~/.syncskill/skills/` 创建 symlink。
- git/http/archive local 维持现状。

### 2. 增加“按 skill 解析真实 link source”的 helper

目标：`src/source.ts` + `src/linker.ts`

- 新增 helper，根据 skill 名解析应被 link 的真实目录：
  - 若 `~/.syncskill/skills/<skill>` 存在，优先返回它；
  - 否则若 ownership 指向一个 local directory source，则从该 source 的 materialized root 重新发现 skill absolute path；
  - 否则返回 null。
- `linkConfiguredSkills()` 改为走该 helper，而不是固定拼 `~/.syncskill/skills/<skill>`。

### 3. linker 默认拒绝覆盖真实目录

目标：`src/linker.ts`

- `ensureLinkedDirectory()` 改成：
  - 若目标不存在：正常创建 link/copy；
  - 若目标是 symlink：可重建到新目标；
  - 若目标是非 symlink 的真实目录/文件：抛错，拒绝 takeover。

### 4. install existing-skill 探测改成包含 active source skills

目标：`src/install.ts`

- `installFromSource()` 当前用 `listLocalSkillNames()` 作为 existing set。
- local source 不再落到 `~/.syncskill/skills/` 后，这个集合会漏掉 active source skills。
- 改成基于 `discoverAllSkills()` 判断已存在 skill，避免重复安装/重复选择。

## Tests

### Unit

1. `tests/unit/source.test.ts`
   - local source materialization 只记录 state/ownership，不再写 `~/.syncskill/skills/<skill>`。
2. `tests/unit/linker.test.ts`
   - local-source-owned skill 可直接 link 到 agent。
   - 目标已存在真实目录时，linker 拒绝覆盖。
3. `tests/unit/install.test.ts`
   - local source install 走 direct linking，不要求 `~/.syncskill/skills/<skill>` 存在。

## Validation

- `npm run build`
- `vitest run tests/unit/source.test.ts tests/unit/linker.test.ts tests/unit/install.test.ts`

## Risks

- 现有 stale-link reconcile 主要按 `.syncskill/skills` 识别 managed symlink；本次先保证 install/link 不再异常，若后续发现 local direct link 的 reconcile 缺口，再单独补。