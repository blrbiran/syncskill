# Usage Guide

## First run

Initialize the local repository, inspect the generated configuration, scan for managed skills, and link them into configured agent directories.

```bash
syncskill init
syncskill config show
syncskill scan --all-agents
syncskill link --all
```

After `init`, local state lives under `~/.syncskill/`, including the managed skill tree, manifests, and config file.

## Local workflow

Use the local workflow when you are curating skills on one machine.

```bash
syncskill scan --all-agents
syncskill link --status
syncskill link welcome
syncskill source list
syncskill source update --all
```

Typical loop:

1. Add or edit a skill under `~/.syncskill/skills/`.
2. Run `syncskill scan --all-agents` to register newly discovered skills.
3. Run `syncskill link --all` or `syncskill link <skill>` to publish links into agent directories.
4. Use `syncskill source add`, `syncskill source update`, and `syncskill source list` when part of your skill tree is materialized from local, git, or http sources.

## Reconciliation workflow

Use reconciliation commands to understand drift between local state, recorded manifest state, and a remote server.

```bash
syncskill status
syncskill diff alpha
syncskill resolve welcome --take local
syncskill refresh --status alpha
```

Recommended flow:

1. Run `syncskill status` to see all tracked server rows.
2. Run `syncskill diff alpha` to focus on one server.
3. If a skill is in conflict, run `syncskill resolve <skill> --take local` or `syncskill resolve <skill> --take remote`.
4. Run `syncskill refresh --status alpha` when you want to refresh stored local and remote manifest state before reviewing again.

## Remote sync workflow

Use the sync commands once a server is configured under `servers`.

```bash
syncskill push alpha
syncskill pull alpha
syncskill sync --all
```

Typical remote flow:

1. Configure one or more servers in `~/.syncskill/config.yaml`.
2. Run `syncskill push alpha` to publish local changes to one server.
3. Run `syncskill pull alpha` to fetch remote changes into the local repository.
4. Run `syncskill sync --all` to perform pull-then-push orchestration across all configured servers.
