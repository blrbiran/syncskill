# Usage Guide

## First Run

Initialize the local repository, inspect the generated configuration, scan for managed skills, and link them into configured agent directories.

```bash
syncskill init
syncskill config show
syncskill scan
syncskill link --all
```

After `init`, local state lives under `~/.syncskill/`, including the managed skill tree, manifests, and config file.

## Local Workflow

Use the local workflow when curating skills on one machine.

### Scanning and Linking

```bash
# Scan for new skills in sources and ~/.syncskill/skills/
syncskill scan

# Scan and migrate unmanaged skills from agent directories
syncskill scan --migrate

# Show link status
syncskill link list
syncskill link ls
syncskill link --list
syncskill link list -v    # verbose text output

# Open matrix editor
syncskill link

# Link a specific skill
syncskill link welcome

# Link all configured skills
syncskill link --all

# Unlink a skill from all agents
syncskill unlink welcome
```

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

# Add a local directory
syncskill source add my-local --type local --path /path/to/skills

# List configured sources
syncskill source list

# Update all sources
syncskill source update

# Update a specific source
syncskill source update vendor-docs

# Remove a source (interactive)
syncskill source remove vendor-docs
```

Run `syncskill source update` with no name to update every configured source, or pass a source name to update just one.

### Typical Loop

1. Add or edit a skill under `~/.syncskill/skills/`
2. Run `syncskill scan` to register newly discovered skills
3. Run `syncskill link --all` or `syncskill link <skill>` to publish links into agent directories
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

# Edit skill -> agent links
syncskill link

# Edit skill -> server sync mapping
syncskill config remote
syncskill remote

# Manage servers
syncskill config server
syncskill server
```

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
