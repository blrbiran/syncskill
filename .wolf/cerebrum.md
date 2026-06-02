# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- **[2026-05-21]** 语言约定：
  - 对话使用中文
  - `docs/superpowers/specs/` 下的文档使用中文
  - 其他文档（README.md, docs/*.md 等）使用英文
  - 代码、注释、git commit message 使用英文

## Key Learnings

- **[2026-05-22]** `install` can adopt plan-then-execute incrementally: wire only the deterministic `--self` path through `withPlanExecute` first, and leave interactive URL/path installs on the existing flow until source probing/planning is designed.
- **[2026-05-22]** `tests/integration/source-update-force.test.ts` should verify stash/sidecar backup behavior only; persisted update history assertions must be removed because spec §3.8 no longer records history.
- **[2026-05-21]** `docs/config-guide.md` should document v2 config as JSON-only, mention automatic YAML→JSON migration on write, and use `link apply|set|add|remove|clear|list` examples instead of legacy `link --apply`.
- **Project:** syncskill
- **Description:** Multi-device AI Agent Skill sync tool
- **Main Spec:** `docs/superpowers/specs/syncskill-design.md` 是总设计文档，实现前先对比 spec 与当前代码，确定待实现部分
- **Testing:** 本地测试 CLI 使用 `npm run build && npm link`，然后运行 `syncskill <args>`
- **CLI Entry Point:** 当通过 npm link 运行时，`process.argv[1]` 是 symlink 路径，与 `import.meta.url` 不匹配。需要使用 `realpathSync` 解析真实路径后比较
- **Config Defaults:** `private_agents` 使用完整覆盖语义；未配置时回退到默认列表 `['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']`

- **[2026-06-02]** E2E `withInit()` 现在只识别 `skipSelf`，不识别旧的 `skipSkill`。测试若还传 `skipSkill`，built-in `syncskill` 会继续被安装/链接，后续手写覆盖 `config.links` 时就会冒出 stale-link prompt；单-skill 声明式更新也要走 `link set <skill> <agent>`，不能再写旧的 `link <skill> -y`。
- **[2026-06-02]** GitHub URL 安装/建档必须持久化 repo-relative `source.path`（等价 spec 的 `skill_subdir`），不能回写内部 checkout 目录。裸仓库 URL 应落成 `.`；`/tree/<branch>/<subdir>` 应落成对应子目录；显式 `skillSubdir`/`path` override 优先于 URL 推断。
- **[2026-06-02]** 用户文档里的 source 运行时布局要写成 `~/.syncskill/.sources/<name>/checkout/`；`config.sources[*].path` 描述的是 checkout 内的 repo-relative 子目录，不是内部 checkout 根路径本身。`skills-registry.json` 示例也应使用当前 v2 形态（`ignored` + `http_baselines`），不要再展示旧的 v1 active-status 示例。
- **[2026-06-02]** E2E stale-checkout helper 也必须跟随当前 runtime layout：伪造 git/non-git stale source 时要直接建到 `.syncskill/.sources/<name>/checkout`，否则 helper 本身就和安装/更新路径漂移，容易出现假阴性覆盖。
- **[2026-06-02]** `install --path` 的最终语义是 source checkout 内“包含 skills 的 repo-relative 子目录”，`--skill-subdir` 只是它的别名；help、README/skill 文档和回归测试都要按这个语义表述，不能再写成内部 source 存储路径或模糊的通用 subdirectory。docs 索引页若提 stale symlink cleanup，也应明确指向 `syncskill link build`，不要笼统写成 `link` 命令本身自动 reconcile。

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-06] **严重事故：删除用户 home 目录数据** — 绝对不能执行 `rm -rf ~/` 或任何针对 home 目录的递归删除。任何破坏性操作必须先停下来询问用户，列出影响范围，等待明确同意。
- [2026-05-07] `.wolf/memory.md` and `.wolf/buglog.json` are in `.gitignore` — never include them in git commits. They are local-only tracking files.
- [2026-05-18] **CRITICAL: Tilde (~) in paths must be expanded** — Node.js treats `~` as a literal directory name, NOT as home directory shortcut. Using `join(config.agents[x], skill)` directly when config contains `~/.claude/skills` creates `./~/.claude/skills/` in CWD. Always use `resolveAgentPath(agentPath, homeDir)` to expand `~` before any filesystem operation. This bug caused users to accidentally delete their home directory when running `rm -rf ~/` thinking they're cleaning up test artifacts.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- **[2026-05-07]** Main design spec is `docs/superpowers/specs/syncskill-design.md`. All future major changes should prompt whether to update this spec document.
- **[2026-05-12]** Agent 目录路径跟随各 agent 官方约定，不统一风格（如 amp 用 `~/.config/agents/skills`）
- **[2026-05-12]** `antigravity` 作为独立 agent 列出，不作为 gemini 变体处理
- **[2026-05-12]** 多 skills 安装需用户确认，单个 skill 直接安装（避免意外安装大量 skills）
- **[2026-05-12]** `compressing` 依赖是必要的，CLI 在 Windows 支持不好，需要跨平台纯 JS 方案
- **[2026-05-14]** Manifest 使用 3-field 模型 (`local_hash`, `remote_hash`, `recorded_hash`) 而非 2-field。`recorded_hash` 作为 3-way merge 基准点，天然解决"syncskill 外部操作"（如 git checkout）场景，无需额外的 in-sync 保护逻辑
- **[2026-05-15]** Update overwrite recovery metadata should live in `~/.syncskill/update-history.json`, with one record per source keyed by source name.
- **[2026-05-16]** User-facing docs should mention `private_agents`, `source update --dry-run`, `source restore`, and `--timeout` together because they shipped as one update-flow feature set.
- **[2026-05-16]** 数据优先级原则：`file truth > config > registry`。registry 是 config 的派生缓存，不是独立 source of truth
- **[2026-05-16]** `install` 无参数显示帮助；内置 skill 只能通过位置关键字 `install self` 安装，`install --self` 已移除并应由 commander 直接报 `unknown option`；若 cwd 存在 `./self` 目录，只有交互菜单选择 built-in 或无本地 `./self` 时才走内置安装分支。
- **[2026-05-16]** `link <skill>` 打开单 skill 矩阵编辑器；`link <skill> <agent>` 追加链接；`unlink` 保持纯移除语义
- **[2026-05-19]** `unlink <skill>` 直接移除该 skill 的所有 agent 链接；不再支持 `<agent>` 参数或 `--all` 选项，保留 `-y/--yes` 与 `--dry-run`
- **[2026-05-16]** 无参数 `syncskill` 显示仪表盘摘要（不触发网络请求）；health=本地 `diagnoseConfig()` 的 errors+warnings，server 状态仅读 `~/.syncskill/manifests/*.json`，skills 统计来自 `loadSkillsRegistry()`，其中 active=linked、ignored=ignored
- **[2026-05-17]** Dashboard spec 输出要求固定格式：标题+分隔线、`Skills: total (linked, ignored)`、`Sources: count (names)`、agent 存在性符号、server 基于 manifest 非 `in-sync` 项计为 pending、底部 quick actions 与 help 提示都需要精确覆盖到测试
- **[2026-05-16]** 支持 `--force --dry-run` 组合预览强制更新的影响
- **[2026-05-21]** v2 spec 删除所有 deprecated CLI 形态（link 旧形态、source add/update、scan --migrate），因为 syncskill 未正式发布，无向后兼容负担
- **[2026-05-21]** Config 格式改为 JSON-only（原 YAML）：任何 config 写操作自动迁移 YAML → JSON 并删除旧 `config.yaml`。AI agent 处理 JSON 更可靠（无缩进歧义）
- **[2026-06-02]** Commander 的否定布尔选项 `--no-interactive` 在运行时体现为 `interactive=false`，不是 `noInteractive=true`。CLI 透传到 engine 前需要统一成显式 `noInteractive`，未设置时保持 `undefined`，避免回归测试和运行时语义漂移。
- **[2026-06-02]** 现有 manifest 模型尚未显式引入 `delete` / `remote-deleted` 类型时，pull-side 远端删除仍会先表现为 `direction="pull"`。实现 `--on-deletion` 时必须基于 hash 组合 (`remote_hash === null && recorded_hash !== null && local_hash === recorded_hash`) 单独分流，不能把所有 `pull` 都直接送进 `pullSkillDirectory()`。
- **[2026-06-02]** sync/pull/push 的 server 遍历顺序要保持 `Object.keys(config.servers)` 的插入顺序，不能额外 `.sort()`。这个顺序会直接影响 `--all` 执行顺序，以及 cross-server policy 的 `first-wins` / `last-wins` 语义。
- **[2026-06-02]** Commander 的否定布尔 flag 若要保留“未设置=undefined”语义，不能只注册 `--no-foo`；需要同时加一个隐藏的正向 option（如 `new Option('--pull-backup').hideHelp()`），这样未传 flag 时不会把值强制变成 `true`，CLI 才能继续让 env/config 决定默认值。
- **[2026-06-02]** pull-side 覆盖/删除本地 skill 前的 sidecar backup 路径统一为 `~/.syncskill/.backups/skills/<skill>/pre-pull`。优先级是 CLI `--no-pull-backup` / hidden positive option → `SYNCSKILL_PULL_BACKUP` → `config.pull_backup` → 默认开启。
- **[2026-06-02]** `--strict` / `SYNCSKILL_STRICT` 只应在命令结果里存在“真实 skipped work”时触发 exit 6。`skipped_skills` 不能混入 finalized manifest 中已经执行完成或仅仅变成 `direction="skip"` 的 no-op 项，否则 multi-target partial skip 会被误判。
- **[2026-06-02]** `push` / `pull` / `sync` 的 `--json` 模式必须只输出 JSONL 事件，不再混入人类可读 rows 或 conflict banner；`result.summary.data` 需要稳定包含 `servers[]`、`changes[]`、`backups[]` 以及顶层计数，供 agent 精确判读 per-server/per-skill 结果。
- **[2026-06-02]** 用户可见文档与 skill 文档要跟随 spec 的最终命令面同步更新：`install self`、顶级 `update`、`link build`、`--plan` + shell 重定向取代 `--plan-file`，并删除 `doctor --rebuild-registry` 等已移除入口；`tests/unit/docs.test.ts` 也要一起更新，否则会在文档收口时回归失败。
- **[2026-06-02]** `install --self` 已从最终命令面移除，不做兼容保留。help / integration tests / error 文案都应只指向位置关键字 `install self`，旧 flag 应保持 commander 默认 `unknown option` 行为。
- **[2026-06-02]** `install self` 的 `--json` / `--apply -` / hidden stdin alias 路径必须保持纯 JSONL；install 流程复用的 helper（如 `ensureSharedSkillsDirectory()`）不能再直接 `console.log` / `console.warn`，而要走统一 output 通道，否则 JSON 模式会被人类文本污染并打断 agent 解析。
- **[2026-06-02]** `--apply <path|->` / `--resolutions <path|->` 的 `-` 必须按 Unix 约定读取 stdin；旧 `--apply-stdin` / `--resolutions-stdin` 只作为隐藏兼容 alias。`parsePlan()` 也要补齐稳定默认值（缺失 action.id 自动补 `aN`，缺失 unresolved.resolve_phase 默认 `plan`），这样 execute 路径、plan_ref 关联和测试输出才可预测。
- **[2026-06-02]** `source update --force` 的 HTTP dirty backup 统一落到 `~/.syncskill/.backups/sources/<source>/pre-update`，不要再使用旧的 `skills/<source>.syncskill-pre-update-backup` 位置；CLI 提示也要明确 `--force` 只绕过 dirty protection，`-y/--yes` 才是自动确认 prompt。
- **[2026-06-02]** `install self` / `install <source>` 返回的 `linkedAgents` 必须来自 `linkConfiguredSkills()` 的真实结果，不能直接回显 `config.agents` 或 `config.links`。否则 wildcard `*` 会泄漏到结果里，且 summary 会错误声称链接到了并未实际创建链接的 agent。
- **[2026-06-02]** `source remove --json` 和 `link build --json` 的 summary 需要保留可追踪的 `plan_ref`：前者在 `removed_links[]`，后者在 `symlinks_created[]` / `symlinks_removed[]`。这属于 agent 依赖的机器可读契约，应由 integration tests 锁住。
- **[2026-06-02]** `doctor --rebuild-registry` 已从最终命令面移除；registry 缺失/损坏/孤儿建议统一改成 `syncskill link build` 重新生成 `skills-registry.json`。CLI 集成测试若执行 `dist/index.js`，代码改动后必须先 `npm run build`，否则会误读旧命令面并产生假失败。
- **[2026-06-02]** ignored state 的唯一真相源现在是 `config.sources[*].ignore[]`；`skills-registry.json` v2 只持久化 `http_baselines`。doctor、dashboard、source dirty detection、link build 和相关 tests 都应基于 `file truth > config > registry`，不要再从 registry 读取 ignored/active/path。
- **[2026-06-02]** 文档与测试指南也要跟随最终命令面和状态模型一起更新：`link --apply` → `link build`，config 示例写 `config.json` 而不是 `config.yaml`，sidecar 备份目录写 `.backups/sources/<source>/pre-update` / `.backups/skills/<skill>/pre-pull`，skills-registry 描述不能再写成“origin mapping + ignore status”的旧模型。
- **[2026-06-02]** help/description 文案也属于最终命令面的一部分；像 `doctor` 这种命令的描述不能再写 `config.yaml issues` 之类的旧表述。改完 help 文案后，若集成测试跑 `dist/index.js`，同样要先 `npm run build` 再验证。
- **[2026-06-02]** `link apply` 旧别名也已从最终命令面移除，不做兼容保留。`link --help` / integration tests 只应暴露 `build`；当前 commander 对 `syncskill link apply` 的失败形态是把 `apply` 视为 `link` 的多余参数，因此回归断言应匹配 `too many arguments for 'link'`，不要再期待 `unknown command`。
- **[2026-06-02]** 无参数 `syncskill` 也会先走 root command 的 `preAction` 自动 refresh 本地 manifests；dashboard integration fixture 如果手写 manifest，必须写入真实 `local_hash`（或显式关闭 refresh），否则进入 dashboard 前会被本地 hash 刷新成 pending。
- **[2026-05-21]** Link 命令双轨设计：人类用 verb（edit/add/remove/clear），AI agent 用 declarative（set + build）。`set` 幂等可重放，避免多 agent 并发覆盖
- **[2026-05-21]** `installFromSource()` 直接复用 `addSourceFromUrl()`；当前 `install` 已覆盖 `source add` 的核心持久化入口（含 git/http/local/archive source 建档），删除 `source add` 不需要额外保留独立逻辑