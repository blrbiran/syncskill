# Usage Guide

## First Run

Initialize the local repository, inspect the generated configuration, use the local dashboard, scan for managed skills, and link them into configured agent directories.

```bash
syncskill init
syncskill
syncskill config show
syncskill scan
syncskill link --apply
```

After `init`, local state lives under `~/.syncskill/`, including the managed skill tree, manifests, and config file.

### Init Options

| Option | Description |
|--------|-------------|
| `--skip-scan` | Skip migrating skills from detected agent directories |
| `--skip-skill` | Skip installing the syncskill skill |
| `-y, --yes` | Accept all defaults without prompting |

## Local Workflow

Use the local workflow when curating skills on one machine.

### Scanning and Linking

```bash
# Scan for new skills in sources and ~/.syncskill/skills/
syncskill scan

# Scan and migrate unmanaged skills from agent directories
syncskill scan --migrate

# Preview scan results without making changes
syncskill scan --dry-run

# Show link status
syncskill link list
syncskill link ls
syncskill link --list
syncskill link list -v    # verbose text output

# Open matrix editor
syncskill link

# Link a specific skill (opens single-skill editor)
syncskill link welcome

# Append link to specific agent
syncskill link welcome claude

# Link skill to all agents
syncskill link welcome --all

# Apply all configured links
syncskill link --apply

# Preview link changes without applying
syncskill link --apply --dry-run
syncskill link welcome --dry-run

# Auto-confirm stale link removal
syncskill link --apply -y

# Unlink a skill from all configured agents
syncskill unlink welcome

# Preview unlink without applying
syncskill unlink welcome --dry-run
```

### Stale Link Reconciliation

The `link` command automatically detects and offers to remove stale links. Stale links occur when:

- You remove a skill from an agent in the matrix editor
- You unlink a skill but symlinks remain from a previous session
- Configuration changes leave orphaned symlinks in agent directories

When linking, syncskill checks for symlinks that point to managed skills but are no longer in the current configuration:

```bash
$ syncskill link my-skill

✓ Linked my-skill to: claude

Remove my-skill from hermes, qoder? (no longer in config) [Y/n] y
✓ Removed
```

For batch operations:

```bash
$ syncskill link --apply

✓ Linked 5 skills

Links to remove (no longer in config):
  my-repo:
    skill-a: hermes, qoder
    skill-b: qoder
  manual:
    local-tool: hermes

Remove 4 links? [Y/n] y
✓ Removed 4 links
```

Link reconciliation options:

| Option | Description |
|--------|-------------|
| `-y, --yes` | Auto-confirm stale link removal |
| `--dry-run` | Preview what would be linked and removed |

Link status symbols:

| Symbol | Status | Meaning |
|--------|--------|---------|
| `✓` | linked | Symlink is working |
| `⚠` | copied | Fallback to copy (needs attention) |
| `·` | missing | Not linked to this agent |
| `✗` | broken | Symlink target missing |

### Managing Sources

```bash
# Add a git source (auto-parses GitHub URLs)
syncskill source add https://github.com/org/skills-repo

# Add with specific branch
syncskill source add https://github.com/org/repo/tree/develop

# Add with explicit options
syncskill source add https://github.com/org/repo --name my-skills --branch main

# Add a local directory
syncskill source add my-local --type local --path /path/to/skills

# Add with skill subdirectory
syncskill source add https://github.com/org/repo --skill-subdir skills/

# Skip confirmation and select all skills
syncskill source add https://github.com/org/repo -y

# List configured sources
syncskill source list
syncskill source ls

# Update all sources
syncskill source update
syncskill source update --all

# Update a specific source
syncskill source update vendor-docs

# Update with yes to all confirmations (skips dirty sources)
syncskill source update --all -y

# Force update (overwrites dirty sources after backup)
syncskill source update --all --force

# Top-level alias for source update
syncskill update
syncskill update --all --force

# Remove a source (interactive)
syncskill source remove vendor-docs

# Remove with force (skip confirmation)
syncskill source remove vendor-docs --force
```

Source add options:

| Option | Description |
|--------|-------------|
| `--name <name>` | Source name (defaults to repo/directory name) |
| `--type <type>` | Source type: `git`, `http`, or `local` |
| `--path <path>` | Subdirectory containing skills (use `.` for repo root) |
| `--skill-subdir <dir>` | Alias for `--path` |
| `--branch <branch>` | Git branch or tag |
| `-y, --yes` | Skip confirmation, select all skills |

Run `syncskill source update` with no name to update every configured source, or pass a source name to update just one.

Source update options:

| Option | Description |
|--------|-------------|
| `[name]` | Update specific source (interactive selection if omitted) |
| `--all` | Update all updatable sources |
| `-y, --yes` | Skip confirmations (skips dirty sources unless --force) |
| `--force` | Force update dirty sources (backs up modified skills first) |
| `--dry-run` | Preview dirty detection and pending updates without changing files |

**Dirty source handling**: When a source has local modifications (`git status` shows changes, or HTTP source hash differs from last update), the update is skipped by default. Use `--force` to overwrite after automatic backup to `~/.syncskill/backups/`.

When `--force` overwrites a dirty source, syncskill writes recovery metadata to `~/.syncskill/update-history.json`. Use `syncskill source restore <name>` to recover the saved git stash or HTTP backup.

```bash
# Preview source updates without changing anything
syncskill source update --all --dry-run

# Restore a source that was overwritten by --force
syncskill source restore vendor-docs
```

The restore command is interactive and uses the matching recovery record from `update-history.json`.

- Git sources can restore the saved stash created before overwrite.
- HTTP sources can restore files from the recorded backup directory.

### Installing Skills

```bash
# Show install help
syncskill install

# Install the syncskill skill itself
syncskill install --self
syncskill install self

# Install from a GitHub URL
syncskill install https://github.com/org/skills-repo
syncskill i https://github.com/org/skills-repo

# Install with options
syncskill install https://github.com/org/repo --name my-skills --branch main

# Install without prompts
syncskill install https://github.com/org/repo -y
```

Install options:

| Option | Description |
|--------|-------------|
| `--name <name>` | Source name |
| `--path <path>` | Subdirectory containing skills (use `.` for repo root) |
| `--skill-subdir <dir>` | Alias for `--path` |
| `--branch <branch>` | Git branch or tag |
| `-y, --yes` | Skip confirmation prompts |

### Typical Loop

1. Add or edit a skill under `~/.syncskill/skills/`
2. Run `syncskill scan` to register newly discovered skills
3. Run `syncskill link --apply` or `syncskill link <skill>` to publish links into agent directories
4. Use `syncskill source add/update/list` to manage external sources

## Reconciliation Workflow

Use reconciliation commands to understand drift between local state, recorded manifest state, and remote servers.

```bash
# Show status for all tracked servers
syncskill status

# Show pending changes for one server
syncskill diff alpha

# Resolve a conflict interactively
syncskill resolve welcome

# Resolve keeping local version
syncskill resolve welcome --local

# Resolve keeping remote version
syncskill resolve welcome --remote

# Show diff before resolving
syncskill resolve welcome --diff
syncskill resolve welcome --local --diff

# Refresh manifest state and show status
syncskill refresh --status alpha
```

Recommended flow:

1. Run `syncskill status` to see all tracked server rows
2. Run `syncskill diff alpha` to focus on one server
3. If a skill is in conflict, run `syncskill resolve <skill>` (interactive or with `--local`/`--remote`)
4. Run `syncskill refresh --status alpha` when you want to refresh stored local manifest state before reviewing again

## Remote Lifecycle Workflow

Use remote lifecycle commands to inspect server wiring or refresh reconciliation state without pulling skill contents.

```bash
# List configured servers
syncskill server list

# Show server configuration
syncskill server show alpha

# Probe server connectivity and receiver status
syncskill server probe alpha

# Refresh remote manifest without pulling content
syncskill refresh --remote --status alpha
```

Recommended flow:

1. Run `syncskill server list` to see configured remote targets
2. Run `syncskill server show alpha` to inspect `host`, `user`, `port`, `identity_file`, and `remote_agents` paths
3. Run `syncskill server probe alpha` before the first sync or after changing remote paths
4. Run `syncskill refresh --remote --status alpha` when you want reconciliation to reflect the real remote skill tree without pulling skill contents into the local repository
5. Run `syncskill pull alpha` when you want to materialize remote skill contents locally.

## Remote Sync Workflow

Use sync commands once servers are configured.

```bash
# Push to a specific server
syncskill push alpha

# Push to all servers
syncskill push --all

# Pull from a specific server
syncskill pull alpha

# Pull from all servers
syncskill pull --all

# Full sync (pull then push) for all servers
syncskill sync --all

# Preview changes without executing
syncskill push --dry-run
syncskill pull --dry-run
syncskill sync --dry-run

# Set SSH operation timeout in seconds
syncskill push alpha --timeout 60
syncskill pull alpha --timeout 60
syncskill sync --all --timeout 60
```

Remote sync timeout options:

| Option | Description |
|--------|-------------|
| `--timeout <seconds>` | Override the default SSH/rsync timeout for `push`, `pull`, and `sync` |

Use `--timeout` when a remote server is slow to respond or you want the command to fail faster than the system SSH defaults.

Example timeout failure:

```text
Operation timed out after 60 seconds.
Check network connectivity or increase --timeout value.
```

```bash
# Retry with a longer timeout
syncskill sync alpha --timeout 120
```

```bash
# Preview changes without executing
syncskill push --dry-run
syncskill pull --dry-run
syncskill sync --dry-run
```

Typical remote flow:

1. Configure servers in `~/.syncskill/config.yaml`
2. Run `syncskill server probe alpha` to verify connectivity
3. Run `syncskill refresh --remote --status alpha` to update remote manifest state
4. Run `syncskill push alpha` to publish local changes
5. Run `syncskill pull alpha` to fetch remote changes
6. Run `syncskill sync --all` for full pull-then-push orchestration

## Configuration

```bash
# Open interactive config menu
syncskill config

# Show current config
syncskill config show

# Set a config value
syncskill config set conflict_resolution keep-local

# Show all config paths
syncskill config set --show-paths

# Edit skill -> agent links (matrix editor)
syncskill link
syncskill config link  # deprecated, use 'link' instead

# Edit skill -> server sync mapping (matrix editor)
syncskill remote
syncskill config remote

# Manage servers (interactive menu)
syncskill server
syncskill config server
```

Note: `syncskill server` and `syncskill remote` are shortcuts that go directly to the respective configuration menus.

## Diagnostics

```bash
# Check config for issues
syncskill doctor

# Interactive repair
syncskill doctor --fix

# Auto-repair all fixable issues
syncskill doctor --fix -y

# Rebuild skills-registry.json from scratch
syncskill doctor --rebuild-registry
```

The doctor command checks for:
- Invalid agent paths
- Skills in links that don't exist
- Agents in links that aren't configured
- Invalid source paths
- Stale or corrupt skills-registry.json entries

## Global Options

| Option | Description |
|--------|-------------|
| `--no-refresh` | Skip automatic manifest refresh before commands |
| `-y, --yes` | Skip confirmation prompts |
| `--dry-run` | Preview changes without executing |

## Install from Source

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

## Verification

Default required gate:

```bash
npm run test
npm run build
```

Additional suites:

```bash
npm run test:integration
npm run test:end2end
```

Built CLI sanity:

```bash
node dist/index.js --help
```
