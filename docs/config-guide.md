# Configuration Guide

`syncskill` stores its runtime state under `~/.syncskill/`. The main configuration file is `~/.syncskill/config.yaml`.

## Directory Structure

```
~/.syncskill/
├── config.yaml                    # User configuration
├── skills/                        # Manually managed skills
├── sources/                       # Cloned git/http sources
├── manifests/                     # Per-server sync state (JSON per server)
│   └── <server>.json
├── manifest_history.json          # Hash change history
├── skills-registry.json           # Skill registry (source mapping + ignore status)
├── backups/                       # Backups from --force updates
│   └── <source-name>/
│       ├── <skill-name>/          # Latest backup per skill
│       └── _meta.json             # Backup metadata
└── .tmp/                          # Temporary files (auto-cleaned)
```

## Configuration Shape

The config model includes these top-level keys:

- `version` - Configuration schema version
- `conflict_resolution` - Default conflict resolution strategy
- `agents` - Local agent directory mappings
- `links` - Skill to agent link mappings
- `servers` - Remote server configurations
- `sources` - External skill sources

## Example

```yaml
version: 1
conflict_resolution: manual
agents:
  claude: /Users/alice/.claude/skills
  qoder: /Users/alice/.qoder/skills
links:
  welcome:
    - "*"
  release-checklist:
    - claude
    - qoder
servers:
  alpha:
    host: alpha.example.com
    user: alice
    port: 22
    identity_file: /Users/alice/.ssh/id_ed25519
    remote_agents:
      claude: /home/alice/.claude/skills
      qoder: /home/alice/.qoder/skills
sources:
  internal-playbooks:
    type: git
    url: https://github.com/org/internal-playbooks.git
    path: skills
    branch: main
  local-experiments:
    type: local
    url: /Users/alice/dev/local-skills
    path: .
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

```yaml
agents:
  claude: /Users/alice/.claude/skills
  qoder: /Users/alice/.qoder/skills
```

### `links`

Maps each managed skill name to one or more target agents. `syncskill link` uses this mapping to create links from `~/.syncskill/skills/<skill>` into each configured agent directory.

Use `["*"]` to link a skill to all configured agents.

Example:

```yaml
links:
  welcome:
    - "*"
  release-checklist:
    - claude
    - qoder
```

When saving via the matrix editor, if a skill is linked to all agents, it is automatically saved as `["*"]` rather than listing all agent names.

#### Config vs Actual Symlinks

The `links` configuration defines *desired* state, not actual symlinks. Modifying `config.links` (via `config set` or the matrix editor) only updates the YAML file — it does not create or remove symlinks immediately.

To synchronize actual symlinks with the configuration, run the `link` command:

```bash
# Reconcile links for a specific skill
syncskill link my-skill

# Reconcile all links
syncskill link --all
```

The `link` command performs reconciliation:

1. **Creates missing links** — symlinks defined in config but not present on disk
2. **Removes stale links** — symlinks on disk that are no longer in config

Stale link removal requires confirmation by default. Use flags to control this:

```bash
# Preview what would change without making changes
syncskill link --all --dry-run

# Auto-confirm stale link removal
syncskill link --all -y
```

Example workflow:

```bash
# 1. Edit config to remove 'qoder' from 'my-skill' links
syncskill config set links.my-skill '["claude"]'

# 2. Preview the reconciliation
syncskill link my-skill --dry-run
# Output: Would remove stale link: /Users/alice/.qoder/skills/my-skill

# 3. Apply the change
syncskill link my-skill
# Prompts: Remove stale link /Users/alice/.qoder/skills/my-skill? [y/N]
```

### `servers`

Defines named remote sync targets used by `diff`, `push`, `pull`, `sync`, `server show`, `server probe`, and `refresh --remote`.

Each server entry supports:

| Field | Required | Description |
|-------|----------|-------------|
| `host` | Yes | Hostname or IP address |
| `user` | No | SSH username (defaults to current user) |
| `port` | No | SSH port (defaults to 22) |
| `identity_file` | No | Path to SSH private key |
| `remote_agents` | No | Agent directory mappings on the remote server |

Example:

```yaml
servers:
  alpha:
    host: alpha.example.com
    user: alice
    port: 22
    identity_file: ~/.ssh/id_ed25519
    remote_agents:
      claude: /home/alice/.claude/skills
      qoder: /home/alice/.qoder/skills
```

Remote lifecycle notes:

- `server show <name>` prints the configured `host`, optional `user`, optional `port`, optional `identity_file`, and each configured `remote_agents` path
- `server probe <name>` validates transport reachability, receiver availability, manifest access, and the configured remote agent roots
- `refresh --remote <server>` scans the configured `remote_agents` roots and rebuilds remote manifest state from the real remote skill directories
- If a configured remote agent root path does not exist, `refresh --remote` fails instead of treating the remote skill tree as empty

### `sources`

Defines external skill sources that can materialize content into the local sync repository.

Supported source types:

| Type | Description |
|------|-------------|
| `local` | Local filesystem directory |
| `git` | Git repository (cloned to `~/.syncskill/sources/`) |
| `http` | HTTP archive (`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`) |

Each source entry includes:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Source type (`local`, `git`, `http`) |
| `url` | Varies | Remote URL (required for git/http) |
| `path` | Yes | Subdirectory within checkout containing skills (use `.` for repo root) |
| `branch` | No | Git branch or tag (git sources only) |
| `ignore` | No | List of skill names to ignore |
| `archive_path` | No | Original archive file path (local archives only) |

The `path` field specifies where skills are located within the source:
- For git/http sources: subdirectory within the checkout (e.g., `skills`, `examples/skills`, or `.` for root)
- For local sources: the absolute path to the skills directory

Example:

```yaml
sources:
  vendor-docs:
    type: git
    url: https://github.com/org/vendor-docs.git
    path: skills              # skills are in the 'skills/' subdirectory
    branch: stable
  repo-root:
    type: git
    url: https://github.com/org/skill-repo.git
    path: .                   # skills are at repo root
    branch: main
  local-dev:
    type: local
    path: /Users/alice/dev/skills
  archive-skills:
    type: local
    path: ~/.syncskill/sources/archive-skills
    archive_path: ~/Downloads/my-skills.tar.gz
```

## Skills Registry

The `skills-registry.json` file tracks the origin and status of all skills:

```json
{
  "version": 1,
  "skills": {
    "manual-skill": {
      "path": "~/.syncskill/skills/manual-skill",
      "origin": "manual",
      "type": "manual",
      "status": "active"
    },
    "source-skill": {
      "path": "~/.syncskill/sources/my-repo/.claude/source-skill",
      "origin": "my-repo",
      "type": "git",
      "status": "active"
    },
    "ignored-skill": {
      "path": "~/.syncskill/sources/repo/.claude/skills/ignored-skill",
      "origin": "repo",
      "type": "git",
      "status": "ignored",
      "ignored_reason": "duplicate",
      "ignored_at": "2026-05-09T10:00:00Z",
      "kept_by": "~/.syncskill/sources/repo/skills/ignored-skill"
    }
  }
}
```

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
