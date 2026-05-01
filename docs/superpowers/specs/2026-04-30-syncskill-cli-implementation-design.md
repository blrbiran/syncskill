# syncskill CLI — Implementation Design

> Date: 2026-04-30
> Status: approved in conversation, written for execution handoff
> Based on: `docs/superpowers/specs/syncskill-typescript-design.md`

## Goal

Implement the `syncskill` TypeScript CLI described in the existing design spec, but execute it in staged milestones so the project stays shippable, testable, and compatible with subagent-based delivery.

## Scope

This implementation design keeps the original product scope intact: all commands and remote sync behaviors in the TypeScript design spec are still in scope.

The delivery strategy changes from “build everything as one effort” to “build by functional domain in milestones”.

## Delivery Strategy

The project will be implemented in four milestones.

### Milestone 1 — Local foundation

Deliver the local repository and configuration capabilities:

- `init`
- `config`
- `config show`
- `config set`
- `link`
- `scan`

Primary files:

- `src/index.ts`
- `src/config.ts`
- `src/config-ui.ts`
- `src/repo.ts`
- `src/linker.ts`

Expected outcome:

- `~/.syncskill/` is the single local data root
- config can be loaded, validated, updated, and displayed
- local skills can be migrated, scanned, and linked into detected agent directories
- platform-specific link fallback behavior works on supported systems

### Milestone 2 — State and reconciliation

Deliver the local state model used to reason about synchronization:

- `status`
- `diff <server>`
- `resolve <skill> --take local|remote`
- `refresh [--local | --remote | --status] [server]`

Primary files:

- `src/manifest.ts`
- `src/conflict.ts`
- `src/refresh.ts`

Expected outcome:

- local and remote sync state can be represented consistently
- MD5 hashing is compatible with the Python version described in the base spec
- delta decisions can distinguish `push`, `pull`, `skip`, `conflict`, and new skills
- manifest history is appended only when hashes actually change
- conflicts can be surfaced and resolved deterministically

### Milestone 3 — External sources

Deliver management for external skill sources:

- `source add`
- `source update`
- `source list`

Primary file:

- `src/source.ts`

Expected outcome:

- git, http, and local sources can be defined in config and materialized into the local sync store
- source updates are testable without coupling them to remote sync
- local-source behavior remains compatible with later push behavior, where file contents are copied remotely rather than pushing symlink metadata

### Milestone 4 — Remote transport and full sync

Deliver real remote synchronization:

- `push [--all | <server>]`
- `pull <server>`
- `sync [--all | <server>]`

Primary files:

- `src/transport.ts`
- `src/sync_engine.ts`
- `src/receiver/bootstrap_remote.sh`
- `src/receiver/sync_receiver.mjs`

Expected outcome:

- SSH and rsync transport are real, not mocked application behavior
- remote receiver deployment works on first push
- manifests can be exchanged and reconciled across local and remote
- push, pull, and full sync behave according to the original protocol
- conflict policies still apply when local and remote both changed

## Module Boundaries

### `src/index.ts`

Owns command registration, argument parsing, help text, exit codes, and orchestration entrypoints. It should not contain business logic beyond lightweight wiring.

### `src/config.ts`

Owns:

- resolving the `~/.syncskill/` path tree
- reading and writing `config.yaml`
- agent auto-detection
- config validation
- wildcard expansion for links

This module is the shared environment and configuration boundary for the whole CLI.

### `src/config-ui.ts`

Owns the interactive TUI for editing configuration. It should depend on `config.ts` for persistence and validation rather than embedding config logic directly into prompts.

### `src/repo.ts`

Owns `init` behavior:

- creating `~/.syncskill/`
- creating subdirectories
- copying the example config when needed
- migrating existing local skills from known agent directories
- updating `links` when migration imports new skills

### `src/linker.ts`

Owns local skill linking behavior:

- discovering skills
- creating links into target agent directories
- unlinking
- reporting link status
- falling back from symlink to junction to copy when required by platform constraints

### `src/manifest.ts`

Owns:

- stable file traversal and MD5 hashing
- manifest read and write
- history read and write
- delta calculation between local, remote, and recorded state

It must not own transport concerns.

### `src/conflict.ts`

Owns conflict identification and resolution policy. It operates on already-computed state and decides whether a skill is safe to push, safe to pull, or blocked for manual resolution.

### `src/refresh.ts`

Owns auto-refresh orchestration. It coordinates local and remote refresh operations but delegates hashing to `manifest.ts` and remote communication to transport-layer functions.

### `src/source.ts`

Owns external source lifecycle:

- config registration
- clone/download/materialization
- source updates
- mapping source contents into the local skill store

It should remain decoupled from remote push and pull flows.

### `src/transport.ts`

Owns transport primitives:

- SSH execution
- rsync/scp transfers
- receiver existence checks
- receiver deployment
- manifest transfer
- fallback transport when rsync is unavailable

It should not contain synchronization policy.

### `src/sync_engine.ts`

Owns the high-level push, pull, and sync workflows. It composes configuration, manifest comparison, conflict resolution, and transport primitives into the real CLI operations.

### `src/receiver/*`

Owns the remote-side application of synchronized skills. The receiver remains zero-dependency, Node 20+ compatible, and limited to remote file/link application plus remote manifest updates.

## Execution Strategy

Implementation will follow these rules.

### 1. TDD-first

Every new production behavior starts with a failing test, then the smallest implementation needed to make it pass.

### 2. Small, shippable slices

Within each milestone, work is broken into narrow slices that can be reviewed and merged independently.

Examples:

- config path resolution before config mutation commands
- hash compatibility before diff/status commands
- receiver deployment before full sync orchestration

### 3. Subagent-friendly decomposition

Execution will prefer small tasks with isolated file ownership so subagents can work with limited context and the main session can review between tasks.

### 4. Real remote behavior in the final milestone

The user explicitly requested that the remote milestone be fully real:

- real SSH invocation
- real rsync behavior with fallback paths
- real receiver deployment and application
- real manifest round-trips

No placeholder transport layer is acceptable as the milestone endpoint.

## Verification Strategy

### Milestone 1

Test:

- sync dir path resolution
- config load/save/validation
- agent detection
- `init` directory creation and migration behavior
- `link` and `scan` behavior
- link fallback strategy where feasible in testable form

### Milestone 2

Test:

- sorted traversal and hash compatibility
- manifest read/write
- history append behavior
- delta classification
- conflict detection and resolution application
- refresh orchestration behavior

### Milestone 3

Test:

- source config registration
- git source clone and update behavior
- http archive download and extraction behavior
- local source linking/materialization behavior

### Milestone 4

Test:

- SSH command construction
- rsync command construction and behavior
- receiver deployment path
- manifest fetch and push behavior
- push workflow
- pull workflow
- multi-server sync workflow

## Non-Goals

This implementation design does not expand the original product scope.

It does not add:

- extra abstraction layers not required by the CLI
- backward-compatibility shims beyond what the spec requires
- new commands outside the original design
- partially implemented command placeholders presented as complete behavior

## Success Criteria

The implementation is complete when:

1. all commands from the base design spec exist and behave according to that spec
2. milestones 1 through 4 are shippable in order
3. local-only commands work without depending on unfinished remote code
4. remote sync is fully real and usable in the final milestone
5. the codebase remains modular enough for subagent-based execution and review
