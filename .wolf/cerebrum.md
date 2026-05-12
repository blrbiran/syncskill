# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** syncskill
- **Description:** Multi-device AI Agent Skill sync tool
- **Main Spec:** `docs/superpowers/specs/syncskill-design.md` 是总设计文档，实现前先对比 spec 与当前代码，确定待实现部分
- **Testing:** 本地测试 CLI 使用 `npm run build && npm link`，然后运行 `syncskill <args>`
- **CLI Entry Point:** 当通过 npm link 运行时，`process.argv[1]` 是 symlink 路径，与 `import.meta.url` 不匹配。需要使用 `realpathSync` 解析真实路径后比较

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-06] **严重事故：删除用户 home 目录数据** — 绝对不能执行 `rm -rf ~/` 或任何针对 home 目录的递归删除。任何破坏性操作必须先停下来询问用户，列出影响范围，等待明确同意。
- [2026-05-07] `.wolf/memory.md` and `.wolf/buglog.json` are in `.gitignore` — never include them in git commits. They are local-only tracking files.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- **[2026-05-07]** Main design spec is `docs/superpowers/specs/syncskill-design.md`. All future major changes should prompt whether to update this spec document.
- **[2026-05-12]** Agent 目录路径跟随各 agent 官方约定，不统一风格（如 amp 用 `~/.config/agents/skills`）
- **[2026-05-12]** `antigravity` 作为独立 agent 列出，不作为 gemini 变体处理
- **[2026-05-12]** 多 skills 安装需用户确认，单个 skill 直接安装（避免意外安装大量 skills）
- **[2026-05-12]** `compressing` 依赖是必要的，CLI 在 Windows 支持不好，需要跨平台纯 JS 方案