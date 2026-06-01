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
- **[2026-05-16]** `install` 无参数显示帮助；`install self` 或 `install --self` 安装内置 skill；有 `./self` 目录冲突时 `--self` 强制安装内置
- **[2026-05-16]** `link <skill>` 打开单 skill 矩阵编辑器；`link <skill> <agent>` 追加链接；`unlink` 保持纯移除语义
- **[2026-05-19]** `unlink <skill>` 直接移除该 skill 的所有 agent 链接；不再支持 `<agent>` 参数或 `--all` 选项，保留 `-y/--yes` 与 `--dry-run`
- **[2026-05-16]** 无参数 `syncskill` 显示仪表盘摘要（不触发网络请求）；health=本地 `diagnoseConfig()` 的 errors+warnings，server 状态仅读 `~/.syncskill/manifests/*.json`，skills 统计来自 `loadSkillsRegistry()`，其中 active=linked、ignored=ignored
- **[2026-05-17]** Dashboard spec 输出要求固定格式：标题+分隔线、`Skills: total (linked, ignored)`、`Sources: count (names)`、agent 存在性符号、server 基于 manifest 非 `in-sync` 项计为 pending、底部 quick actions 与 help 提示都需要精确覆盖到测试
- **[2026-05-16]** 支持 `--force --dry-run` 组合预览强制更新的影响
- **[2026-05-21]** v2 spec 删除所有 deprecated CLI 形态（link 旧形态、source add/update、scan --migrate），因为 syncskill 未正式发布，无向后兼容负担
- **[2026-05-21]** Config 格式改为 JSON-only（原 YAML）：任何 config 写操作自动迁移 YAML → JSON 并删除旧 `config.yaml`。AI agent 处理 JSON 更可靠（无缩进歧义）
- **[2026-06-02]** Commander 的否定布尔选项 `--no-interactive` 在运行时体现为 `interactive=false`，不是 `noInteractive=true`。CLI 透传到 engine 前需要统一成显式 `noInteractive`，未设置时保持 `undefined`，避免回归测试和运行时语义漂移。
- **[2026-05-21]** Link 命令双轨设计：人类用 verb（edit/add/remove/clear），AI agent 用 declarative（set + apply）。`set` 幂等可重放，避免多 agent 并发覆盖
- **[2026-05-21]** `installFromSource()` 直接复用 `addSourceFromUrl()`；当前 `install` 已覆盖 `source add` 的核心持久化入口（含 git/http/local/archive source 建档），删除 `source add` 不需要额外保留独立逻辑