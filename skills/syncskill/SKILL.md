---
name: syncskill
description: Manage and sync AI agent skills across multiple agents (Claude, Hermes, Qoder, etc.) and devices. Install skills from GitHub/local sources, link to agents, bidirectional sync with remote servers. Use this skill when the user mentions skill management, syncskill, adding skills from GitHub, syncing to servers, or linking skills to agents.
---

# syncskill

Use this skill when:
- User wants to install, add, or manage AI skills
- User mentions syncskill, skill sync, or skill management
- User wants to add skills from GitHub or other sources
- User wants to sync skills to remote servers
- User wants to link/unlink skills to AI agents
- User asks about skill status or configuration

## Quick Reference

### Installation & Setup

| Command | Description |
|---------|-------------|
| `init [--skip-scan] [--skip-skill] [-y]` | Initialize ~/.syncskill/ directory |
| `install` / `i` | Install syncskill skill itself |
| `install <url-or-path> [--name] [--branch] [-y]` | Install skill from URL or path (= source add + auto-link) |

Install options: `--name`, `--path` (skill subdirectory), `--skill-subdir` (alias), `--branch`, `-y`

### Link Management

| Command | Description |
|---------|-------------|
| `link` | Interactive matrix editor for skill→agent mapping |
| `link list` / `ls` / `--list` | Show link status matrix |
| `link list -v` | Show verbose text status |
| `link <skill>` | Link specific skill to agents + reconcile stale links |
| `link --all` | Link all configured skills + reconcile all stale links |
| `link --dry-run` | Preview link changes |
| `unlink <skill> [-y] [--dry-run]` | Remove skill links from all agents |

**Reconcile behavior**: `link` and `link --all` automatically clean up stale symlinks (links pointing to skills no longer in config or to non-existent paths).

### Source Management

| Command | Description |
|---------|-------------|
| `source add <url-or-path>` | Add external source (GitHub URL, local archive, local path) |
| `source list` / `ls` | List configured sources |
| `source update [name] [--all] [--force] [-y]` | Update sources (git pull / re-download) |
| `source remove <name> [--force]` | Remove source (interactive or force-remove all) |
| `update [name] [--all] [--force] [-y]` | Top-level alias for `source update` |

Source add options: `--name`, `--type git|http|local`, `--path` (skill subdirectory), `--skill-subdir` (alias), `--branch`, `-y`

### Scanning

| Command | Description |
|---------|-------------|
| `scan` | Scan sources for new skills + detect unmanaged skills in agent dirs |
| `scan --migrate` | Migrate unmanaged skills to ~/.syncskill/skills/ |
| `scan --dry-run` | Preview scan results |

### Server Management

| Command | Description |
|---------|-------------|
| `server` | Open server management menu |
| `server list` / `ls` | List configured servers |
| `server show <name>` | Show server configuration |
| `server probe <name>` | Diagnose connectivity (SSH, Node version, receiver status) |

### Sync Operations

| Command | Description |
|---------|-------------|
| `push [server] [--all] [--dry-run] [-y]` | Push skills to remote server |
| `pull [server] [--all] [--dry-run] [-y]` | Pull skills from remote server |
| `sync [server] [--all] [--dry-run]` | Full sync (pull then push) |
| `status` | Show sync status for all tracked servers |
| `diff <server>` | Show pending changes for a server |
| `resolve <skill> [--local|--remote|--diff]` | Resolve sync conflicts |
| `refresh [server] [--local|--remote|--all|--status]` | Refresh manifest state |

### Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `config` | Interactive config editor |
| `config show` | Print current config (JSON) |
| `config set <key> <value>` | Set config value |
| `config set --show-paths` | Show all configurable paths |
| `config server` | Server management menu |
| `config remote` | Remote skills matrix editor |
| `remote` | Shortcut for `config remote` |
| `doctor` | Diagnose config issues (agents, links, sources, registry) |
| `doctor --fix [-y]` | Interactive repair of config issues |
| `doctor --rebuild-registry` | Rebuild skills-registry.json from scratch |

**Doctor checks**: missing agent directories, orphaned links, invalid sources, registry inconsistencies.

### Global Options

| Option | Description |
|--------|-------------|
| `--no-refresh` | Skip automatic manifest refresh |
| `-y, --yes` | Skip confirmation prompts |
| `--dry-run` | Preview changes without executing |
| `--force` | Force operation (e.g., update dirty sources) |

## Usage Examples

```bash
# Initialize and set up
syncskill init
syncskill install

# Install skills from GitHub
syncskill i https://github.com/user/skills-repo

# Manage links (includes stale link cleanup)
syncskill link list
syncskill link --all

# Update sources
syncskill update --all

# Diagnose and fix config issues
syncskill doctor --fix

# Sync with remote servers
syncskill status
syncskill sync --all

# Resolve conflicts
syncskill resolve my-skill --local
```
