# profile／按 run 注入／版本记录 设计

日期：2026-10-03
状态：待人审
归属：Claude Code 交互会话 `16ab00f2`（从 Orca 仓库发起），基于 syncskill `main` 上主题行
`docs: record TTY-detection convention in cerebrum` 那一笔。

## 1. 目标

给 syncskill 补三件事，供 Orca（多 agent 调度器）以 spawn CLI 的方式使用：

1. **profile**：给一组 skill 起名字。
2. **按 run 注入**：把一组 skill 复制成快照，放进调用方指定的任意目录。两个并行 run 用两个目录，互不干扰；不碰 `~` 下各 agent 的 skill 目录。
3. **版本记录**：git 源记下解析出的 commit；每次注入写一份锁文件，回答「这次 run 用的是哪些 skill、各是哪个版本」。

**人已定**（2026-10-03，本会话）：
- 注入复制成快照，不用符号链接。
- 版本只记录，不重放。
- profile 写进 `config.json`（方案 1），并新增 `profile` 子命令和 `inject` 命令。
- 直接在 `main` 上工作。

**不做**：
- 按锁文件重放旧版本。
- profile 的交互式编辑器。
- 为 profile 单独做 remote 同步。profile 是 `config.json` 的一个字段，跟着 `config.json` 现有的同步方式走。
- doctor 检查「profile 引用了已不存在的 skill」。这种情况在 `inject` 时会以 `E_SKILL_NOT_FOUND` 报出来，不需要另一个入口（讨论方案时提过 doctor 检查，写 spec 时去掉）。
- 新的退出码或 JSONL 事件类型。

## 2. 现状（开工前现读，2026-10-03）

- `SourceConfig`（`src/config/types.ts`）只有 `branch`，没有 commit。
- `package.json` 只有 `bin`，没有库 API。
- **`--sync-dir`／`SYNCSKILL_DIR` 不生效**：`getSyncDir` 只看 `homeDir`（`src/config/config.ts`），`createProgram` 解析出来的 `mergedConfig.syncDir` 在 `src/` 里没有任何地方读它。现有测试一律靠改 HOME 隔离。本设计的判据也只改 HOME。这个缺陷本轮不修，见 §8。
- **`validateConfig` 会丢掉不认识的 key**：它返回一个只含已知 key 的新对象，`saveConfig` 再把这个对象写回。手工加在 `config.json` 里的新 key，下一次任何保存都会抹掉。
- **`normalizeSourceState` 同样会丢掉不认识的字段**：只保留 `materialized_skills` 和 `updated_at`。
- skill 的取源逻辑是 `resolveConfiguredSkillSourceDir`（`src/linker.ts`，未导出），顺序为 manual 托管目录 `~/.syncskill/skills/<skill>` > local 源直链 > 报错。git 和 http 源的 skill 会复制进托管目录（`copySkillDirectory`）；local 归档源在托管目录里放的是指向 checkout 的**符号链接**（`recreateSymlink`，`src/source.ts` 同一处分支）。两者都走第一档，返回的路径可能是符号链接，所以复制必须解开链接（§5）。
- 归属表：`.sources/skills.json` 的 `owners: skill → sourceName`。
- 内容 hash 用 `hashSkillDirectory`（`src/core/manifest.ts`）：对排好序的相对路径和文件内容做 MD5，跳过符号链接。

## 3. 数据

### 3.1 `config.json` 新增 `profiles`

```json
{ "profiles": { "review": ["skill-a", "skill-b"] } }
```

- 类型为 `Record<string, string[]>`，加进 `SyncSkillConfig`。
- `validateConfig`：值不是对象 ⇒ `{}`；每个清单只保留字符串，并做排序、去重。
- `createDefaultConfig`：`profiles: {}`。
- profile 名用和 `src/core/transport.ts` 的 `SAFE_SKILL_NAME` 相同的规则（`^[a-zA-Z0-9_-]+$`），不合法时报 `E_USAGE_PROFILE_NAME`（退出码 2）。

### 3.2 源的 `resolved_commit`

- `.sources/<名>/state.json` 新增 `resolved_commit: string | null`。
- git 源每次物化完成（clone 或 fetch 加 reset 之后）跑 `git -C <checkout> rev-parse HEAD`，结果写进这个字段。http、local 源写 `null`。
- `normalizeSourceState` 保留这个字段；字段缺失或不是 40 位小写十六进制时读成 `null`。老文件不需要迁移。

### 3.3 锁文件 `<target>/syncskill-lock.json`

```json
{
  "schema": "syncskill-lock-v1",
  "created_at": "<ISO 8601>",
  "profile": "review",
  "skills": [
    {
      "name": "skill-a",
      "source": { "name": "x", "type": "git", "url": "https://…", "branch": "main" },
      "resolved_commit": "<40 位 sha>",
      "content_md5": "<hashSkillDirectory(<target>/skill-a)>"
    }
  ]
}
```

- `profile` 用 `--skills` 时为 `null`。`--skills` 的清单先排序、去重。
- `skills` 按 `name` 排序。
- `source` 为 `null` 表示没有归属源的手工 skill，此时 `resolved_commit` 也是 `null`。
- `source` 取自 `owners` 加 `config.sources`；`branch` 没配置时省略这个键。
- `resolved_commit` 取自该源 state.json 的当前值。
- **commit 和 hash 两个都记**：托管目录里的 git skill 可能被本地改过。commit 回答「从哪来」，`content_md5` 回答「实际用的是什么」。`content_md5` 对复制后的目录现算。

## 4. 命令

所有命令都支持 `--json`（JSONL），走现有的 `Output`、错误码映射和退出码 0–8，开始前照常跑 preflight。

| 命令 | 行为 |
|---|---|
| `profile set <名> <skill…>` | 整份替换清单。每个 skill 都必须能被 `resolveConfiguredSkillSourceDir` 解析到，否则报 `E_SKILL_NOT_FOUND`，退出码 2，config 不改 |
| `profile ls [名]` | 不带名字时列出全部（名字加清单）；带名字时列出单个，名字不存在则报 `E_PROFILE_NOT_FOUND`，退出码 2 |
| `profile rm <名>` | 删除；名字不存在则报 `E_PROFILE_NOT_FOUND`，退出码 2 |
| `inject (--profile <名> \| --skills <a,b,…>) --target <目录>` | 见 §5 |

## 5. `inject` 的语义

1. **参数**：`--profile` 和 `--skills` 必须恰好给一个，否则是用法错误（退出码 2）。`--target` 是相对路径时按当前工作目录解析成绝对路径。
2. **先全部解析**：对清单里每个 skill 调用 `resolveConfiguredSkillSourceDir`（改为导出）。有任何一个失败就报 `E_SKILL_NOT_FOUND`，退出码 2，**target 里什么都不写**（target 不存在时也不创建）。
3. **不覆盖**：只要 `<target>/<skill>` 中有任何一个已经存在，或者 `<target>/syncskill-lock.json` 已经存在（用 `lstat` 判断，符号链接也算存在），就报 `E_TARGET_OCCUPIED`，退出码 7，什么都不写。
4. **复制**：
   - 创建 target（`recursive`），然后把每个 skill 用 `cp(src, <staging>/<skill>, { recursive: true, dereference: true })` 复制进 `<target>/.syncskill-inject-<pid>/`；
   - 全部复制完以后，逐个 `rename` 到 `<target>/<skill>`；
   - 对每个 `<target>/<skill>` 现算 `content_md5`，组装锁文件，先写到 staging 目录，再用 `link(staging/lock, <target>/syncskill-lock.json)` 放到位。`link` 遇到已存在的文件会报 `EEXIST`，此时按 `E_TARGET_OCCUPIED` 处理（`rename` 会静默覆盖，不能用）。
   - 删除 staging 目录；
   - 任何一步失败：删除 staging 目录和本次已 rename 过去的 skill 目录，然后报错。
   - **并发与残留**：同一个 target 只支持一个写者。第 3 步的检查与 rename 之间有竞态，`rename` 到一个**空**的已存在目录会把它替换掉；锁文件靠 `link` 做到排他，skill 目录不做。进程被 `SIGKILL` 时，`.syncskill-inject-<pid>/` 会留在 target 里；第 3 步的占用检查不看它，之后的 inject（pid 不同）不受影响，清理由调用方负责。
5. **输出**：每个 skill 一条 `change` 事件（`op: "add"`、`entity: "skill"`、`name`、`target` 为复制后的路径）；最后一条 `result`，`summary` 含 `target`、`lock`（锁文件路径）、`skills`（与锁文件同形）。
6. **不碰**：`config.json`、`config.links`、registry、manifest、`~` 下各 agent 的 skill 目录。

target 放在哪里由调用方决定。放进 git worktree 的话，锁文件和 skill 会进入提交，这需要 Orca 那一侧处理。

## 6. 错误码

| 情形 | 错误码 | 退出码 |
|---|---|---|
| skill 解析不到 | `E_SKILL_NOT_FOUND`（已存在） | 2 |
| profile 不存在 | `E_PROFILE_NOT_FOUND` | 2 |
| profile 名不合法 | `E_USAGE_PROFILE_NAME` | 2 |
| `--profile`／`--skills` 同时给或都不给 | `E_USAGE_INJECT_SELECTION` | 2 |
| target 已被占用 | `E_TARGET_OCCUPIED` | 7 |

沿用 `src/cli/exit-codes.ts` 现有约定：`*_NOT_FOUND` 与 `E_USAGE*` 映射到 2（`E_PROFILE_NOT_FOUND` 加进那一支；`E_USAGE_*` 按前缀自动命中）；`E_TARGET_OCCUPIED` 加进 `E_CONFLICT` 那一支，映射到 7。

## 7. 测试与判据

测试按 syncskill 的三层约定分层；新功能都放在 unit 和 integration，不加 e2e。

**unit**：
- `validateConfig` 保留 `profiles`，并做排序、去重和非法值兜底；
- `normalizeSourceState` 保留合法的 `resolved_commit`，缺失或非法时得 `null`；
- 锁文件组装：排序、`source` 为 `null` 的分支、省略 `branch`。

**integration**（经 `dist/index.js` 真跑，HOME 和 `USERPROFILE` 改道到临时目录）：
1. `profile set`／`ls`／`rm` 往返；`set` 之后再跑一个会保存 config 的现有命令（如 `link set`），确认 profile 还在；
2. 用本地裸仓库做 git 源（`install <bare 路径> --type git`；不给 `--type`，以 `/` 开头的路径会被 `detectSourceType` 判成 local）：`install` 之后 state.json 里的 `resolved_commit` 等于该仓库 `rev-parse HEAD`；源仓库再提交一笔并 `update` 之后，该字段跟着变；
3. 两个 target 各用一个 profile 注入：每个 target 里恰好是自己清单里的 skill；锁文件里的 `content_md5` 等于对目标目录现算的值；`resolved_commit` 等于源仓库的 HEAD。再用 `--skills b,a,a` 注入第三个 target：锁文件的 `profile` 为 `null`，`skills` 为 `[a, b]`；
4. 注入之后修改 inject 读取的那份源，即托管目录 `~/.syncskill/skills/<skill>/SKILL.md`（改道后的 HOME 下），target 内容的 hash 不变（快照语义）；
5. target 已被占用 ⇒ 退出码 7；缺 skill ⇒ 退出码 2。两种情况下 target 的目录列表都和调用前相同；
6. `--profile` 与 `--skills` 同时给 ⇒ 退出码 2；
7. 一个 skill 里含有指向 skill 外部文件的符号链接：target 里对应的是普通文件，内容与链接目标相同；
8. target 里已有 `syncskill-lock.json` 而没有任何同名 skill 目录 ⇒ 退出码 7，锁文件字节不变。

**真实用户数据**：integration 测试只在改道后的 HOME 下运行。另加一条判据：测试文件运行前后，对真实 `~/.syncskill` 做「条目名加 stat 加 sha256」快照比对（真实目录不存在时比对「不存在」这个事实本身）。

**变异**：每个新分支点名一条删掉它自己的变异，并确认看到它变红，只在 `git clone --local` 副本里做。至少包括：
| 变异 | 预期变红的判据 |
|---|---|
| 删掉 `validateConfig` 里的 `profiles` | integration 1 |
| 删掉 `normalizeSourceState` 里的 `resolved_commit` | unit，以及 integration 2 |
| 不写 `resolved_commit` | integration 2 |
| 复制改成符号链接 | integration 4 |
| 去掉占用检查 | integration 5 |
| 去掉「先全部解析」 | integration 5 的缺 skill 分支 |
| `dereference: true` 改成 `false` | integration 7 |
| 锁文件的 `link` 改成 `rename`，并去掉第 3 步对锁文件的检查 | integration 8 |
| `--skills` 不去重 | integration 3 的 `--skills` 分支 |

**按设计红不了的**：`content_md5` 对复制后的目录算还是对源目录算，在没有并发修改时两者相同，任何判据都分不出来。这一点只登记，不写判据。

**门**：每个 task 跑 `npm run test:unit` 加 `npm run build`；收尾前跑 `npm run test:integration`。

**文档**：README 和 `docs/usage-guide.md` 的命令表加上新命令。按 cerebrum 的约定，用 `tests/integration/help-output.test.ts` 和 `tests/unit/docs.test.ts` 锁住稳定的子串。

## 8. 登记，不在本轮修

- `--sync-dir`／`SYNCSKILL_DIR`／`--config`／`SYNCSKILL_CONFIG` 解析了但不生效（§2）。
- `normalizeSourceEntry` 丢掉 `skill_subdir`、`ignore`、`archive_path`（子代理报告；本设计不依赖它，未逐行复核）。
- 主 spec `syncskill-design.md` 描述了若干代码里没有的东西（如 `E_CONFIG_REGRESSION`，以及 `update` 输出里的 `before_commit`／`after_commit`）（子代理报告，未逐条复核）。

## 9. 实施期更正

- §5 步骤 4 与并发段落里的 staging 目录名 `.syncskill-inject-<pid>` 已改为 `.syncskill-inject-<随机串>`，由 `mkdtemp` 在 `try` 之前创建（保留 `.syncskill-inject-` 前缀）。原因：pid 命名在不同 PID 命名空间（容器、bind mount 的 target）里会撞名，`mkdir` 的 `EEXIST` 会让回滚删掉别人的 staging；现在回滚只会删本次调用自己创建的目录。SIGKILL 后残留的目录同样带这个前缀，清理仍由调用方负责。原 §5 文字保留不改。
