# AGENTS.md

本仓库的 agent 协作约定如下。

## 语言与沟通
- 面向用户的说明、总结、评审意见统一使用中文。
- 技术术语、命令、代码标识符保持原文。
- 回复保持简洁，优先给结果与下一步。

## 实施流程
- 对于非琐碎功能或 milestone，先写 plan doc，再开始实现。
- plan doc 放在 `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`。
- 对已有 plan 的实现，默认使用 subagent-driven 方法按 task 推进。
- 只有用户明确选择其他执行方式时，才切换出 subagent-driven 方法。
- 除非被明确阻塞，否则连续推进，不要频繁停下来等待确认。

## Git 工作方式
- 每个完成并通过 review 的独立 task 单独提交一个 git commit。
- 如果 feature 改动涉及 plan doc，feature 提交后再单独提交 plan doc。
- 每个 milestone 完成后，直接将 feature 分支 fast-forward 合入 `main`。
- 对应 worktree 在合入 `main` 后应清理。
- 不要执行破坏性 git 操作，除非用户明确要求。

## 代码变更原则
- 只做当前任务需要的最小改动，避免无关重构。
- 优先修改现有文件，非必要不要新增文件或抽象。
- 默认不写注释；只有在原因不明显时才写一行短注释。
- 保持实现安全，避免引入命令注入、路径穿越、XSS、SQL 注入等问题。

## 验证要求
- 测试目录按 `tests/unit`、`tests/integration`、`tests/end2end` 三层组织。
- 新增测试前，先明确其所属层级。
- 默认必须通过 `unit test`。
- 可构建改动必须通过 `npm run build`。
- `integration test` 不属于每个 task 的默认 gate，但每个 milestone 合入 `main` 前必须通过。
- `end2end test` 不属于默认 gate。
- 只有两种情况才运行 `end2end test`：用户明确要求；或当前 plan / 验收步骤明确要求。

## 输出与收尾
- 汇报时说明改了什么、验证了什么、下一步是什么。
- 如果 milestone 已完成，默认继续做合并与 worktree 清理收尾。
