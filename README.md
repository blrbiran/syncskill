# syncskill

`syncskill` is a CLI for organizing AI agent skills in a local `~/.syncskill/` repository, linking them into agent-specific skill directories, and reconciling local state with remote servers.

## Install from source

```bash
npm install
npm run build
npm link
syncskill --help
```

## Run the built entrypoint directly

```bash
node dist/index.js --help
```

If you prefer not to `npm link`, you can run the built CLI directly from `dist/`.

## Quick start

```bash
node dist/index.js init
node dist/index.js config show
node dist/index.js scan --all-agents
node dist/index.js link --all
node dist/index.js status
```

You can also invoke the built CLI as `syncskill` after building or wiring it into your local toolchain.

## Commands overview

### Local setup

- `syncskill init`
- `syncskill config`
- `syncskill config show`
- `syncskill config set <key> <value>`
- `syncskill link [skill] --all|--status|--unlink <skill>`
- `syncskill scan --all-agents`

### Reconciliation

- `syncskill status`
- `syncskill diff <server>`
- `syncskill resolve <skill> --take local|remote`
- `syncskill refresh [--local | --remote | --status] [server]`

### Remote lifecycle

- `syncskill server list`
- `syncskill server show <name>`
- `syncskill server probe <name>`
- `syncskill refresh --remote --status <server>`

Use `refresh --remote` when you want reconciliation to reflect the real remote skill tree without pulling remote skill contents into the local repository.
Use `pull` when you want to copy remote skill contents into the local repository.
Use `server show` and `server probe` to inspect the configured `host`, `user`, `port`, `identity_file`, and `remote_agents` paths before mutating sync operations.

### Sources

- `syncskill source add <name> --type <local|git|http> --url <url> --store <store> [--ref <ref>]`
- `syncskill source update [name]` (omit `name` to update all configured sources)
- `syncskill source list`

### Remote sync

- `syncskill push [--all | <server>]`
- `syncskill pull <server>`
- `syncskill sync [--all | <server>]`

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

## Docs

For remote workflow details, see the usage and configuration guides.

- [Configuration Guide](docs/config-guide.md)
- [Usage Guide](docs/usage-guide.md)
- [Design Guide](docs/design-guide.md)
