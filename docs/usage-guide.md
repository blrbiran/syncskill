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
syncskill source update
syncskill source update vendor-docs
```

Typical loop:

1. Add or edit a skill under `~/.syncskill/skills/`.
2. Run `syncskill scan --all-agents` to register newly discovered skills.
3. Run `syncskill link --all` or `syncskill link <skill>` to publish links into agent directories.
4. Use `syncskill source add`, `syncskill source update`, and `syncskill source list` when part of your skill tree is materialized from local, git, or http sources. Run `syncskill source update` with no name to update every configured source, or pass a source name to update just one.

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
4. Run `syncskill refresh --status alpha` when you want to refresh stored local manifest state before reviewing again.

## Remote lifecycle workflow

Use the remote lifecycle commands when you want to inspect server wiring or refresh reconciliation state from the real remote skill tree without pulling skill contents into the local repository.

```bash
syncskill server list
syncskill server show alpha
syncskill server probe alpha
syncskill refresh --remote --status alpha
```

Recommended flow:

1. Run `syncskill server list` to see the configured remote targets.
2. Run `syncskill server show alpha` to inspect `host`, `user`, `port`, `identity_file`, and configured `remote_agents` roots.
3. Run `syncskill server probe alpha` before the first sync or after changing remote paths.
4. Run `syncskill refresh --remote --status alpha` when you want reconciliation to reflect the real remote skill tree without pulling content into the local repo.
5. Run `syncskill pull alpha` when you want to materialize remote skill contents locally.

## Remote sync workflow

Use the sync commands once a server is configured under `servers`.

```bash
syncskill push alpha
syncskill pull alpha
syncskill sync --all
```

Typical remote flow:

1. Configure one or more servers in `~/.syncskill/config.yaml`.
2. Run `syncskill server probe alpha` to confirm transport, receiver, manifest, probe, and remote agent path health.
3. Run `syncskill refresh --remote --status alpha` to update remote manifest state from the live remote directories.
4. Run `syncskill push alpha` to publish local changes to one server.
5. Run `syncskill pull alpha` to fetch remote changes into the local repository.
6. Run `syncskill sync --all` to perform pull-then-push orchestration across all configured servers.

## Install from source

```bash
npm install
npm run build
npm link
syncskill --help
```

You can also skip `npm link` and run the built entrypoint directly:

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

