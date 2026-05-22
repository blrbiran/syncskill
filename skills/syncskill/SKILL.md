---
name: syncskill
description: Manage and sync AI agent skills across multiple agents (Claude, Hermes, Qoder, etc.) and devices. Install skills from GitHub/local sources, link to agents, bidirectional sync with remote servers. Use this skill when the user mentions skill management, syncskill, adding skills from GitHub, syncing to servers, or linking skills to agents.
---

# syncskill

Use this skill when:
- User wants to install, add, or manage AI skills
- User mentions syncskill, skill sync, or skill management
- User wants to add skills from GitHub or other sources
- User wants to update or restore skill sources after overwrite
- User wants to sync skills to remote servers, including timeout tuning
- User wants to link/unlink skills to AI agents
- User asks about skill status or configuration

## Quick Reference

### Installation & Setup

| Command | Description |
|---------|-------------|
| `init [--skip-scan] [--skip-self] [-y]` | Initialize `~/.syncskill/` and create `config.json` |
| `install` / `i` | In TTY, open an interactive install menu; in non-TTY, show install help |
| `install --self` / `install self` | Install built-in syncskill skill |
| `install <url-or-path> [--name] [--branch] [-y]` | Install skill from URL or path and register it as a managed source |

Install options: `--name`, `--path` (source storage path), `--skill-subdir`, `--branch`, `-y`

### Link Management

| Command | Description |
|---------|-------------|
| `link` | Open the interactive matrix editor when running in a TTY; otherwise show help |
| `link list` / `link ls` | Show link status matrix |
| `link list -v` | Show verbose text status |
| `link edit [skill]` | Open the human-oriented matrix editor |
| `link set <skill> <agents...>` | Declaratively replace a skill's target agents; idempotent and AI-friendly |
| `link add <skill> <agent>` | Add one target agent without replacing existing targets |
| `link remove <skill> <agent>` | Remove one target agent |
| `link clear <skill>` | Remove all links for a skill |
| `link apply` | Reconcile symlinks to match config for all configured skills |
| `unlink <skill>` | Alias for `link clear <skill>` |

For AI agents, prefer `link set ...` followed by `link apply` when making declarative changes, or use `link add/remove/clear` for small incremental edits.

**Reconcile behavior**: `link apply` and the mutating `link` subcommands reconcile stale symlinks (links pointing to skills no longer in config or to non-existent paths).

### Source Management

| Command | Description |
|---------|-------------|
| `source list` / `source ls` | List configured sources |
| `source remove <name> [--force]` | Remove a configured source |
| `update [name] [--all] [--force] [--dry-run] [-y]` | Update source(s) from their recorded origin |

In v2, `source add`, `source update`, and `source restore` are removed. Use `install <url-or-path>` to add/register sources, and use top-level `update` to refresh them.

### Scanning

| Command | Description |
|---------|-------------|
| `scan` | Scan sources for new skills and detect unmanaged skills in agent directories |
| `scan --migrate-unmanaged` | Migrate unmanaged skills to `~/.syncskill/skills/` |
| `scan --dry-run` | Preview scan results |

### Server Management

| Command | Description |
|---------|-------------|
| `server` | Open server management menu |
| `server list` / `server ls` | List configured servers |
| `server show <name>` | Show server configuration |

In v2, `server probe` is removed.

### Sync Operations

| Command | Description |
|---------|-------------|
| `push [server] [--all] [--dry-run] [--timeout <seconds>] [-y]` | Push skills to remote server |
| `pull [server] [--all] [--dry-run] [--timeout <seconds>] [-y]` | Pull skills from remote server |
| `sync [server] [--all] [--dry-run] [--timeout <seconds>]` | Full sync (pull then push) |
| `status` | Show sync status for all tracked servers |
| `diff <server>` | Show pending changes for a server |
| `resolve <skill> [--local|--remote|--diff]` | Resolve sync conflicts |
| `refresh [server] [--local|--remote|--all|--status]` | Refresh manifest state |

### Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `config` | Interactive config editor |
| `config show` | Print current config as JSON |
| `config set <key> <value>` | Set config value |
| `config set --show-paths` | Show all configurable paths |
| `config server` | Server management menu |
| `config remote` | Remote skills matrix editor |
| `remote` | Shortcut for `config remote` |
| `doctor` | Diagnose config issues (agents, links, sources, registry) |
| `doctor --fix [-y]` | Interactive repair of config issues |
| `doctor --rebuild-registry` | Rebuild `skills-registry.json` from scratch |

**Config format**: v2 is JSON-only. Runtime state lives under `~/.syncskill/`, and the main config file is `~/.syncskill/config.json`. Older `config.yaml` files are legacy format and are migrated on config writes.

**`private_agents`**: agents that need dedicated per-agent links instead of the shared `~/.agents/skills/` target. Current defaults are `claude`, `codex`, `gemini`, `cursor`, `kiro`, `augment`, `cline`, and `hermes`. Setting `private_agents` in config fully overrides the default list.

### Global Options

| Option | Description |
|--------|-------------|
| `--json` | Emit machine-readable JSON output when supported; prefer this for agent automation |
| `--no-interactive` | Disable interactive prompts; commands that require TTY input fail fast instead of prompting |
| `--no-refresh` | Skip automatic manifest refresh |
| `-y, --yes` | Skip confirmation prompts |
| `--dry-run` | Preview changes without executing |
| `--force` | Force operation (for example, updating dirty sources) |

For automation, prefer `--json --no-interactive` together with declarative commands such as `config show`, `link set`, `link apply`, `status`, `diff`, `push`, `pull`, and `sync`.

## Usage Examples

```bash
# Initialize and inspect JSON config
syncskill init
syncskill config show

# Install a source-backed skill set
syncskill i https://github.com/user/skills-repo

# AI-friendly declarative linking
syncskill --no-interactive link set welcome claude hermes
syncskill --no-interactive link apply
syncskill --json link list

# Incremental link edits
syncskill link add welcome cursor
syncskill link remove welcome hermes
syncskill unlink welcome

# Scan and migrate unmanaged skills
syncskill scan --migrate-unmanaged --dry-run

# Update configured sources
syncskill update --all --dry-run
syncskill update --all --force

# Diagnose and fix config issues
syncskill doctor --fix

# Sync with remote servers
syncskill --json status
syncskill sync --all --timeout 60

# Resolve conflicts
syncskill resolve my-skill --local
```
