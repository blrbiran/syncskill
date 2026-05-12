# syncskill

`syncskill` is a CLI for organizing AI agent skills in a local `~/.syncskill/` repository, linking them into agent-specific skill directories, and reconciling local state with remote servers.

## Features

- **Multi-agent support**: Manage skills across Claude, Hermes, Qoder, and other AI agents
- **Source management**: Import skills from git repositories, HTTP archives, or local directories
- **Remote sync**: Push and pull skills to/from remote servers via SSH/rsync
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

# Show current configuration
syncskill config show

# Scan for skills in sources and agent directories
syncskill scan

# Link all configured skills to agent directories
syncskill link --all

# Show reconciliation status
syncskill status
```

## Commands Overview

### Installation & Setup

| Command | Description |
|---------|-------------|
| `syncskill init` | Initialize `~/.syncskill/` directory structure |
| `syncskill install` / `i` | Install syncskill skill (no args) or from URL/path |
| `syncskill config` | Open interactive configuration menu |
| `syncskill config show` | Print current configuration |
| `syncskill config set <key> <value>` | Set a configuration value |
| `syncskill scan [--migrate] [--dry-run]` | Scan for new skills, optionally migrate unmanaged skills |

### Skill Linking

| Command | Description |
|---------|-------------|
| `syncskill link` | Open matrix editor for skill-to-agent links |
| `syncskill link <skill>` | Link a specific skill |
| `syncskill link --all` | Link all configured skills |
| `syncskill link list` / `ls` | Show link status |
| `syncskill link list -v` | Show link status with verbose text |
| `syncskill link --dry-run` | Preview link changes |
| `syncskill unlink <skill>` | Remove links for a skill |

### Source Management

| Command | Description |
|---------|-------------|
| `syncskill source add <url>` | Add a source (git, http, or local) |
| `syncskill source list` / `ls` | List configured sources |
| `syncskill source update [name]` | Update one or all sources |
| `syncskill source update --all` | Update all sources |
| `syncskill source update --force` | Force update, overwriting dirty sources |
| `syncskill source remove <name>` | Remove a source (interactive) |
| `syncskill update [name]` | Top-level alias for `source update` |

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
| `syncskill server probe <name>` | Test server connectivity |
| `syncskill remote` | Open skill → server matrix editor |

### Remote Sync

| Command | Description |
|---------|-------------|
| `syncskill push [server\|--all]` | Push local changes to servers |
| `syncskill pull [server\|--all]` | Pull remote changes from servers |
| `syncskill sync [server\|--all]` | Full sync (pull then push) |

### Diagnostics

| Command | Description |
|---------|-------------|
| `syncskill doctor` | Diagnose config issues |
| `syncskill doctor --fix` | Interactive repair |
| `syncskill doctor --fix -y` | Auto-repair all issues |
| `syncskill doctor --rebuild-registry` | Rebuild skills-registry.json |

### Global Options

- `--no-refresh` - Skip automatic manifest refresh
- `-y, --yes` - Skip confirmation prompts
- `--dry-run` - Preview changes without executing

Use `refresh --remote --status` when you want reconciliation to reflect the real remote skill tree without pulling remote skill contents into the local repository.
Use `pull` when you want to copy remote skill contents into the local repository.
Use `server show` and `server probe` to inspect the configured `host`, `user`, `port`, `identity_file`, and `remote_agents` paths before mutating sync operations.

## Verification

```bash
npm run test
npm run build
```

## Docs

- [Usage Guide](docs/usage-guide.md) - CLI commands and workflows
- [Configuration Guide](docs/config-guide.md) - config.yaml reference
- [Design Guide](docs/design-guide.md) - Architecture and module responsibilities
