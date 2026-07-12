# Usage Guide

## First Run

Initialize the local repository, inspect the generated configuration, use the local dashboard, scan for managed skills, and link them into configured agent directories.

```bash
syncskill init
syncskill
syncskill config show
syncskill scan
syncskill link build
```

After `init`, local state lives under `~/.syncskill/` by default, including the managed skill tree, manifests, and `config.json`. Set `SYNCSKILL_DIR` to relocate the runtime directory, or `SYNCSKILL_CONFIG` to point at a specific config file.

## AI Agent Integration

v2 adds automation-friendly global flags and environment variables so AI agents can separate planning from execution and avoid hanging on prompts.

```bash
# Preview the plan without changing files
syncskill --plan install self
syncskill --plan install https://github.com/org/skills-repo

# Save the plan, then execute it
syncskill --plan install https://github.com/org/skills-repo > /tmp/install.plan.json

# Execute a previously generated plan
syncskill --apply /tmp/install.plan.json --resolutions /tmp/install.resolutions.json install https://github.com/org/skills-repo

# Non-interactive JSON mode for agents and scripts
syncskill --json --no-interactive link list
```

Prefer `--json` for machine-readable output and `--no-interactive` when a command must fail instead of prompting. Use `--plan`, `--apply`, and `--resolutions <path>` when your workflow needs approval or handoff between one agent that plans and another that executes. External installs may require `--resolutions` when the generated plan contains unresolved skill selection.

### Init Options

| Option | Description |
|--------|-------------|
| `--skip-scan` | Skip migrating skills from detected agent directories |
| `--skip-self` | Skip installing the syncskill skill |
| `-y, --yes` | Accept all defaults without prompting |

## Local Workflow

Use the local workflow when curating skills on one machine.

### Scanning and Linking

```bash
# Scan for new skills in sources and ~/.syncskill/skills/
syncskill scan

# Scan and migrate unmanaged skills from agent directories
syncskill scan --migrate-unmanaged

# Preview scan results without making changes
syncskill scan --dry-run

# Show link status
syncskill link list
syncskill link ls
syncskill link list -v    # verbose text output

# Open the full matrix editor
syncskill link edit

# Open the single-skill editor
syncskill link edit welcome

# Set the full agent list for a skill (replaces existing links)
syncskill link set welcome claude cursor

# Append one agent link
syncskill link add welcome claude

# Remove one agent link
syncskill link remove welcome claude

# Clear all links for a skill
syncskill link clear welcome
syncskill unlink welcome

# Apply all configured links
syncskill link build

# Preview link changes without applying
syncskill link build --dry-run
syncskill link set welcome claude cursor --dry-run
syncskill unlink welcome --dry-run

# Auto-confirm stale link removal
syncskill link build -y
```

Use `link edit` for interactive workflows and `link set` / `link add` / `link remove` / `link clear` for explicit non-interactive updates.

`unlink <skill>` is an alias for `link clear <skill>`.

`link set` is idempotent and replaces the full configured agent list for the skill. `link add` and `link remove` make incremental changes.

All link commands also support the global `--no-interactive` flag when you want commands to fail instead of prompting.

```bash
# Safe for automation
syncskill --no-interactive link build
syncskill --json link list
```

When you use `--json`, `link list` returns machine-readable realized status output instead of the symbol matrix.

`syncskill link` edits the configured skill → agent assignment matrix. `syncskill link list` / `link ls` shows the realized on-disk state for every managed local skill × configured agent cell, including realized shared links under `~/.agents/skills/`.

Link subcommands:

| Command | Description |
|--------|-------------|
| `link list` | Show realized on-disk link status for all managed skills |
| `link edit [skill]` | Open the interactive matrix editor |
| `link set <skill> <agents...>` | Replace the configured agents for one skill |
| `link add <skill> <agent>` | Add one configured agent for one skill |
| `link remove <skill> <agent>` | Remove one configured agent for one skill |
| `link clear <skill>` | Remove all configured agents for one skill |
| `link build` | Reconcile configured links into agent directories |
| `unlink <skill>` | Alias for `link clear <skill>` |

Link command options:

| Option | Applies to | Description |
|--------|------------|-------------|
| `-y, --yes` | `link set`, `link add`, `link clear`, `link build`, `unlink` | Auto-confirm prompts when the command is otherwise allowed; `link clear` / `unlink` still require `--yes-destructive` in non-interactive mode |
| `--dry-run` | `link set`, `link add`, `link remove`, `link clear`, `link build`, `unlink` | Preview what would change |
| `-v, --verbose` | `link list` | Show text status instead of symbols |
| `--no-interactive` | global | Disable prompts for automation |
| `--json` | global | Emit JSON output for script-friendly commands |
```

Note: `link edit` requires an interactive terminal. If you pass `--no-interactive`, use `link set`, `link add`, or `link remove` instead.

### Stale Link Reconciliation

The `link` workflow automatically detects and offers to remove stale links. Stale links occur when:

- You remove a skill from an agent in `link edit`
- You clear a skill's links but symlinks remain from a previous session
- Configuration changes leave orphaned symlinks in agent directories or under the shared `~/.agents/skills/` target

When applying link changes, syncskill checks for symlinks that point to managed skills but are no longer in the current configuration:

```bash
$ syncskill link add my-skill claude

✓ Linked my-skill to: agents, claude

Remove my-skill from hermes, qoder? (no longer in config) [Y/n] y
✓ Removed
```

For batch operations:

```bash
$ syncskill link build

✓ Linked 5 skills

Default local linking may produce output like `Linked to: agents, claude` when a skill targets the shared directory plus a private agent. You can remove the shared link explicitly with `syncskill link remove <skill> agents`.

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

`syncskill link build` deduplicates materialized agent directories by canonical `realpath` before removing stale links.
If `claude` and `codex` resolve to the same underlying directory, syncskill treats that directory as one cleanup domain and will not remove a still-valid managed link only because one alias is no longer targeted.

Link status symbols:

| Symbol | Status | Meaning |
|--------|--------|---------|
| `✓` | linked | Symlink is working |
| `⚠` | copied | Fallback to copy (needs attention) |
| `-` | unconfigured | This skill is not configured for that agent |
| `·` | missing | Configured for that agent, but no on-disk entry exists |
| `✗` | broken | Symlink target missing |

### Managing Sources

```bash
# List configured sources
syncskill source list
syncskill source ls

# Update all configured sources
syncskill update --all

# Update a specific source
syncskill update vendor-docs

# Skip confirmations (dirty sources are still skipped unless --force)
syncskill update --all -y

# Force update after backup
syncskill update --all --force

# Preview source updates without changing anything
syncskill update --all --dry-run

# Remove a source (interactive)
syncskill source remove vendor-docs

# Remove with force (skip confirmation)
syncskill source remove vendor-docs --force
```

Source update options:

| Option | Description |
|--------|-------------|
| `[name]` | Update specific source (interactive selection if omitted) |
| `--all` | Update all updatable sources |
| `-y, --yes` | Skip confirmations (skips dirty sources unless `--force`) |
| `--force` | Force update dirty sources (backs up modified skills first) |
| `--dry-run` | Preview dirty detection and pending updates without changing files |

**Dirty source handling**: When a source has local modifications (`git status` shows changes, or HTTP source hash differs from last update), the update is skipped by default. Use `--force` to overwrite after an automatic git stash or sidecar backup under `~/.syncskill/.backups/sources/<source>/pre-update/`.

`source add`, `source update`, and `source restore` were removed in v2. Install new sources with `syncskill install <url-or-path>`, then use `source list`, top-level `update`, and `source remove` to maintain them.

### Installing Skills

```bash
# Show install help
syncskill install

# Install the syncskill skill itself
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
| `--path <path>` | Repo-relative subdirectory within the source checkout containing skills (use `.` for repo root) |
| `--skill-subdir <dir>` | Alias for `--path` |
| `--type <type>` | Force source type detection (`git`, `http`, `local`) |
| `--branch <branch>` | Git branch or tag |
| `-y, --yes` | Skip confirmation prompts |

`syncskill install` with no target shows help. Use `install self` for the built-in skill or `install <url-or-path>` for external sources.
Repeated installs from the same git or HTTP source reuse the existing source entry. If the new request widens the scope, syncskill expands the recorded `path` and writes unrelated skills to `config.sources[*].ignore[]` instead of creating duplicate source records. If the requested skills are already present, syncskill reports them as already installed instead of treating the install as a silent no-op.

For v2 plan-then-execute workflows, both `install self` and `install <url-or-path>` support the global `--plan`, `--apply`, and `--resolutions` flags. Save the generated plan with shell redirection when needed. This is the supported way to preview or hand off built-in and external installs before making changes.

### Typical Loop

1. Add or edit a skill under `~/.syncskill/skills/`
2. Run `syncskill scan` to register newly discovered skills
3. Run `syncskill link build` or `syncskill link set <skill> <agents...>` to publish links into agent directories
4. Use `syncskill install`, `syncskill source list`, and `syncskill update` to manage external sources

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

# Refresh both local and remote manifest state, then show status
syncskill refresh alpha

# Restore the latest pre-pull backup for one skill
syncskill restore welcome

# Only mark one tracked server manifest as conflict after restore
syncskill restore welcome --server beta

# Preview restore without changing files or manifests
syncskill restore welcome --dry-run
```

`restore <skill>` replays the latest `~/.syncskill/.backups/skills/<skill>/pre-pull/` snapshot into the local skill directory, saves the current local state first under `~/.syncskill/.backups/skills/<skill>/pre-restore/`, and marks tracked manifests as conflict so you can review and resolve the restored state explicitly.

Recommended flow:

1. Run `syncskill status` to see all tracked server rows
2. Run `syncskill diff alpha` to focus on one server
3. If a skill is in conflict, run `syncskill resolve <skill>` (interactive or with `--local`/`--remote`)
4. If you need to roll back the last pull/sync overwrite locally, run `syncskill restore <skill>` and then review the resulting conflict state
5. Run `syncskill refresh alpha` when you want to refresh manifest state before reviewing again

## Remote Lifecycle Workflow

Use remote lifecycle commands to manage configured remotes and inspect the local receiver backup that syncskill uses for remote receiver operations.

```bash
# List configured remotes
syncskill remote list

# Refresh remote manifest + receiver backup without pulling content
syncskill refresh --remote alpha

# Show the local receiver backup for one remote
syncskill remote show alpha
```

Recommended flow:

1. Run `syncskill remote list` to see configured remote targets
2. Run `syncskill config show` or inspect `~/.syncskill/config.json` to review transport fields such as `host`, `user`, `port`, `identity_file`, and optional `remote_repo`
3. Run `syncskill refresh --remote alpha` when you want reconciliation to rescan the remote skill tree and update `~/.syncskill/receivers/alpha.json`
4. Run `syncskill remote show alpha` to inspect the resulting local receiver backup (`updated_at`, `remote_agents`, `links`)
5. Use `syncskill remote` / `syncskill config remote` to edit skill → server intent in the matrix UI when needed; this updates `config.json` and the next `push` seeds missing per-server backup links for included skills.
6. Run `syncskill pull alpha` when you want to materialize remote skill contents locally.

Note: `server probe` was removed in v2.

If you need to validate connectivity, use your normal SSH command path first, then run `refresh`, `pull`, or `push` from syncskill.

```bash
ssh -i ~/.ssh/id_ed25519 user@example.com
syncskill refresh --remote alpha
```

Expected configuration now lives in `~/.syncskill/config.json`.

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

Remote sync options:

| Option | Commands | Description |
|--------|----------|-------------|
| `--timeout <seconds>` | `push`, `pull`, `sync` | Override the default SSH/rsync timeout |
| `--cross-server-policy <policy>` | `pull`, `sync` | Resolve cross-server conflicts with `first-wins`, `last-wins`, `abort`, `prompt`, or `server:<name>` |
| `--on-conflict <policy>` | `pull`, `sync` | Resolve per-server conflicts with `keep-local`, `keep-remote`, `skip`, or `abort` |
| `--on-remote-deletion <policy>` | `pull`, `sync` | Handle remote deletions with `keep-local`, `delete`, or `prompt` |

Use `--timeout` when a remote server is slow to respond or you want the command to fail faster than the system SSH defaults. Use `--on-remote-deletion` when you need to choose how remote deletions affect local skills.

Local pre-pull backups for `pull` / `sync` are controlled by `config.pull_backup` and `SYNCSKILL_PULL_BACKUP`; `--no-pull-backup` is no longer a public CLI flag.

Set `SYNCSKILL_STRICT=1` when automation should treat partial skip outcomes as exit code 6.

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

1. Configure servers in `~/.syncskill/config.json`
2. Optionally validate SSH access outside syncskill
3. Run `syncskill refresh --remote alpha` to update remote manifest state
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
syncskill link edit

# Edit skill -> remote sync mapping (matrix editor)
syncskill remote
syncskill config remote

# Add or inspect configured remotes
syncskill remote add alpha --host alpha.example.com --user alice --remote-repo /srv/syncskill
syncskill remote list
syncskill remote show alpha
```

Note: `syncskill remote` with no subcommand opens the remote matrix editor. Use `syncskill config remote` for the same UI entrypoint.

## Diagnostics

```bash
# Check config for issues
syncskill doctor

# Interactive repair
syncskill doctor --fix

# Auto-repair all fixable issues
syncskill doctor --fix -y

```

The doctor command checks for:
- Invalid agent paths
- Skills in links that don't exist
- Agents in links that aren't configured
- Invalid source paths
- Stale or corrupt skills-registry.json entries

`syncskill doctor --fix` leaves `AGENT_PATH_DUPLICATE` warnings for manual resolution.

## Global Options

| Option | Description |
|--------|-------------|
| `--json` | Output JSONL events instead of human-readable text |
| `--no-interactive` | Disable interactive prompts and fail if input is required |
| `--plan` | Print a plan without executing it |
| `--apply <path>` | Execute a previously generated plan file |
| `--resolutions <path>` | Provide a resolutions file for unresolved plan items |
| `--no-refresh` | Skip automatic manifest refresh before commands |
| `-y, --yes` | Skip confirmation prompts |
| `--yes-destructive` | Allow destructive actions in non-interactive mode |
| `--dry-run` | Preview changes without executing |

Global environment variable equivalents:

| Variable | Description |
|----------|-------------|
| `SYNCSKILL_DIR` | Override the default `~/.syncskill` runtime directory |
| `SYNCSKILL_CONFIG` | Override the config file path |
| `SYNCSKILL_JSON` | Enable JSON mode (same as `--json`) |
| `SYNCSKILL_NO_INTERACTIVE` | Disable interactive prompts |
| `SYNCSKILL_STRICT` | Exit with code 6 on partial skip results when set to `1` |
| `SYNCSKILL_PULL_BACKUP` | Disable (`0`) or force (`1`) local pre-pull backups for `pull` / `sync` |

Common automation examples:

```bash
syncskill --json status
syncskill --no-interactive link build
syncskill --json link list
SYNCSKILL_JSON=1 SYNCSKILL_NO_INTERACTIVE=1 syncskill status
```

JSON mode emits JSONL events, which makes it easier to stream progress and parse command output incrementally.

## Exit Codes

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
