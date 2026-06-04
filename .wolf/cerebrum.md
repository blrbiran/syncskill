# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-06-04

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- **[2026-05-21]** 语言约定：对话使用中文；`docs/superpowers/specs/` 下文档使用中文；其他文档（`README.md`、`docs/*.md` 等）使用英文；代码、注释、git commit message 使用英文。
- **[2026-06-03]** 输出被截断或 token hit 后，直接续写，不要道歉、不要 recap，按更小块继续推进。
- **[2026-06-04]** `.wolf/*` 记录应定期去重、总结、瘦身；优先保留长期有效规律与近期高价值上下文，不要无限追加低信噪比流水。

## Key Learnings

- **[2026-05-21]** 项目主 spec 是 `docs/superpowers/specs/syncskill-design.md`；大改前先对 spec，再决定实现缺口。
- **[2026-05-21]** 本地 CLI 验证路径：`npm run build && npm link` 后执行 `syncskill <args>`。
- **[2026-05-21]** `private_agents` 是完整覆盖语义；未配置时回退默认列表 `['claude', 'codex', 'gemini', 'cursor', 'kiro', 'augment', 'cline', 'hermes']`。
- **[2026-06-02]** `config.sources[*].path` 对 local / git / http 都是 materialized source root 内的相对目录；不能写 absolute path。文档、help、tests 都要锁住这点。
- **[2026-06-02]** `install --path` 语义是 source checkout 内包含 skills 的 repo-relative 子目录；`--skill-subdir` 只是 alias。不要再写成内部存储路径或模糊 subdirectory。
- **[2026-06-02]** 运行时 source 布局是 `~/.syncskill/.sources/<name>/checkout/`；docs、fixtures、stale-checkout helpers 都要按这个路径。
- **[2026-06-02]** `skills-registry.json` v2 只保留 `http_baselines`；ignored 的真相源是 `config.sources[*].ignore[]`；总原则是 `file truth > config > registry`。
- **[2026-06-02]** `refresh` 最终命令面不再接受 `--status`；无 flag 时刷新并打印 status，`--local` / `--remote` 只刷新不打印。文档收口要同时扫 workflow/example，并在 docs smoke test 里加负向断言。
- **[2026-06-03]** remote 信息源分两类：`config show` / `config.json` 展示 transport config；`remote show <name>` 展示本地 receiver backup（`updated_at`、`remote_agents`、`links`）。两者不能混写。
- **[2026-06-03]** receiver-backup 的领域规则和写入流程集中在 `src/core/server.ts`；`src/refresh.ts` 和 `src/core/sync_engine.ts` 只做 orchestration。测试凡 mock `refreshRemoteManifestFromServer()` 的路径，也要同步 mock `scanRemoteAgents()`。
- **[2026-06-03]** 现有 end2end harness 不支持真实 SSH / remote transport；remote push/pull/receiver 类行为只应算 integration，e2e 最多保留显式 skipped stub，避免假覆盖。
- **[2026-06-04]** `restore <skill>` 需要 sticky `forced_conflict`；不能只靠 hash reconcile。resolve 后该字段应被清掉，而且持久化上只保留 `true`。
- **[2026-06-04]** `pre-pull` / `pre-restore` / source sidecar 目录快照逻辑应集中在 `src/utils/backup.ts`；CLI action 只做 restore 编排。
- **[2026-06-04]** wrapper 层测试优先锁真实 contract（参数透传、返回值、行为），不要保留“function exists / signature exists”占位测试。
- **[2026-06-04]** docs smoke test 不要锁 markdown 表格里带 `|` 的整串命令；优先断言稳定子串，避免被 `\|` 转义打成假失败。
- **[2026-06-04]** v2.8 CLI 面收口时，`strict` 只保留 `SYNCSKILL_STRICT`；用户可见远端删除策略 flag 用 `--on-remote-deletion`；pull backup 开关走 `config.pull_backup` / `SYNCSKILL_PULL_BACKUP`，旧 flag 不再公开。
- **[2026-06-04]** `push` / `pull` / `sync` 三个命令的“loadConfig + autoDiagnoseConfig + target server selection”前置流程应共用一个小 helper，避免同一 contract 漂移三处。
- **[2026-06-04]** CLI help 回归测试要同时锁“该出现的公开 flag”和“不该暴露的隐藏兼容 alias / 已废弃 flag”；只测正向出现容易让旧参数悄悄回流到帮助面。
- **[2026-06-04]** source update 的 removed-skill e2e 应优先锁稳定契约：保留为本地技能的提示、`.syncskill/skills` 仍存在、source checkout 中该技能已消失；不要依赖单源 update 是否打印汇总行。
- **[2026-06-04]** 文档与技能说明在 sync CLI 收口后要明确区分“公开 flag”和“env/config 开关”：`--on-remote-deletion` 是公开参数，而 strict / pull-backup 控制走 `SYNCSKILL_STRICT`、`SYNCSKILL_PULL_BACKUP` 与 `config.pull_backup`。

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-06] **严重事故：删除用户 home 目录数据** — 绝对不能执行 `rm -rf ~/` 或任何针对 home 目录的递归删除。任何破坏性操作必须先停下来询问用户，列出影响范围，等待明确同意。
- [2026-05-07] `.wolf/memory.md` and `.wolf/buglog.json` are in `.gitignore` — never include them in git commits. They are local-only tracking files.
- [2026-05-18] **CRITICAL: Tilde (~) in paths must be expanded** — Node.js treats `~` as a literal directory name, NOT as home directory shortcut. Always use `resolveAgentPath(...)` before filesystem operations involving configured agent paths.
- [2026-06-03] `failWithOutputError()` / destructive gates inside commander actions cannot rely on `process.exit()` alone to stop execution in tests, because integration tests mock `process.exit()`. After a blocked destructive path, return explicitly.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- **[2026-05-07]** Main design spec is `docs/superpowers/specs/syncskill-design.md`.
- **[2026-05-14]** Manifest 使用 3-field 模型（`local_hash`, `remote_hash`, `recorded_hash`）而非 2-field；`recorded_hash` 作为 3-way merge 基准点。
- **[2026-05-16]** 数据优先级原则：`file truth > config > registry`；registry 是派生缓存，不是独立 source of truth。
- **[2026-05-16]** `install` 无参数时：TTY 进入交互菜单，非 TTY 显示帮助；内置 skill 只通过位置关键字 `install self` 安装；`install --self` 不做兼容保留。
- **[2026-05-16]** Link 命令双轨设计：人类用 verb（`edit/add/remove/clear`），AI agent 用 declarative（`set + build`）；`unlink <skill>` 是 remove-all alias。
- **[2026-05-16]** 无参数 `syncskill` 显示本地 dashboard 摘要，不触发网络请求。
- **[2026-05-21]** syncskill 未正式发布，移除 deprecated CLI 形态时不承担向后兼容包袱。
- **[2026-05-21]** Config 格式改为 JSON-only；任何 config 写操作自动迁移 YAML → JSON 并删除旧 `config.yaml`。
- **[2026-06-02]** 顶级 `update` 取代 `source update`；`install` 负责新增 source；`source add/update/restore` 从最终命令面移除。
- **[2026-06-03]** 用户可见的 `server` 命令面向 `remote` 收口；文档、help、tests 都应优先暴露 `remote`。
- **[2026-06-03]** push 使用 `receivers/<server>.json` 里的 receiver backup 作为远端拓扑真相源，而不是只回显 `config.servers[*].remote_agents`。
- **[2026-06-04]** `restore <skill>` 是本地 recovery：从最新 `pre-pull` backup 回放，并故意把 manifest 留在显式 `conflict`，直到用户 resolve。
