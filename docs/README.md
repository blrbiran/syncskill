# Syncskill Documentation

Documentation for the syncskill CLI tool.

## Guides

| Guide | Description |
|-------|-------------|
| [Usage Guide](usage-guide.md) | CLI commands, workflows, and examples |
| [Configuration Guide](config-guide.md) | config.json reference and directory structure |
| [Design Guide](design-guide.md) | Architecture, module responsibilities, and sync protocol |

## Quick Links

- **Getting started**: See [Usage Guide - First Run](usage-guide.md#first-run)
- **Dashboard overview**: Run `syncskill` with no args to see the local status dashboard
- **Command reference**: See [Usage Guide](usage-guide.md) or run `syncskill --help` (notably, `link build` reconciles configured links and `unlink <skill>` removes all links for that skill)
- **Config file format**: See [Configuration Guide](config-guide.md#configuration-shape)
- **Remote lifecycle & sync**: See [Usage Guide - Remote Lifecycle Workflow](usage-guide.md#remote-lifecycle-workflow) and [Remote Sync Workflow](usage-guide.md#remote-sync-workflow)
- **Receiver backup state**: See [Configuration Guide - Directory Structure](config-guide.md#directory-structure) for `~/.syncskill/receivers/<server>.json`
- **Stale symlink cleanup**: Run `syncskill link build` to reconcile configured links and remove stale symlinks
- **Dirty source recovery**: See top-level `update --force` and the `~/.syncskill/.backups/` sidecar backup notes in the guides below
- **Install UX**: In a TTY, `syncskill install` opens an interactive menu instead of only showing help

## Specifications

- [Design Spec](superpowers/specs/syncskill-design.md) - Full implementation specification (Chinese)
- [E2E Test Design](superpowers/specs/e2e-test-design.md) - End-to-End test framework specification (Chinese)

## Testing

- [E2E Test Guide](e2e-test-guide.md) - How to write E2E tests for syncskill
