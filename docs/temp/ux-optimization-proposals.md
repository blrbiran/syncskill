# Syncskill UX 优化提案

> 日期：2026-05-09
> 状态：已确认
> 基于：syncskill-design.md 评审

## 通用规则

- **所有用户交互信息使用英文**
- **`-y` 作为 `--yes` 的别名**（符合 CLI 习惯）

---

## 1. `source add` 命令简化 ✓ 已确认

### 最终设计

```
source add <url-or-path> [--name <n>] [--store <p>] [--type git|http|local] [-y/--yes]

Step 1: 检测输入类型
├─ 文件系统路径（/, ~, ./, ../, 或当前目录存在的路径）→ local
├─ github.com / gitlab.com（含 /tree/<branch> 格式，无需 .git 后缀）→ git
├─ 以 .git 结尾 → git
├─ 以 .tar.gz / .tgz / .tar.xz / .tar.bz2 / .zip 结尾 → http
├─ 其他 URL → 交互式询问 git 或 http
└─ 当前目录不存在的裸名称 → 交互式询问类型和路径

Step 2: 推断默认参数
├─ name: 从 URL/路径提取（仓库名或目录名）
├─ store: git/http → ~/.syncskill/sources/<name>
│         local → 原路径本身
└─ 显式参数 --name / --store 覆盖推断值

Step 3: 获取内容
├─ git: clone（支持 /tree/<branch> 解析为 --branch）
├─ http: 下载 + 解压
└─ local: 无需获取

Step 4: 扫描 skills
├─ 递归遍历整个目录，发现所有 SKILL.md 所在位置
├─ 分类：单 skill 目录 vs 多 skill 容器
└─ 检测重名（同一 source 内部 + 与其他 source/manual 冲突）

Step 5: 用户选择（除非 -y/--yes）
┌─────────────────────────────────────────────────────────────┐
│ Found 5 skills in repo:                                     │
│                                                             │
│ [x] skill-a        (skills/skill-a)                         │
│ [x] skill-b        (skills/skill-b)                         │
│ [ ] skill-c        (.claude/skills/skill-c)                 │
│ [x] demo-skill     (examples/demo-skill)                    │
│                                                             │
│ ⚠️  Duplicate detected:                                      │
│                                                             │
│ "skill-a" exists in 2 locations:                            │
│   (•) skills/skill-a           ← selected                   │
│   ( ) .claude/skills/skill-a                                │
│                                                             │
│ ↑↓ navigate  Space: toggle  Enter: confirm                  │
└─────────────────────────────────────────────────────────────┘

Step 5b: 与外部 source 冲突时
┌─────────────────────────────────────────────────────────────┐
│ ⚠️  Skill "demo-skill" already exists:                       │
│    Current: ~/.syncskill/skills/demo-skill (manual)         │
│    New:     ~/.syncskill/sources/repo/examples/demo-skill   │
│                                                             │
│ Choose action:                                              │
│   ( ) Keep existing, ignore new                             │
│   ( ) Use new, ignore existing                              │
│   ( ) Rename new to "demo-skill-2"                          │
└─────────────────────────────────────────────────────────────┘

Step 6: 写入配置
├─ source entry 写入 config.yaml
├─ 选中的 skills 加入 links（默认 ["*"]）
├─ 未选中的 skills 加入 skills-ignore.json
├─ 重名冲突的 skills 加入 skills-ignore.json 并记录原因
└─ 更新 skills-index.json

Step 7: -y/--yes 行为
├─ 跳过 Step 5 的交互
├─ 自动选中所有非重名的 skills
└─ 重名的自动加入 ignore（保留现有）
```

### 新增文件：`skills-ignore.json`

记录被忽略的 skill 及原因：

```json
{
  "version": 1,
  "ignored": {
    "skill-a": {
      "path": "~/.syncskill/sources/repo/.claude/skills/skill-a",
      "source": "repo",
      "reason": "duplicate",
      "kept": {
        "path": "~/.syncskill/sources/repo/skills/skill-a",
        "source": "repo"
      },
      "ignored_at": "2026-05-09T10:00:00Z"
    }
  }
}
```

---

## 2. 同仓库合并逻辑简化 ✓ 已确认

### 最终设计

**废弃原 spec 的 4 种场景**，统一为：

第一次 clone 仓库时，扫描整个仓库发现所有 skills（无论在哪个目录）。用户选择后，选中的加入 links，未选中的加入 skills-ignore.json。

后续添加同仓库的其他 skill 时：

```
source add https://github.com/org/repo/tree/main/examples/demo-skill

Step 1: 解析 URL → repo = github.com/org/repo, path = examples/demo-skill

Step 2: 检测到 repo 已存在 source "repo"
        Store: ~/.syncskill/sources/repo (已 clone)

Step 3: 检查 examples/demo-skill
        ├─ 在 ignore 列表中 → 从 ignore 移除，加入 links
        ├─ 已在 links 中 → 提示 "Skill already added"
        └─ 路径不存在 → 先 git pull 更新，再检查

Step 4: 完成
        ✓ Added "demo-skill" from existing source "repo"
```

---

## 3. Push 默认行为安全化 ✓ 已确认

### 最终设计

无参数时显示服务器列表让用户选择，第一个选项是"推送到所有服务器"：

```
syncskill push

Select servers to push:
  [x] All servers
  [ ] prod-server
  [ ] dev-server
  [ ] staging

↑↓ navigate  Space: toggle  Enter: confirm
```

或直接指定：
```bash
syncskill push dev-server    # 推送到指定服务器
syncskill push --all         # 推送到所有服务器（无需交互）
```

---

## 4. `link` 与 `config link` 命令统一 ✓ 已确认

### 最终设计

```bash
syncskill link                    # 进入矩阵编辑器
syncskill link --edit             # 同上（显式参数）
syncskill link <skill>            # 交互式选择该 skill 链接到哪些 agents
syncskill link <skill> --all      # 链接到所有 agents
syncskill link <skill> --agents claude,hermes  # 链接到指定 agents
syncskill link --status           # 显示所有链接状态
syncskill link --unlink <skill>   # 移除链接
```

**废弃**：`config link` 命令（或保留为别名）

---

## 5. `refresh` 默认行为 ✓ 保持原设计

### 最终设计

```bash
syncskill refresh          # --all + --status（刷新所有，然后显示状态）
syncskill refresh --local  # 只刷新本地 hash
syncskill refresh --remote # SSH 刷新远程 hash
syncskill refresh --all    # 刷新本地 + 远程（不显示状态）
syncskill refresh --status # 仅显示状态，不刷新
```

**设计理由**：refresh 的语义就是"刷新"，用户运行此命令时期望获取最新状态。

---

## 6. `resolve` 命令语法简化 ✓ 已确认

### 最终设计

```bash
syncskill resolve <skill> local     # 本地覆盖远程
syncskill resolve <skill> remote    # 远程覆盖本地
syncskill resolve <skill> --manual  # 手动模式，生成 .sync-conflict 文件
syncskill resolve <skill> --diff    # 显示差异
```

位置参数比 `--take` flag 更简洁直观。

---

## 7. 新增 `--dry-run` 预览功能 ✓ 已确认

### 最终设计

为以下命令添加 `--dry-run` 选项：

```bash
syncskill push --dry-run [server]
syncskill pull --dry-run [server]
syncskill sync --dry-run [server]
syncskill link --all --dry-run
syncskill source add <url> --dry-run
```

**输出格式**：

```
[dry-run] push to dev-server:

  skill-one:
    + file1.md (new)
    ~ file2.ts (modified, 42 lines changed)
    - old-file.js (deleted)

  skill-two:
    (no changes)

Summary: 1 skill changed, 2 files added, 1 file modified, 1 file deleted
```

---

## 8. `discover` 与 `init` 职责明确化 ✓ 已确认

### 最终设计

| 命令 | 职责 |
|------|------|
| `init` | 创建目录结构 + 自动迁移已有 skills（一次性操作） |
| `discover` | 扫描 sources + agent 目录，发现新 skill 后询问用户是否迁移 |

**discover 行为**：
```
Scanning for new skills...

Found 2 new skills in sources:
  ✓ Added "new-skill-1" from source "my-repo"
  ✓ Added "new-skill-2" from source "my-repo"

Found 1 unmanaged skill in agent directories:
  ~/.claude/skills/local-experiment

Migrate to ~/.syncskill/skills/? [Y/n]
```

- 扫描 sources → 发现新 skill → 直接注册到 links
- 扫描 ~/.syncskill/skills/ → 发现新 skill → 直接注册到 links
- 扫描 agent 目录 → 发现未纳管的 skill → **询问用户**是否迁移

---

## 9. 其他小优化 ✓ 已确认

### 9.1 `source remove` 统一选项

统一显示所有选项，不适用的标记为 disabled：

```
Removing source "my-skill" (type: git)

Choose action:
  1. Convert to local source (keep files, no more git)
  2. Remove config only (keep files, becomes manual)
  3. Remove completely (config + files)
  [disabled] 4. ... (only for HTTP type)
```

### 9.2 多服务器提示时机扩展

在 `server add` 添加第 3+ 个服务器时也提示：

```
✓ Added server "staging"

Note: With 3+ servers, auto-refresh may be slow.
Use --no-refresh to skip, then run `syncskill refresh` manually.
```

### 9.3 矩阵编辑器快捷键增强

| 快捷键 | 功能 |
|--------|------|
| `↑/↓` | 上下移动行光标 |
| `←/→` | 左右移动列光标 |
| `Space` | 切换当前单元格 |
| `Tab` | 切换并移到下一列 |
| `a` | 全选/全不选当前行 |
| `A` (Shift+A) | 全选/全不选当前列 |
| `/` | 搜索 skill 名称并跳转 |
| `g` | 跳转到第一行 |
| `G` | 跳转到最后一行 |
| `Page Up/Down` 或 `n/p` | 翻页 |
| `Enter` | 保存并退出 |
| `Escape` | 返回上一级 |

---

## 实施优先级

| 优先级 | 提案 | 状态 |
|--------|------|------|
| P0 | #3 Push 安全化 | ✓ 已确认 |
| P0 | #7 --dry-run | ✓ 已确认 |
| P1 | #1 source add 简化 | ✓ 已确认 |
| P1 | #6 resolve 语法简化 | ✓ 已确认 |
| P2 | #4 link 命令统一 | ✓ 已确认 |
| P2 | #5 refresh 默认行为 | ✓ 保持原设计 |
| P2 | #8 discover/init 分离 | ✓ 已确认 |
| P2 | #2 同仓库合并简化 | ✓ 已确认 |
| P3 | #9 小优化 | ✓ 已确认 |
