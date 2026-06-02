# syncskill

`syncskill` is a CLI for organizing AI agent skills in a local `~/.syncskill/` repository, linking them into agent-specific skill directories, and reconciling local state with remote servers.

v2 adds JSONL output, non-interactive execution, and plan/apply workflows for agent-friendly automation.

## Features

- **Multi-agent support**: Manage skills across Claude, Hermes, Qoder, and other AI agents
- **Source management**: Import skills from git repositories, HTTP archives, or local directories with `install`; maintain them with `source list`, top-level `update`, and `source remove`
- **Declarative linking**: Manage skill links with `link set`, `link add`, `link remove`, `link clear`, and `link build`
- **Agent automation**: Stream JSONL events, disable prompts, or split planning from execution with `--json`, `--no-interactive`, `--plan`, `--apply`, and `--resolutions`
- **Remote sync**: Push and pull skills to/from remote servers via SSH/rsync, with optional `--timeout` control
- **Conflict resolution**: Three-way merge with manual or automatic resolution
- **Cross-platform**: Works on macOS, Linux, and Windows

## Install from source

```bash
npm install
npm run build
npm link
syncskill --help
```

Or run the built entrypoint directly:

```bash
node dist/index.js --help
```

## Quick Start

```bash
# Initialize the local repository
syncskill init

# Show status dashboard
syncskill

# Install the syncskill skill (for AI agents)
syncskill install self

# Preview the built-in install plan first
syncskill --plan install self

# Install from a source interactively when running in a TTY
syncskill install

# Link skills to agent directories
syncskill link                    # Open matrix editor
syncskill link add my-skill claude
syncskill link set my-skill claude cursor
syncskill link build              # Reconcile configured links and clean stale symlinks
syncskill unlink my-skill         # Alias for `syncskill link clear my-skill`
```

## Commands Overview

### Installation & Setup

| Command | Description |
|---------|-------------|
| `syncskill init` | Initialize `~/.syncskill/` directory structure |
| `syncskill install` / `i` | Open interactive install menu in TTY, otherwise show help; also install from URL/path |
| `syncskill install self` | Install built-in syncskill skill |
| `syncskill config` | Open interactive configuration menu |
| `syncskill config show` | Print current JSON configuration |
| `syncskill config set <key> <value>` | Set a configuration value in `config.json` |
| `syncskill scan [--migrate-unmanaged] [--dry-run]` | Scan for new skills, optionally migrate unmanaged skills |

### Skill Linking

| Command | Description |
|---------|-------------|
| `syncskill link` | Open matrix editor for skill-to-agent links |
| `syncskill link edit <skill>` | Open single-skill editor |
| `syncskill link set <skill> <agents...>` | Replace a skill's linked agents declaratively |
| `syncskill link add <skill> <agent>` | Add one agent link for a skill |
| `syncskill link remove <skill> <agent>` | Remove one agent link for a skill |
| `syncskill link clear <skill>` | Remove all links for a skill |
| `syncskill link build` | Reconcile all configured links (auto-cleans stale symlinks) |
| `syncskill link list` / `ls` | Show link status |
| `syncskill link list -v` | Show link status with verbose text |
| `syncskill unlink <skill>` | Alias for `syncskill link clear <skill>` |

### Source Management

| Command | Description |
|---------|-------------|
| `syncskill source list` / `ls` | List configured sources |
| `syncskill update [name\|--all] [--force] [--dry-run]` | Refresh source content |
| `syncskill source remove <name>` | Remove a source (interactive) |
| `syncskill install <url-or-path>` | Install and register a source from git, HTTP archive, local directory, or archive file |

In v2, `source add`, `source update`, and `source restore` were removed. Use `install` to add new sources and top-level `update` to refresh them.

### Reconciliation

| Command | Description |
|---------|-------------|
| `syncskill status` | Show sync status for all tracked servers |
| `syncskill diff <server>` | Show pending changes for one server |
| `syncskill resolve <skill>` | Resolve a conflict |
| `syncskill refresh [--local\|--remote\|--status]` | Refresh manifest state |

### Remote Servers

| Command | Description |
|---------|-------------|
| `syncskill server` | Open server management menu |
| `syncskill server list` / `ls` | List configured servers |
| `syncskill server show <name>` | Show server configuration |
| `syncskill remote` | Open skill → server matrix editor |

### Remote Sync

| Command | Description |
|---------|-------------|
| `syncskill push [server\|--all] [--timeout <seconds>]` | Push local changes to servers |
| `syncskill pull [server\|--all] [--timeout <seconds>]` | Pull remote changes from servers |
| `syncskill sync [server\|--all] [--timeout <seconds>]` | Full sync (pull then push) |

### Diagnostics

| Command | Description |
|---------|-------------|
| `syncskill doctor` | Diagnose config issues |
| `syncskill doctor --fix` | Interactive repair |
| `syncskill doctor --fix -y` | Auto-repair all issues |

### Global Options

- `--json` - Output command results in JSON format
- `--no-interactive` - Disable interactive prompts and TUI flows
- `--no-refresh` - Skip automatic manifest refresh
- `-y, --yes` - Skip confirmation prompts
- `--dry-run` - Preview changes without executing

Use `refresh --remote --status` when you want reconciliation to reflect the real remote skill tree without pulling remote skill contents into the local repository.
Use `pull` when you want to copy remote skill contents into the local repository.
Use `server show` to inspect the configured `host`, `user`, `port`, `identity_file`, and `remote_agents` paths before mutating sync operations.
For v2 migrations: `server probe` was removed; use `server show` plus sync/refresh commands to validate server configuration.

## Configuration Notes

- Runtime config is stored in `~/.syncskill/config.json`.
- Older `config.yaml` references in previous docs/examples should be treated as `config.json` in v2.
- External sources are installed with `install` and refreshed with top-level `update`; the deprecated `source add`, `source update`, and `source restore` command forms were removed from the v2 command surface.

## Verification

```bash
npm run build
npm test
```

## Docs

- [Usage Guide](docs/usage-guide.md) - CLI commands and workflows
- [Configuration Guide](docs/config-guide.md) - config.json reference
- [Design Guide](docs/design-guide.md) - Architecture and module responsibilities

## Verification

```bash
npm run test
npm run build
```

## Docs

- [Usage Guide](docs/usage-guide.md) - CLI commands and workflows
- [Configuration Guide](docs/config-guide.md) - config.json reference
- [Design Guide](docs/design-guide.md) - Architecture and module responsibilities
