# Configuration Guide

`syncskill` stores its runtime state under `~/.syncskill/`. The main configuration file is `~/.syncskill/config.yaml`.

## Configuration shape

The current config model includes these top-level keys:

- `version`
- `conflict_resolution`
- `agents`
- `links`
- `servers`
- `sources`

## Example

```yaml
version: 1
conflict_resolution: manual
agents:
  claude: /Users/alice/.claude/skills
  qoder: /Users/alice/.qoder/skills
links:
  welcome:
    - claude
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
    url: https://example.com/skills/internal-playbooks.git
    store: skills
    ref: main
  local-experiments:
    type: local
    url: /Users/alice/dev/local-skills
    store: .
```

## Fields

### `version`

Configuration schema version. The current implementation uses `version: 1`.

### `conflict_resolution`

Default reconciliation policy for manifest conflicts.

Supported values:

- `manual` — keep conflicts unresolved until you inspect them with `status`, `diff`, and `resolve`
- `keep-local` — auto-resolve conflicts in favor of the local skill tree during sync operations
- `keep-remote` — auto-resolve conflicts in favor of the remote server state during sync operations

### `agents`

Maps local agent names to their skill directories. `syncskill init` can detect known agent homes such as `.claude/skills` and `.qoder/skills` and write them here.

Example:

```yaml
agents:
  claude: /Users/alice/.claude/skills
  qoder: /Users/alice/.qoder/skills
```

### `links`

Maps each managed skill name to one or more target agents. `syncskill link` uses this mapping to create links from `~/.syncskill/skills/<skill>` into each configured agent directory.

Example:

```yaml
links:
  welcome:
    - claude
  release-checklist:
    - claude
    - qoder
```

### `servers`

Defines named remote sync targets used by `diff`, `push`, `pull`, and `sync`.

Each server entry supports:

- `host`
- optional `user`
- optional `port`
- optional `identity_file`
- `remote_agents`

Example:

```yaml
servers:
  alpha:
    host: alpha.example.com
    user: alice
    remote_agents:
      claude: /home/alice/.claude/skills
```

### `sources`

Defines external skill sources that can materialize content into the local sync repository with `source add`, `source update`, and `source list`.

Supported source types in the current implementation:

- `local`
- `git`
- `http`

Each source entry includes:

- `type`
- `url`
- `store`
- optional `ref`

Example:

```yaml
sources:
  vendor-docs:
    type: git
    url: https://example.com/skills/vendor-docs.git
    store: skills
    ref: stable
```
