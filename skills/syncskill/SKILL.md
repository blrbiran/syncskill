---
name: syncskill
description: Manage and sync AI agent skills across multiple agents (Claude, Hermes, Qoder, etc.) and devices. Install skills from GitHub/local sources, link to agents, bidirectional sync with remote servers. Also enables AI to self-install skills on demand. Use this skill whenever the user mentions skill management, syncskill, skill sync, adding skills from GitHub, syncing to servers, or linking skills to agents.
---

# syncskill

Use this skill when:
- User wants to install, add, or manage AI skills
- User mentions syncskill, skill sync, or skill management
- User wants to add skills from GitHub or other sources
- User wants to sync skills to remote servers
- User wants to link/unlink skills to AI agents
- User asks about skill status or configuration

## Commands Reference

### Installation
- `syncskill init` — Initialize ~/.syncskill/ directory
- `syncskill install` / `syncskill i` — Install syncskill skill itself
- `syncskill install <url-or-path>` — Install skill from URL or local path

### Source Management
- `source add <url> [--name <n>] [--path <p>]` — Add external source
- `source update [--all | <name>]` — Update sources
- `source list` — List configured sources
- `source remove <name>` — Remove a source

### Link Management
- `link` — Interactive matrix editor for skill→agent mapping
- `link list` / `link ls` — Show link status
- `link <skill>` — Link specific skill to agents
- `unlink <skill>` — Remove skill links
- `scan [--migrate]` — Scan for new/unmanaged skills

### Sync Operations
- `push [<server>] [--all] [--dry-run]` — Push to remote
- `pull [<server>] [--all] [--dry-run]` — Pull from remote
- `sync [<server>] [--all] [--dry-run]` — Full sync (pull then push)
- `status` — Show sync status
- `diff <server>` — Show pending changes
- `resolve <skill> [--local|--remote] [--diff]` — Resolve conflicts
- `refresh [--local|--remote|--all|--status]` — Refresh manifests

### Configuration
- `config` — Interactive config editor
- `config show` — Print current config
- `config set <key> <value>` — Set config value
- `server` — Manage servers
- `server probe <name>` — Diagnose server status
- `remote` — Manage skill→server mappings

## Usage Examples

### Install a skill from GitHub
```bash
syncskill i https://github.com/user/skills-repo
```

### Sync skills to all servers
```bash
syncskill sync --all
```

### Check what needs to be synced
```bash
syncskill status
```

### Add a new skill source and link it
```bash
syncskill source add https://github.com/org/awesome-skills
syncskill link awesome-skill
```

### Resolve a sync conflict
```bash
syncskill resolve my-skill --local
```
