# syncskill

`syncskill` is a CLI for organizing AI agent skills in a local `~/.syncskill/` repository, linking them into agent-specific skill directories, and reconciling local state with remote servers.

## Install

```bash
npm install
npm run build
```

## Build and run

```bash
npm run build
node dist/index.js --help
```

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

### Sources

- `syncskill source add <name> --type <local|git|http> --url <url> --store <store> [--ref <ref>]`
- `syncskill source update [name]` (omit `name` to update all configured sources)
- `syncskill source list`

### Remote sync

- `syncskill push [--all | <server>]`
- `syncskill pull <server>`
- `syncskill sync [--all | <server>]`

## Docs

- [Configuration Guide](docs/config-guide.md)
- [Usage Guide](docs/usage-guide.md)
- [Design Guide](docs/design-guide.md)
