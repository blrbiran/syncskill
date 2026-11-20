# syncskill 测试者台账批（#403–#411）

> 2026-11-20，Orca 会话 `c8fc876f` 之后由同一控制器接手。台账：`orca_archived_files/issue-20261023.md`
> 的「待处理」。本轮由人授权直接执行（不派 subagent 实现），每个 milestone 合入 `main` 前跑 integration。

## 范围与取舍

| # | 现象 | 做法 |
|---|---|---|
| 403 | `npm run build` 不复制 `src/receiver`，`dist` 启动的 remote 命令在联网前 ENOENT | build 增加 `shx cp -r src/receiver dist/receiver`；判据在构建产物上验 |
| 404 | push 不按 `config.links` / `servers.<name>.skills.include` 求交，cleanup 也用全量本地集 | push set 定义为 include（缺省 links）∩ 本地存在的 skill；cleanup 只删不在该 server push set 内的远端 skill |
| 405 | `remote_repo` 被接受但传输层硬编码 `~/.syncskill` | transport 全部路径按 `server.remote_repo ?? '~/.syncskill'` 派生 |
| 406 | `--timeout` 空操作 | 每个 server 的 remote 阶段用 `withTimeout` 包住；超时给明确错误；文档写明不 kill 子进程 |
| 407 | pull 的 rsync 无 `--delete` | pull 加 `--delete`（pre-pull backup 之后） |
| 408 | 远端调用硬编码裸 `node`、无 ConnectTimeout/BatchMode | 配置与 `remote add` 增加 `node_bin`；ssh/rsync 注入 `ConnectTimeout`、`BatchMode=yes` |
| 409 | help-output 8 处硬编码旧 checkout 路径 | 用 `import.meta.url` 推导仓库根 |
| 410 | bare 仓 HEAD 停在 `master`（依赖本机 git 默认分支） | `createGitBareRepo` 显式设 `HEAD=refs/heads/<branch>` |
| 411 | 切换兼容缺口 | 能无损映射的加别名（`--config`→`--sync-dir`、全局 `--dry-run/-y/--quiet/--force`）；语义不同的（`--on-local-deletion`）明确拒绝 + next |

## 判据（每条先见红）

- 403：`npm run build` 后 `dist/receiver/sync_receiver.mjs` 与 `bootstrap_remote.sh` 存在，且 `node dist/index.js --help` 能起。
- 404：links 只有 `linked` 时，push 的 rsync 不得出现 `unlinked`；cleanup 不删被 include 但未变化的 skill，删掉从 links 移除的远端 skill。
- 405：`remote_repo=/srv/x` 时 ssh/rsync 出现 `/srv/x`，不出现 `~/.syncskill`。
- 406：`timeout:1` + 4 s 假 exec 在 ~1 s 返回并给出超时错误。
- 407：远端删一个文件后 pull，本地该文件消失、哈希一致。
- 408：`node_bin` 生效；ssh argv 带 `-o BatchMode=yes` 与 `-o ConnectTimeout=…`。
- 409：任意 checkout 路径下 `npm test` 的 help-output 全绿。
- 410：强制 `init.defaultBranch=master` 的环境下，fixture 的 clone 仍能看到 skill。
- 411：旧脚本里的 `--config`、全局 `--dry-run/-y`、`--on-local-deletion` 各自得到「可用 / 替代 / 明确拒绝 + next」。

## 边界

- 不做 `--on-local-deletion` 的语义实现（成熟版本有，但当前模型没有对应状态；只给明确拒绝与替代路径）。
- 不引入 ssh 库；`ssh_defaults` 只支持 port/identity/ConnectTimeout/BatchMode。