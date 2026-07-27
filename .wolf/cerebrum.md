# Cerebrum

> OpenWolf learning memory. Keep only long-lived preferences, constraints, conventions, and reusable lessons.
> Last compacted: 2026-06-19

## User Preferences

- **[2026-05-21]** 语言约定：对话使用中文；`docs/superpowers/specs/` 下文档使用中文；其他文档（`README.md`、`docs/*.md` 等）使用英文；代码、注释、git commit message 使用英文。
- **[2026-06-03]** 输出被截断或 token hit 后，直接续写，不道歉、不 recap，按更小块继续推进。
- **[2026-06-19]** `.wolf/*` 优先做“压缩归档”而不是简单删除或无限追加：`buglog.json` 保留未解决项与模式化代表 bug，`cerebrum.md` 只保留长期有效规则，`memory.md` 用阶段/主题摘要承载旧流水并保留最近原始明细。

## Key Learnings

- **[2026-07-27]** Agent skill 目录（`~/.claude/skills` 等）里混有其他工具的簿记目录（`.curator_backups`/`.omc`/`.system`）。任何扫描/迁移 agent 目录的代码都必须同时做两道过滤：跳过 `.` 开头的目录 + 要求存在 `SKILL.md`（`findUnmanagedSkills` 一直是对的，`listSkillDirectoriesFiltered` 之前只过滤了非目录）。
- **[2026-07-27]** `config.links` 的 key 排序里 `.` 排在字母前，所以一个非法的点号条目会让 `link build` 在第一项就崩掉、后面所有 skill 都链接不上——批量命令必须逐条 try/catch。约定：`request.all` 降级为 `state:'failed'` 并告警继续，单 skill 显式请求仍然抛错。
- **[2026-07-27]** 给 doctor 加新 DiagnosticCode 要改四处，少一处就会“报了修好了但没改”：`DiagnosticCode` 常量、`repairConfig` 的 code 判断、`index.ts` 的 `autoFixableItems` 过滤、以及 `index.ts` 里逐项构造的 `RepairOptions` 映射。
- **[2026-05-21]** 项目主 spec 是 `docs/superpowers/specs/syncskill-design.md`；做较大实现前先对齐 spec，再决定实现缺口。
- **[2026-05-21]** 本地 CLI 验证路径：`npm run build && npm link` 后执行 `syncskill <args>`。
- **[2026-05-21]** `private_agents` 是完整覆盖语义；未配置时回退默认列表 `['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']`。
- **[2026-06-02]** `config.sources[*].path` 对 local / git / http 都表示 materialized source root 内的相对目录，不能写 absolute path。
- **[2026-06-02]** `install --path` 语义是 source checkout 内包含 skills 的 repo-relative 子目录；`--skill-subdir` 只是 alias。
- **[2026-06-02]** 运行时 source 布局是 `~/.syncskill/.sources/<name>/checkout/`。
- **[2026-06-02]** 数据优先级原则：`file truth > config > registry`；registry 是派生缓存，不是独立 source of truth。
- **[2026-06-03]** `config show` / `config.json` 展示 transport config；`remote show <name>` 展示本地 receiver backup（`updated_at`、`remote_agents`、`links`）；两类信息源不能混写。
- **[2026-07-24]** 技能归属表在 `~/.syncskill/.sources/skills.json`（`owners: skill -> sourceName`，非 config.json）。一个技能名同一时刻只能属于一个 source。
- **[2026-07-24]** 安装时技能名冲突有**两类**，都改成「跳过 + 报错」而非整体 throw（部分安装）：(1) `owned-by-other-source`——名字被别的 source 占用；(2) `path-occupied`——`~/.syncskill/skills/<skill>` 已有一个**无归属的孤儿目录**。两类都在 sync 两分支**之前**过滤掉。`assertMaterializationTargetsAvailable` 已改名为 `collectMaterializationConflicts()`，**返回**占用技能名的 Set 而不再 throw（保留 git/http 同 owner 的 reuse continue 逻辑；local in-place 用 pathExists 判定）。跳过项经瞬时字段 `SourceSyncResult.skipped_conflicts`（**不落盘**，`{skill,reason,owner?}`）→ `ResolvedInstallSkills`/`InstallFromSourceResult` → CLI `output.warning('E_SKILL_OWNED'|'E_SKILL_PATH_OCCUPIED', …)` + JSON `data.skills.skipped_conflicts`。孤儿目录**绝不覆盖**（data-safety）。教训：只修 owner 一类会让崩溃在 retest 时移动到 path-occupied 一类——两类要一起修。
- **[2026-06-03]** 现有 end2end harness 不支持真实 SSH / remote transport；remote push/pull/receiver 类行为应优先放在 integration，e2e 最多保留显式 skipped stub，避免假覆盖。
- **[2026-06-04]** docs/help 回归测试应锁稳定 contract：优先断言稳定子串与“已移除参数不再出现”，不要锁 markdown 表格转义后的整串命令，也不要把示例命令当帮助面必现文本。
- **[2026-07-09]** install/help/docs 契约同步时，help 面改动用 `tests/integration/help-output.test.ts` 锁 CLI 文案，README / guides / bundled skill 改动用 `tests/unit/docs.test.ts` 锁稳定子串；两类回归都要一起跑，避免“help 正确但文档未同步”或反之。
- **[2026-06-08]** 共享 command preflight 改动后，`install`（尤其 `install self` / plan / apply）必须跳过共享 doctor/preflight；负向 integration test 若要命中命令分支，也要先准备能通过 preflight 的最小 fixture。
- **[2026-06-19]** 发现语义现已明确分成两套：`~/.syncskill/skills/` 下的 managed local skills 按顶层目录识别；source/install discovery 仍按 leaf-skill 规则（single root `SKILL.md` 或 `skills/<leaf>/SKILL.md`）。
- **[2026-06-19]** `syncskill link` 展示 configured assignment（配置意图矩阵），`syncskill link ls` 展示 realized on-disk status（已落盘状态矩阵）；`-` 表示未配置，`·` 表示已配置但磁盘缺失。
- **[2026-06-20]** `install` 的 spec 是命令级统一 plan/execute 协议：`install self` 与 `install <url>` 都属于两阶段命令；允许唯一的 execute-phase prompt 例外是 external install 的 `skill-selection` unresolved。现代码已把 external install 接入 `withPlanExecute()`，并要求 `--apply` 配合 `--resolutions` 解决 execute-phase unresolved。
- **[2026-06-20]** external install 的 planner 不能调用带副作用的 default-link helper（如 `ensureDefaultLinkTargets()`），否则 `--plan` JSON 会被目录创建提示污染。plan 阶段只能用纯只读 helper（如 `computeDefaultLinkTargets()`）。
- **[2026-06-24]** remote 矩阵编辑器写的是 `config.json` 意图（`links` + `servers.<name>.skills.include`），不是 per-server receiver backup；`push` 在 backup 已存在时必须先把 included skill 中 `backup.links` 缺失的条目从 `config.links` seed 进去，且不能覆盖显式 per-server backup state。
- **[2026-06-22]** 用户明确了期望语义：local directory source 不应经过 `~/.syncskill/skills` 这层 managed store，而应从 source 里的实际 skill 目录直接链接到各 agent skills 目录。后续分析/修复 local source 安装问题时，要把 `~/.syncskill/skills` 参与进来视为实现偏差。
- **[2026-06-22]** local directory source 的修复后语义：agent 侧 link source 解析必须保持 `manual (~/.syncskill/skills) > local-source-owned direct path` 的优先级；否则会把已有 manual skill 错误覆盖成 source 直链。后续改 linker/source 优先级时先守住 manual precedence。
- **[2026-06-22]** local directory source 当前会把 `~/.syncskill/skills/<skill>` 直接 symlink 到原始 source tree；随后 `linkConfiguredSkills()` 又会无条件删掉 agent 侧同名路径并重建为 symlink。后续修复此类问题时，不能让本地安装暴露源仓库，也不能在未确认下接管既有真实目录。
- **[2026-07-09]** GitHub tree/subdir source 若 `source.path` 指向的目录自身含 `SKILL.md`，root skill 名必须取 `basename(source.path)`；`relativePath='.'` 表示“请求子目录的根”，不是仓库根，也不能回退成 repo 名。
- **[2026-07-09]** external install 的 same-repo / duplicate-skill 路径也要显式保留 `alreadyInstalledSkills`；否则 text CLI 会误报 `No skills installed.`，即使 JSON summary 已经有 `data.skills.already_installed` 语义。
- **[2026-07-10]** 共享 target `agents` 是本地 link/build/install 结果层的一级语义，不只是 `config.links` 中的占位值；凡是会“落盘 symlink”或“汇总已创建 links”的代码路径，都必须用支持 `agents -> ~/.agents/skills` 的 materialized-target 解析，而不能只按 `config.agents` 过滤。
- **[2026-07-11]** link/stale-cleanup 不能只按逻辑 agent 名处理目录；agent 目录若是 symlink 或多个 agent realpath 相同，必须按 canonical path 去重/判权，否则像 `~/.codex/skills -> ~/.claude/skills` 这类别名会让“删除 codex stale link”实际删到 Claude 目录。

## Do-Not-Repeat

- **[2026-05-06]** 绝对不能执行 `rm -rf ~/` 或任何针对 home 目录的递归删除。任何破坏性操作都必须先询问用户、列出影响范围、等待明确同意。
- **[2026-05-07]** `.wolf/memory.md` 和 `.wolf/buglog.json` 是本地记录文件，不要提交到 git。
- **[2026-05-18]** 涉及用户配置路径的文件系统操作前，必须先展开 `~`；Node.js 会把它当普通目录名而不是 home shortcut。
- **[2026-06-03]** commander action 里的 destructive gate / `failWithOutputError()` 不能只依赖 `process.exit()` 停止执行；测试里 mocked `process.exit()` 后必须显式 `return`。
- **[2026-06-08]** 不要把 `process.exit()` 放在与 structured output 同一个 `try/catch` 里；测试里 mocked exit 会被误吞成输出层异常。
- **[2026-06-08]** 不要把 placeholder、静态断言、或不执行真实 CLI 的 case 记成 end2end 覆盖。
- **[2026-06-08]** 不要在 docs/help 回归里断言示例式短语或 markdown 表格整串命令；先看真实输出，再锁稳定 contract。
- **[2026-06-09]** 不要把 external/same-repo install 的 `sameRepoMatch` 当成 no-op；重复安装仍要做 scope/path/materialization/ignore 协调。
- **[2026-06-19]** 不要把 `config.links` 当成“已安装”的真相源；这类判断要看本地文件真相（如 `listLocalSkillNames()`）。

## Decision Log

- **[2026-05-07]** Main design spec is `docs/superpowers/specs/syncskill-design.md`.
- **[2026-05-14]** Manifest 使用 3-field 模型（`local_hash`, `remote_hash`, `recorded_hash`）；`recorded_hash` 作为 3-way merge 基准点。
- **[2026-05-16]** 数据优先级采用 `file truth > config > registry`；registry 是派生缓存。
- **[2026-05-16]** `install` 无参数时：TTY 进入交互菜单，非 TTY 显示帮助；内置 skill 只通过位置关键字 `install self` 安装，不保留 `--self`。
- **[2026-05-16]** Link 命令双轨设计：人类用 verb（`edit/add/remove/clear`），AI agent 用 declarative（`set + build`）；`unlink <skill>` 是 remove-all alias。
- **[2026-05-16]** 无参数 `syncskill` 显示本地 dashboard 摘要，不触发网络请求。
- **[2026-05-21]** syncskill 未正式发布，移除 deprecated CLI 形态时不承担向后兼容包袱。
- **[2026-05-21]** Config 格式改为 JSON-only；任何 config 写操作自动迁移 YAML → JSON 并删除旧 `config.yaml`。
- **[2026-06-02]** 顶级 `update` 取代 `source update`；`install` 负责新增 source；`source add/update/restore` 从最终命令面移除。
- **[2026-06-03]** 用户可见的 server 命令面向 `remote` 收口；文档、help、tests 都应优先暴露 `remote`。
- **[2026-06-04]** `restore <skill>` 是本地 recovery：从最新 `pre-pull` backup 回放，并故意把 manifest 留在显式 `conflict`，直到用户 resolve。
- **[2026-06-19]** step-4 e2e 审查结论：只保留真实用户可见 contract 的 e2e；same-repo install 继续放在 real-git integration 层；unsupported transport/stale 场景保留 skipped stub 直到 harness 真能覆盖。
