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
| `init [--skip-sources] [--skip-skill] [-y]` | Initialize ~/.syncskill/ directory |
| `install` / `i` | Install syncskill skill itself |
| `install <url-or-path> [--name] [--ref] [-y]` | Install skill from URL or path |

### Link Management

| Command | Description |
|---------|-------------|
| `link` | Interactive matrix editor for skill→agent mapping |
| `link list` / `ls` / `--list` | Show link status |
| `link list -v` | Show verbose text status |
| `link <skill>` | Link specific skill to agents |
| `link --all` | Link all configured skills |
| `link --dry-run` | Preview link changes |
| `unlink <skill> [-y] [--dry-run]` | Remove skill links |

### Source Management

| Command | Description |
|---------|-------------|
| `source add <url> [options]` | Add external source |
| `source list` / `ls` | List configured sources |
| `source update [name] [--all]` | Update sources |
| `source remove <name> [--force]` | Remove a source |

Source add options: `--name`, `--type git|http|local`, `--path`, `--skill-subdir`, `--ref`, `-y`

### Scanning

| Command | Description |
|---------|-------------|
| `scan` | Scan for new/unmanaged skills |
| `scan --migrate` | Migrate unmanaged skills to ~/.syncskill/skills/ |
| `scan --dry-run` | Preview scan results |

### Server Management

| Command | Description |
|---------|-------------|
| `server` | Open server management menu |
| `server list` / `ls` | List configured servers |
| `server show <name>` | Show server configuration |
| `server probe <name>` | Diagnose server connectivity |

### Sync Operations

| Command | Description |
|---------|-------------|
| `push [server] [--all] [--dry-run] [-y]` | Push to remote |
| `pull [server] [--all] [--dry-run] [-y]` | Pull from remote |
| `sync [server] [--all] [--dry-run]` | Full sync (pull then push) |
| `status` | Show sync status |
| `diff <server>` | Show pending changes |
| `resolve <skill> [--local|--remote] [--diff]` | Resolve conflicts |
| `refresh [server] [--local|--remote|--all|--status]` | Refresh manifests |

### Configuration

| Command | Description |
|---------|-------------|
| `config` | Interactive config editor |
| `config show` | Print current config |
| `config set <key> <value>` | Set config value |
| `config set --show-paths` | Show all config paths |
| `remote` | Manage skill→server mappings (matrix editor) |

### Global Options

| Option | Description |
|--------|-------------|
| `--no-refresh` | Skip automatic manifest refresh |
| `-y, --yes` | Skip confirmation prompts |
| `--dry-run` | Preview changes without executing |

## Usage Examples

```bash
# Initialize and set up
syncskill init
syncskill install

# Install skills from GitHub
syncskill i https://github.com/user/skills-repo

# Manage links
syncskill link list
syncskill link --all

# Sync with remote servers
syncskill status
syncskill sync --all

# Resolve conflicts
syncskill resolve my-skill --local
```
