# Configuration Guide

`syncskill` stores its runtime state under `~/.syncskill/` by default. The main configuration file is `~/.syncskill/config.json`.

You can override these locations with environment variables:

- `SYNCSKILL_DIR` - override the runtime directory root
- `SYNCSKILL_CONFIG` - override the config file path

Note: v2 uses JSON-only config. If you still have an older `config.yaml`, any config write operation automatically migrates it to `config.json` and removes the legacy YAML file.

## AI Agent Integration

For automation and agent handoff workflows, combine the JSON config format with the v2 global execution flags:

```bash
# Stream machine-readable events
syncskill --json status

# Refuse prompts in CI or agent runs
syncskill --no-interactive link build

# Generate a plan, save it, and execute it
syncskill --plan install self > /tmp/syncskill.plan.json

# Execute a saved plan later
syncskill --apply /tmp/syncskill.plan.json
```

Use `--resolutions <path>` when a generated plan contains unresolved items that should be answered by another agent or approval step.

Environment variables also support automation:

- `SYNCSKILL_JSON` - enable JSONL output mode
- `SYNCSKILL_NO_INTERACTIVE` - disable prompts
- `SYNCSKILL_STRICT` - treat partial skip results as exit code 6 when set to `1`
- `SYNCSKILL_PULL_BACKUP` - disable (`0`) or force (`1`) local pre-pull backups for `pull` / `sync`

## Directory Structure

Default layout:

```
~/.syncskill/
├── config.json                    # User configuration
├── skills/                        # Manually managed skills
├── .sources/                      # Internal source state and materialized checkouts
├── manifests/                     # Per-server sync state (JSON per server)
│   └── <server>.json
├── receivers/                     # Per-server receiver backups discovered from remote scans
│   └── <server>.json
├── manifest_history.json          # Hash change history
├── skills-registry.json           # Skill registry metadata
├── .backups/                      # Sidecar backups from update/pull/sync/restore protection
│   ├── sources/
│   │   └── <source-name>/pre-update/
│   └── skills/
│       └── <skill-name>/
│           ├── pre-pull/
│           └── pre-restore/
└── .tmp/                          # Temporary files (auto-cleaned)
```

If `SYNCSKILL_DIR` is set, the same structure is created under that directory instead.

Backup notes:

- `~/.syncskill/.backups/sources/<source-name>/pre-update/` stores the previous materialized source contents before a forced top-level `update --force` overwrite.
- `~/.syncskill/.backups/skills/<skill-name>/pre-pull/` stores the latest local skill snapshot before `pull` or `sync` overwrites that skill locally. This is enabled by default, can be disabled via `config.pull_backup: false` or `SYNCSKILL_PULL_BACKUP=0`, and can be forced with `SYNCSKILL_PULL_BACKUP=1`.
- `~/.syncskill/.backups/skills/<skill-name>/pre-restore/` stores the current local skill state immediately before `restore <skill>` replays the latest pre-pull backup.

## Configuration Shape

The config model includes these top-level keys:

- `version` - Configuration schema version
- `conflict_resolution` - Default conflict resolution strategy
- `agents` - Local agent directory mappings
- `private_agents` - Agents that need dedicated links instead of the shared `~/.agents/skills/` target
- `links` - Skill to agent link mappings
- `servers` - Remote server configurations
- `sources` - External skill sources

## Example

The top-level config object includes keys such as `version`, `conflict_resolution`, `agents`, `private_agents`, `links`, `servers`, and `sources`.

```json
{
  "version": 1,
  "conflict_resolution": "manual",
  "agents": {
    "claude": "/Users/alice/.claude/skills",
    "qoder": "/Users/alice/.qoder/skills"
  },
  "links": {
    "welcome": ["*"],
    "release-checklist": ["claude", "qoder"]
  },
  "servers": {
    "alpha": {
      "host": "alpha.example.com",
      "user": "alice",
      "port": 22,
      "identity_file": "/Users/alice/.ssh/id_ed25519",
      "remote_agents": {
        "claude": "/home/alice/.claude/skills",
        "qoder": "/home/alice/.qoder/skills"
      }
    }
  },
  "sources": {
    "internal-playbooks": {
      "type": "git",
      "url": "https://github.com/org/internal-playbooks.git",
      "path": "skills",
      "branch": "main"
    },
    "local-experiments": {
      "type": "local",
      "url": "/Users/alice/dev/local-skills",
      "path": "."
    }
  }
}
```

## Fields

### `version`

Configuration schema version. The current implementation uses `version: 1`.

### `conflict_resolution`

Default reconciliation policy for manifest conflicts.

Supported values:

- `manual` - Keep conflicts unresolved until you inspect them with `status`, `diff`, and `resolve`
- `keep-local` - Auto-resolve conflicts in favor of the local skill tree during sync operations
- `keep-remote` - Auto-resolve conflicts in favor of the remote server state during sync operations

### `agents`

Maps local agent names to their skill directories. `syncskill init` auto-detects known agent homes:

- `claude` -> `~/.claude/skills`
- `agents` -> `~/.agents/skills`
- `cursor` -> `~/.cursor/skills`
- `windsurf` -> `~/.windsurf/skills`
- `codex` -> `~/.codex/skills`
- `gemini` -> `~/.gemini/skills`
- `antigravity` -> `~/.gemini/antigravity/skills`
- `kiro` -> `~/.kiro/skills`
- `augment` -> `~/.augment/skills`
- `amp` -> `~/.config/agents/skills`
- `cline` -> `~/.cline/skills`
- `opencode` -> `~/.config/opencode/skills`
- `qwen` -> `~/.qwen/skills`
- `openclaw` -> `~/.openclaw/skills`
- `hermes` -> `~/.hermes/skills`
- `qoder` -> `~/.qoder/skills`
- `aone_copilot` -> `~/.aone_copilot/skills`

Example:

```json
{
  "agents": {
    "claude": "/Users/alice/.claude/skills",
    "qoder": "/Users/alice/.qoder/skills"
  }
}
```

### `private_agents`

Lists agents that do not read from the shared `~/.agents/skills/` directory and therefore need individual links into their own skill homes.

These agents do not read the shared `~/.agents/skills/` directory. You need to create separate links under each agent's own skills directory, and `link list` marks private agents with `*` (for example, `claude*`).

Default value:

```json
{
  "private_agents": [
    "claude",
    "codex",
    "gemini",
    "cursor",
    "kiro",
    "augment",
    "cline",
    "hermes"
  ]
}
```

This field uses full override semantics. If you set `private_agents` in `config.json`, your list replaces the built-in defaults instead of merging with them.

### `links`

Maps each managed skill name to one or more target agents. `syncskill link` edits this configured target matrix, and `syncskill link` / `link edit` show configured intent rather than current filesystem state. `syncskill link list` / `link ls` separately reports the realized on-disk state under each agent directory.

Use `["*"]` to link a skill to all configured agents.

Example:

```json
{
  "links": {
    "welcome": ["*"],
    "release-checklist": ["claude", "qoder"]
  }
}
```

When saving via the matrix editor, if a skill is linked to all agents, it is automatically saved as `["*"]` rather than listing all agent names.

#### Config vs Actual Symlinks

The `links` configuration defines *desired* state, not actual symlinks. Modifying `config.links` (via `link set`, `link add`, `link remove`, `link clear`, or the matrix editor) only updates `config.json` — it does not create or remove symlinks immediately.

To synchronize actual symlinks with the configuration, run the `link build` subcommand:

```bash
# Reconcile all links
syncskill link build
```

The `link build` command performs reconciliation:

1. **Creates missing links** — symlinks defined in config but not present on disk
2. **Removes stale links** — symlinks on disk that are no longer in config

Stale link removal requires confirmation by default. Use flags to control this:

```bash
# Preview what would change without making changes
syncskill link build --dry-run

# Auto-confirm stale link removal
syncskill link build -y
```

Example workflow:

```bash
# 1. Update desired links in config.json
syncskill link set my-skill claude

# 2. Preview the reconciliation
syncskill link build --dry-run
# Output: Would remove stale link: /Users/alice/.qoder/skills/my-skill

# 3. Apply the change
syncskill link build
# Prompts: Remove stale link /Users/alice/.qoder/skills/my-skill? [y/N]
```

### `servers`

Defines named remote sync targets used by `diff`, `push`, `pull`, `sync`, `remote add/rm/list`, and `refresh --remote`.

Each server entry supports:

| Field | Required | Description |
|-------|----------|-------------|
| `host` | Yes | Hostname or IP address |
| `user` | No | SSH username (defaults to current user) |
| `port` | No | SSH port (defaults to 22) |
| `identity_file` | No | Path to SSH private key |
| `remote_repo` | No | Remote syncskill repository path |
| `remote_agents` | No | Agent directory mappings on the remote server |

Example:

```json
{
  "servers": {
    "alpha": {
      "host": "alpha.example.com",
      "user": "alice",
      "port": 22,
      "identity_file": "~/.ssh/id_ed25519",
      "remote_repo": "/srv/syncskill",
      "remote_agents": {
        "claude": "/home/alice/.claude/skills",
        "qoder": "/home/alice/.qoder/skills"
      }
    }
  }
}
```

Remote lifecycle notes:

- `config show` or direct inspection of `~/.syncskill/config.json` is the source of truth for configured transport fields such as `host`, optional `user`, optional `port`, optional `identity_file`, optional `remote_repo`, and configured `remote_agents`
- `refresh --remote <server>` scans the configured `remote_agents` roots and updates `~/.syncskill/receivers/<server>.json` from the real remote skill directories
- `remote show <name>` prints the local receiver backup for one remote (`version`, `server`, `updated_at`, `remote_agents`, `links`)
- If a configured remote agent root path does not exist, `refresh --remote` fails instead of treating the remote skill tree as empty

### `sources`

Defines external skill sources that can materialize content into the local sync repository.

In v2, new sources are added with `syncskill install <url-or-path>`. The old `source add`, `source update`, and `source restore` commands were removed; use top-level `update` to refresh sources.

Supported source types:

| Type | Description |
|------|-------------|
| `local` | Local filesystem directory |
| `git` | Git repository materialized under `~/.syncskill/.sources/<name>/checkout/` |
| `http` | HTTP archive (`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`) |

Each source entry includes:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Source type (`local`, `git`, `http`) |
| `url` | Varies | Remote URL (required for git/http) |
| `path` | Yes | Relative subdirectory containing skills (use `.` for the source root) |
| `branch` | No | Git branch or tag (git sources only) |
| `ignore` | No | List of skill names to ignore |
| `archive_path` | No | Original archive file path (local archives only) |

The `path` field specifies where skills are located within the materialized source root:
- For git/http sources: a repo-relative subdirectory within the checkout (for example `skills`, `examples/skills`, or `.` for the checkout root)
- For local sources: a relative subdirectory within the local source root pointed to by `url` (for example `skills` or `.`)

Example:

```json
{
  "sources": {
    "vendor-docs": {
      "type": "git",
      "url": "https://github.com/org/vendor-docs.git",
      "path": "skills",
      "branch": "stable"
    },
    "repo-root": {
      "type": "git",
      "url": "https://github.com/org/skill-repo.git",
      "path": ".",
      "branch": "main"
    },
    "local-dev": {
      "type": "local",
      "url": "~/dev/skills",
      "path": "."
    },
    "archive-skills": {
      "type": "local",
      "url": "~/.syncskill/.sources/archive-skills/checkout",
      "path": ".",
      "archive_path": "~/Downloads/my-skills.tar.gz"
    }
  }
}
```

## Skills Registry

The current v2 `skills-registry.json` stores only HTTP dirty-detection baselines. Ignored state lives in `config.sources[*].ignore[]`, and active skill ownership is derived from config plus the materialized filesystem state:

```json
{
  "version": 2,
  "http_baselines": {
    "vendor-skill": {
      "hash": "abc123def456",
      "source": "vendor-docs"
    }
  }
}
```

## Manifest Format (3-field model)

Each server manifest (`~/.syncskill/manifests/<server>.json`) tracks sync state:

```json
{
  "version": 1,
  "server": "server-name",
  "updated_at": "2026-05-15T00:00:00Z",
  "skills": {
    "skill-name": {
      "local_hash": "abc123...",
      "remote_hash": "def456...",
      "recorded_hash": "abc123...",
      "direction": "conflict",
      "status": "conflict",
      "forced_conflict": true
    }
  }
}
```

**3-field model explanation:**
- `local_hash`: Current local file hash (recomputed on each refresh)
- `remote_hash`: Last known remote hash (fetched from remote manifest)
- `recorded_hash`: Baseline hash from last sync point (set after push/pull completes)
- `forced_conflict`: Optional sticky flag persisted only when `true`; used by `restore <skill>` so the manifest stays in `conflict` until a follow-up resolution clears it

The `recorded_hash` serves as a 3-way merge base:
- `local_hash ≠ recorded_hash` → Local changed since last sync
- `remote_hash ≠ recorded_hash` → Remote changed since last sync
- Both differ → Conflict

This design handles external operations (like `git checkout`) correctly: even if local files are reverted, `recorded_hash` remains unchanged, so the system detects the local change.

## Exit Codes

CLI commands use the following exit codes:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Invalid arguments |
| `3` | Config or registry corruption |
| `4` | Permission error |
| `5` | Sync conflict |
| `6` | Source dirty |
| `7` | Network error |
| `8` | User abort |

## Install from Source

To install from source during local development:

```bash
npm install
npm run build
npm link
syncskill --help
```

You can also run the built entrypoint directly:

```bash
node dist/index.js --help
```
