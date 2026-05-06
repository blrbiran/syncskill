# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** syncskill
- **Description:** Multi-device AI Agent Skill sync tool
- **Testing:** 本地测试 CLI 使用 `npm run build && npm link`，然后运行 `syncskills <args>`

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-06] **严重事故：删除用户 home 目录数据** — 绝对不能执行 `rm -rf ~/` 或任何针对 home 目录的递归删除。任何破坏性操作必须先停下来询问用户，列出影响范围，等待明确同意。

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
