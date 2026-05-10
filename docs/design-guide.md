# Design Guide

## Architecture Overview

The system is split so each layer has one primary concern:

| Layer | Module | Responsibility |
|-------|--------|----------------|
| CLI | `src/index.ts` | Command parsing, option handling, user-facing descriptions |
| Config | `src/config.ts`, `src/config-ui.ts` | Config loading, saving, validation, interactive editing |
| Repository | `src/repo.ts` | Local repository initialization under `~/.syncskill/` |
| Linking | `src/linker.ts` | Symlink management with three-level fallback |
| Manifest | `src/manifest.ts` | Skill hashing, manifest persistence, history tracking |
| Conflict | `src/conflict.ts` | Delta classification, status/diff derivation, resolution |
| Sources | `src/source.ts` | External source management (git/http/local) |
| Transport | `src/transport.ts` | SSH/rsync primitives, receiver deployment |
| Sync | `src/sync_engine.ts` | Push/pull/sync orchestration across servers |

## Module Boundaries

### `src/index.ts`

Owns CLI registration, command parsing, option handling, and human-facing command descriptions. Wires subcommands to implementation modules without owning storage or transport details.

### `src/config.ts`

Owns config path helpers, config loading and saving, default config generation, validation, dotted-path updates, and server lookup helpers.

### `src/config-ui.ts`

Owns interactive TUI for config editing using `@inquirer/prompts` and `@inquirer/core`. Implements:

- Main configuration menu (agents, links, servers, sources, remote, conflict_resolution)
- Matrix editor for skill-to-agent and skill-to-server mappings
- Server management with SSH config parsing

### `src/matrix-editor.ts`

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

Also owns status checking, unlinking, and skill discovery scanning.

### `src/manifest.ts`

Owns local skill hashing (MD5, compatible with Python/Hermes), manifest persistence, manifest history persistence, and helpers that update recorded local and remote hashes.

Hash algorithm:
- Traverse skill directory with sorted file list
- For each file: `md5.update(relativePath_utf8 + fileContent)`
- Ignore directories and symlinks (uses `lstatSync`)
- Returns 32-character hex digest

### `src/conflict.ts`

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

### `src/skills-registry.ts`

Owns the unified skills registry that tracks all skills' origin mapping and ignore status.

### `src/transport.ts`

Owns SSH and rsync transport primitives, remote receiver deployment, remote manifest exchange, and receiver fallback coordination. Symlink handling:
- rsync: `-a` preserves symlinks
- scp fallback: JSON format `{files, symlinks}` with security validation

### `src/sync_engine.ts`

Owns push, pull, and sync orchestration across configured servers. Combines config loading, manifest preparation, conflict policy application, transport operations, and manifest persistence.

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
| Compression | `node:zlib` + `node:stream` |
| HTTP download | `fetch()` (Node 18+ native) |
| File sync | rsync preferred, Node fs fallback |
| SSH | `child_process.exec('ssh')` |
| Git | `child_process.exec('git')` |
| Symlinks | `fs.symlink()` -> junction -> `fs.cp()` |
