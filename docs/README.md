# Syncskill Documentation

Documentation for the syncskill CLI tool.

## Guides

| Guide | Description |
|-------|-------------|
| [Usage Guide](usage-guide.md) | CLI commands, workflows, and examples |
| [Configuration Guide](config-guide.md) | config.yaml reference and directory structure |
| [Design Guide](design-guide.md) | Architecture, module responsibilities, and sync protocol |

## Quick Links

- **Getting started**: See [Usage Guide - First Run](usage-guide.md#first-run)
- **Dashboard overview**: Run `syncskill` with no args to see the local status dashboard
- **Command reference**: See [Usage Guide](usage-guide.md) or run `syncskill --help`
- **Config file format**: See [Configuration Guide](config-guide.md#configuration-shape)
- **Remote sync setup**: See [Usage Guide - Remote Sync Workflow](usage-guide.md#remote-sync-workflow)
- **Stale symlink cleanup**: The `link` command automatically reconciles and removes stale symlinks
- **Dirty source recovery**: See `source update --force`, `source restore`, and `update-history.json` in the guides below

## Specifications

- [Design Spec](superpowers/specs/syncskill-design.md) - Full implementation specification (Chinese)
- [E2E Test Design](superpowers/specs/e2e-test-design.md) - End-to-End test framework specification (Chinese)

## Testing

- [E2E Test Guide](e2e-test-guide.md) - How to write E2E tests for syncskill
