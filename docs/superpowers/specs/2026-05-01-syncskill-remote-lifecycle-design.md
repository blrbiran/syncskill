# syncskill Remote Lifecycle — Design

> Date: 2026-05-01
> Status: drafted in conversation, pending user review
> Based on: `docs/superpowers/specs/2026-05-01-syncskill-ship-readiness-design.md`

## Goal

Define the next post-ship-readiness milestone for `syncskill`: complete remote state refresh against real remote skill directories, add lightweight remote lifecycle commands for inspection and probing, and document source-based installation flows including `npm link`.

## Why this stage exists

The current CLI already supports `push`, `pull`, `sync`, and the command shape for `refresh --remote`, but remote refresh is still incomplete. The most valuable next step is to close that gap and give users a small remote operations surface for understanding configured servers before they run mutating sync commands.

This stage also needs to document the source-install workflow more clearly so developers can build from source and expose `syncskill` through `npm link` without guessing the steps.

## Scope

This stage includes:

1. Remote refresh completion
   - implement the real behavior behind `refresh --remote`
   - read remote manifest state
   - scan real remote skill directories
   - recalculate remote hashes
   - reconcile remote manifest entries against real remote directories
   - write the corrected manifest back to the remote server
   - update the locally stored manifest view for the same server

2. Remote lifecycle commands
   - add `server list`
   - add `server show <name>`
   - add `server probe <name>`

3. Documentation updates
   - document `refresh --remote` behavior in user-facing docs
   - document the new `server` command group in README and usage/config docs
   - add source-install guidance including `npm install`, `npm run build`, `npm link`, and `syncskill --help`
   - keep the direct built-entrypoint flow (`node dist/index.js --help`) documented alongside `npm link`

## Non-goals

This stage does not include:

- new sync policy modes beyond the confirmed refresh semantics
- automatic remediation in `server probe`
- release automation or npm publish design
- broad CI/CD changes
- remote write operations beyond the specific remote manifest rewrite performed by `refresh --remote`
- changing the meaning of `push`, `pull`, or `sync`
- refactoring unrelated stable modules

## Command and behavior contract

### Existing command completed in this stage

#### `refresh [server] --remote`

The command keeps its existing CLI shape.

Confirmed behavior for `refresh --remote <server>`:

1. connect to the selected server
2. read the current remote manifest
3. scan the real remote skill directories
4. recalculate remote skill hashes from the real remote directories
5. treat the real remote directories as the source of truth
6. reconcile the remote manifest so it matches the real remote directories
7. write the corrected manifest back to the remote server
8. save the same corrected manifest locally
9. recompute local reconciliation view so `status` and `diff` reflect the refreshed remote state
10. if `--status` is provided, print refreshed status rows after the refresh completes

Remote refresh correction rules:

- if a skill exists in the remote manifest but no longer exists in the real remote directory tree, remove or clear that remote skill entry in the corrected manifest
- if a skill exists in the real remote directory tree but not in the remote manifest, add it to the corrected manifest
- if both exist but the hash differs, update the remote hash to match the real remote content
- if the remote skill root path does not exist, the command fails instead of treating it as an empty remote tree

### New command group introduced in this stage

#### `server list`

Purpose:
- list configured remote server names from config

Behavior:
- prints one configured server name per line
- does not connect to any remote host

#### `server show <name>`

Purpose:
- show the configured shape of one remote server without contacting it

Behavior:
- prints a human-readable summary of the selected server
- includes enough information to inspect host, user/port overrides if present, and configured remote agent roots
- does not mutate local or remote state

#### `server probe <name>`

Purpose:
- perform a read-only remote health/probe check before sync operations

Behavior:
- checks transport reachability
- checks whether receiver invocation is available if required by the implementation path
- checks whether the remote manifest path is readable or creatable as expected
- checks whether the remote skill root paths are reachable
- reports results item-by-item instead of failing on the first check
- returns a non-zero exit code if the overall probe fails
- does not push, pull, sync, or repair remote state

## Documentation contract

### README.md

Should explain both installation paths:

1. source-based local install:

```bash
npm install
npm run build
npm link
syncskill --help
```

2. direct built-entrypoint usage:

```bash
node dist/index.js --help
```

README should also mention the new `server` command group and point readers to the usage/config docs for the remote workflow details.

### docs/usage-guide.md

Should document:
- when to use `refresh --remote`
- how `refresh --remote` differs from `pull`
- a remote lifecycle workflow using `server list`, `server show`, `server probe`, and `refresh --remote`
- source-install usage via `npm link`

### docs/config-guide.md

Should document any config details needed to understand:
- which server fields are used by `server show`
- which remote paths are validated by `server probe`
- which configured remote agent roots are scanned by `refresh --remote`

## Module boundaries

### `src/index.ts`

Owns CLI registration:
- keep `refresh --remote` under the existing `refresh` command
- add the new `server` command group and command descriptions
- avoid placing transport logic directly in this file

### `src/refresh.ts`

Owns refresh orchestration:
- decide whether local refresh, remote refresh, or both are being run
- coordinate loading, reconciling, and saving the corrected manifest state
- keep the refresh result formatting consistent with the rest of the CLI

### `src/transport.ts`

Owns remote interaction primitives:
- reading remote manifest data
- invoking remote receiver-side scan/refresh helpers if needed
- checking remote paths and probe prerequisites
- writing corrected remote manifest state

### `src/receiver/sync_receiver.mjs`

Should hold remote-side filesystem-aware helpers if the implementation chooses to execute remote scanning and hash calculation on the server side. This keeps remote directory walking and hashing close to the remote filesystem instead of embedding brittle shell logic in transport commands.

### `src/server.ts` or equivalent small module

Recommended for:
- server list/show/probe orchestration
- formatting of human-readable output
- keeping `src/index.ts` and `src/refresh.ts` smaller and easier to reason about

## Data flow

### Remote refresh flow

1. resolve the target server
2. establish remote transport
3. read the current remote manifest
4. enumerate the real remote skill directories
5. calculate hashes for remote skill content
6. build a corrected remote manifest using real remote directories as source of truth
7. write the corrected manifest back to the remote server
8. persist the same corrected manifest locally
9. run reconciliation on that manifest for local views
10. return refreshed manifests and optional formatted status lines

### Server probe flow

1. resolve configured server fields
2. check transport connectivity
3. check remote manifest accessibility
4. check remote agent root accessibility
5. check receiver availability when needed by the chosen implementation
6. emit one result row per check
7. derive the final exit status from the combined results

## Failure semantics

### `refresh --remote`

- if the remote skill root path is missing, fail the command
- if remote scanning succeeds but writing the corrected remote manifest fails, fail the command and do not report success
- if the remote manifest is missing but remote skill directories exist, allow refresh to generate a new manifest from the real remote directories
- if one remote path is unreadable, surface the error clearly and do not silently collapse it into an empty tree

### `server probe`

- should report every check result it can gather
- should not mutate state as part of failure handling
- may return non-zero when any required check fails

## Test strategy

### Unit tests

Cover:
- corrected remote-manifest construction rules
- server list/show/probe formatting helpers
- refresh/probe option handling and narrow orchestration helpers

### Integration tests

Cover:
- `refresh --remote` orchestration against controlled remote-like fixtures
- remote manifest rewrite behavior
- `server list/show/probe` CLI wiring
- transport and receiver collaboration for remote scanning

Integration tests are required to pass before this milestone is merged to `main`.

### End2end tests

Optional and intentionally narrow:
- one built-CLI path for the new remote lifecycle surface if the final plan decides it is worth the cost
- otherwise keep end2end coverage focused on existing shipped entrypoint sanity

## Acceptance criteria

This stage is complete when:

1. `refresh --remote` no longer behaves as future work and instead refreshes real remote state
2. remote refresh rewrites the remote manifest to match the real remote skill directories
3. local stored manifests reflect the same corrected remote state after refresh
4. `server list`, `server show <name>`, and `server probe <name>` exist and behave as read/inspection commands
5. probe reports multiple check results and does not silently repair remote state
6. README and usage/config docs explain the new remote lifecycle commands
7. README and usage docs both document source-install flow with `npm link`
8. the built-entrypoint flow remains documented alongside the `npm link` flow
9. integration tests for the new remote lifecycle behavior pass before merge
