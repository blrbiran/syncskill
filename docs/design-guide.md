# Design Guide

## Architecture Overview

The system is split so each layer has one primary concern:

| Layer | Module | Responsibility |
|-------|--------|----------------|
| CLI | `src/index.ts` | Command parsing, option handling, user-facing descriptions |
| Config | `src/config/config.ts`, `src/config/config-ui.ts` | Config loading, saving, validation, interactive editing |
| Config Doctor | `src/config/config-doctor.ts` | Configuration diagnosis and repair |
| Matrix Editor | `src/config/matrix-editor.ts` | 2D matrix editor component |
| Repository | `src/repo.ts` | Local repository initialization under `~/.syncskill/` |
| Linking | `src/linker.ts` | Symlink management with three-level fallback |
| Manifest | `src/core/manifest.ts` | Skill hashing, manifest persistence, history tracking |
| Conflict | `src/core/conflict.ts` | Delta classification, status/diff derivation, resolution |
| Sources | `src/source.ts` | External source management (git/http/local) |
| Transport | `src/core/transport.ts` | SSH/rsync primitives, receiver deployment |
| Sync | `src/core/sync_engine.ts` | Push/pull/sync orchestration across servers |
| Registry | `src/core/skills-registry.ts` | Unified skills registry (origin mapping + ignore status) |
| Archive | `src/utils/archive.ts` | Archive format detection and extraction |
| Backup | `src/utils/backup.ts` | Backup management for --force updates |

## Module Boundaries

### `src/index.ts`

Owns CLI registration, command parsing, option handling, and human-facing command descriptions. Wires subcommands to implementation modules without owning storage or transport details.

### `src/config/config.ts`

Owns config path helpers, config loading and saving, default config generation, validation, dotted-path updates, and server lookup helpers.

### `src/config/config-ui.ts`

Owns interactive TUI for config editing using `@inquirer/prompts` and `@inquirer/core`. Implements:

- Main configuration menu (agents, links, servers, sources, remote, conflict_resolution)
- Matrix editor for skill-to-agent and skill-to-server mappings
- Server management with SSH config parsing

### `src/config/config-doctor.ts`

Owns configuration diagnosis and repair. Checks for invalid agents, missing skills in links, stale registry entries, and provides interactive repair via `syncskill doctor --fix`.

### `src/config/matrix-editor.ts`

Implements the two-dimensional matrix editor component using `@inquirer/core` createPrompt:

| Key | Function |
|-----|----------|
| `↑/↓` | Navigate rows |
| `←/→` | Navigate columns |
| `Space` | Toggle cell |
| `Tab` | Toggle and move to next column |
| `r` | Toggle entire row |
| `c` | Toggle entire column |
| `/` | Search skill name |
| `g/G` | Jump to first/last row |
| `Page Up/Down` or `n/p` | Paginate |
| `Enter` | Save and exit |
| `Escape` | Return to previous menu |

### `src/repo.ts`

Owns local repository initialization under `~/.syncskill/`, initial config bootstrapping, copying the example config, and first-run migration of detected local skills.

### `src/linker.ts`

Owns symlink creation with three-level fallback:

1. `fs.symlink()` - Standard symlink
2. `fs.symlink(target, link, 'junction')` - Windows junction
3. `fs.cp(source, target, { recursive: true })` - Copy with warning

Also owns status checking, unlinking, skill discovery scanning, and **stale link reconciliation**.

#### Reconcile Architecture

The `reconcileStaleLinks()` function cleans up orphaned symlinks after configuration changes. It returns a `ReconcileResult`:

```typescript
interface ReconcileResult {
  removed: string[];   // paths successfully cleaned up
  skipped: string[];   // paths skipped (not syncskill managed)
  errors: string[];    // paths that failed to remove
}
```

**Cleanup Rules:**

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Real directory (not symlink) | Skip | User-managed content, never touch |
| Symlink pointing outside `~/.syncskill/` | Skip | Not syncskill-managed |
| Symlink to skill no longer in config | Remove | Source was removed entirely |
| Symlink to skill, but agent not in targets | Remove | Agent removed from skill's link targets |
| Valid symlink matching current config | Keep | Still active |

**Safety Guarantees:**

1. **Only touches syncskill-managed symlinks** - A symlink is considered "managed" only if it points to a path under `~/.syncskill/skills/` or `~/.syncskill/sources/`. External symlinks are never modified.

2. **Never deletes real directories** - Uses `lstatSync()` to distinguish symlinks from directories. Real directories are always skipped, even if they have the same name as a skill.

3. **Graceful error handling** - If removal fails (permissions, locked file), the path is added to `errors[]` and processing continues. No partial failures cause full abort.

**Staleness Detection:**

A symlink becomes "stale" when:
- The skill it points to was removed from config (source deleted)
- The agent directory is no longer in the skill's `links[skill].agents` list
- The source containing the skill was removed via `syncskill source remove`

**Integration Points:**

| Command | Reconcile Behavior |
|---------|-------------------|
| `syncskill link` | Calls `reconcileStaleLinks()` after creating new links |
| `syncskill source remove` | Option 3 ("remove source + clean links") reuses reconcile logic |
| `syncskill doctor --fix` | Can trigger reconcile for detected stale links |

### `src/core/manifest.ts`

Owns local skill hashing (MD5, compatible with Python/Hermes), manifest persistence, manifest history persistence, and helpers that update recorded local and remote hashes.

Hash algorithm:
- Traverse skill directory with sorted file list
- For each file: `md5.update(relativePath_utf8 + fileContent)`
- Ignore directories and symlinks (uses `lstatSync`)
- Returns 32-character hex digest

### `src/core/conflict.ts`

Owns manifest delta classification, status and diff row derivation, and explicit conflict resolution logic.

Delta classification:
- local = recorded, remote = recorded -> skip
- local != recorded, remote = recorded -> push
- local = recorded, remote != recorded -> pull
- local != recorded, remote != recorded -> conflict
- new skill -> new/push

### `src/source.ts`

Owns configured source definitions, source materialization, source state tracking, and ownership checks for skills imported from local, git, or http sources.

Git sources: Auto-detect default branch via `git ls-remote --symref`, then `git clone --single-branch --depth 1`.

### `src/core/skills-registry.ts`

Owns the unified skills registry that tracks all skills' origin mapping and ignore status.

### `src/core/transport.ts`

Owns SSH and rsync transport primitives, remote receiver deployment, remote manifest exchange, and receiver fallback coordination.

rsync behavior:
- **Push**: Uses `rsync -az --delete` to ensure remote matches local exactly
- **Pull**: Uses `rsync -az` (NO `--delete`) to protect local unmanaged files

Symlink handling:
- rsync: `-a` preserves symlinks
- scp fallback: JSON format `{files, symlinks}` with security validation

### `src/core/sync_engine.ts`

Owns push, pull, and sync orchestration across configured servers. Combines config loading, manifest preparation, conflict policy application, transport operations, and manifest persistence.

### `src/utils/archive.ts`

Owns archive format detection and extraction. Supports `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`. Uses `compressing` npm package with CLI fallback for formats not supported by the library.

### `src/utils/backup.ts`

Owns backup management for `--force` updates. Backs up dirty skills to `~/.syncskill/backups/<source>/<skill>/` with metadata in `_meta.json`.

### `src/receiver/`

Remote-side scripts deployed to `~/.syncskill/` on remote servers:

- `bootstrap_remote.sh` - Creates directory structure, ensures Node availability
- `sync_receiver.mjs` - Zero-dependency ESM script that applies synced skills and manages remote symlinks

## State Model

Local state lives under `~/.syncskill/`:

| Path | Purpose |
|------|---------|
| `config.yaml` | User configuration |
| `skills/` | Manually managed skills |
| `sources/` | Cloned git/http sources |
| `manifests/<server>.json` | Per-server reconciliation snapshots |
| `manifest_history.json` | Hash change audit trail |
| `skills-registry.json` | Skill origin and status tracking |

Remote synchronization exchanges skill trees plus manifest state, while transport details remain isolated from conflict and orchestration logic.

## Sync Protocol

```
Phase 1: PREPARE & COMPARE
  ├─ Calculate local manifest (MD5 hash)
  ├─ Fetch remote manifest.json
  ├─ Compare hashes -> delta
  └─ Detect conflicts

Phase 2: TRANSPORT (rsync)
  ├─ Check remote receiver -> deploy if missing
  ├─ rsync -avz push changes -> remote ~/.syncskill/skills/
  └─ Fallback to Node file-by-file transfer if no rsync

Phase 3: RECONCILE (remote receiver)
  ├─ SSH exec "node ~/.syncskill/sync_receiver.mjs apply"
  ├─ Create/update agent directory symlinks
  ├─ Update both manifests
  └─ Fetch final manifest for confirmation
```

## Cross-Platform Strategy

| Scenario | Strategy |
|----------|----------|
| Path handling | `node:path` auto-adapts `/` and `\` |
| Compression | `compressing` npm package (tar.gz/zip) -> CLI fallback (bz2/xz) |
| HTTP download | `fetch()` (Node 18+ native) |
| File sync | rsync preferred, Node fs fallback |
| SSH | `child_process.exec('ssh')` |
| Git | `child_process.exec('git')` |
| Symlinks | `fs.symlink()` -> junction -> `fs.cp()` |
