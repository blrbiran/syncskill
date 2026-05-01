# Design Guide

## Module boundaries

### `src/index.ts`

Owns CLI registration, command parsing, option handling, and human-facing command descriptions. It wires subcommands to the implementation modules without owning storage or transport details.

### `src/config.ts`

Owns config path helpers, config loading and saving, default config generation, validation, dotted-path updates, and server lookup helpers.

### `src/repo.ts`

Owns local repository initialization under `~/.syncskill/`, initial config bootstrapping, copying the example config, and first-run migration of detected local skills.

### `src/manifest.ts`

Owns local skill hashing, manifest persistence, manifest history persistence, and helpers that update recorded local and remote hashes over time.

### `src/conflict.ts`

Owns manifest delta classification, status and diff row derivation, and explicit conflict resolution logic for choosing local or remote state.

### `src/source.ts`

Owns configured source definitions, source materialization, source state tracking, and ownership checks for skills imported from local, git, or http sources.

### `src/transport.ts`

Owns SSH and rsync transport primitives, remote receiver deployment, remote manifest exchange, and receiver fallback coordination for remote skill import/export behavior. The receiver-side command implementation itself still lives in `src/receiver/sync_receiver.mjs`.

### `src/sync_engine.ts`

Owns push, pull, and sync orchestration across configured servers. It combines config loading, manifest preparation, conflict policy application, transport operations, and manifest persistence.

## Architecture boundaries

The system is intentionally split so each layer has one primary concern:

- CLI layer: `src/index.ts`
- local configuration and repository state: `src/config.ts` and `src/repo.ts`
- reconciliation state model: `src/manifest.ts` and `src/conflict.ts`
- external skill ingestion: `src/source.ts`
- remote communication: `src/transport.ts`
- high-level synchronization workflow: `src/sync_engine.ts`

## State model

Local state lives under `~/.syncskill/`:

- `config.yaml` for configuration
- `skills/` for managed local skills
- `manifests/` for per-server reconciliation snapshots
- `manifest_history.json` for manifest history
- `.sources/` state for materialized sources

Remote synchronization exchanges skill trees plus manifest state, while transport details remain isolated from conflict and orchestration logic.
