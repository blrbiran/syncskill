# syncskill Ship Readiness — Design

> Date: 2026-05-01
> Status: drafted in conversation, pending user review
> Based on: `docs/superpowers/specs/syncskill-typescript-design.md`, `docs/superpowers/specs/2026-04-30-syncskill-cli-implementation-design.md`

## Goal

Define the post-Milestone-4 delivery stage for `syncskill`: turn the already implemented local foundation, reconciliation, external sources, and remote sync capabilities into a CLI that is documented, installable, and verifiable without adding new commands or expanding the sync protocol.

## Why this stage exists

Milestones 1 through 4 delivered the functional CLI surface described in the implementation design. The next highest-value work is not another command family; it is making the current CLI shippable for other users:

- docs must explain the real command set and expected workflows
- packaging must expose a reliable install and execution path
- verification must distinguish low-cost default checks from broader workflow validation
- examples and help output must match the implementation that now exists

This stage intentionally favors productization over feature expansion.

## Scope

This stage includes:

1. Documentation delivery
   - `README.md`
   - `docs/config-guide.md`
   - `docs/usage-guide.md`
   - `docs/design-guide.md`

2. Packaging and installability review
   - `package.json` entrypoints and scripts
   - CLI build/run path
   - `config.example.yaml`
   - command help text consistency in `src/index.ts`

3. Ship-readiness verification
   - build output sanity
   - CLI entrypoint sanity
   - documented quick-start path sanity
   - explicit test tiering and default gate definition

## Non-goals

This stage does not include:

- new commands
- new sync policies
- new source types
- CI/CD expansion or release automation
- npm publish workflow design
- refactoring stable core modules without a ship-readiness reason
- protocol changes in `manifest`, `transport`, `receiver`, or `sync_engine`

## Command and behavior contract

No new command is introduced in this stage.

The existing command surface remains the product contract:

- `init`
- `config`, `config show`, `config set`
- `link`
- `scan`
- `status`
- `diff <server>`
- `resolve <skill> --take local|remote`
- `refresh [--local | --remote | --status] [server]`
- `source add`
- `source update`
- `source list`
- `push [--all | <server>]`
- `pull <server>`
- `sync [--all | <server>]`

This stage may tighten the wording of help text, examples, and error messages so the shipped docs match the implementation, but it must not change the meaning of the commands.

## Test-tier contract

The repository should treat tests as three explicit tiers:

### 1. Unit test

Purpose:
- validate module logic with low setup cost
- validate parsing, formatting, config/example parsing, helper behavior, and narrow command wiring

Gate:
- this is the default required pass gate
- small implementation changes should usually need only unit coverage plus build verification

### 2. Integration test

Purpose:
- validate collaboration across modules, filesystem interactions, and CLI-to-module wiring
- validate build artifacts or command execution in a controlled local environment

Gate:
- not part of the default mandatory pass gate
- run when the change affects workflow boundaries or install/run behavior

### 3. End2end test

Purpose:
- validate realistic user paths from entrypoint to final observable result
- cover init/config/local workflow and remote sync walkthroughs at a higher confidence level

Gate:
- not part of the default mandatory pass gate
- run intentionally for milestone validation, release readiness, or when a change touches the documented golden path

## Verification contract

The default mandatory checks for this stage are:

- relevant `unit test` suite passes
- `npm run build` passes

Additional non-default verification should be available and documented for:

- integration checks for CLI build/run paths
- end2end checks for quick-start and sync workflows

The test layout and scripts should make the tier boundaries obvious so higher-cost suites do not silently become part of the default gate.

## File boundaries

### `README.md`

Owns the external entrypoint:
- what `syncskill` is
- install/build instructions
- quick start
- command overview
- links to detailed docs

It should help a new user become oriented without duplicating every detail from the other docs.

### `docs/config-guide.md`

Owns configuration explanation:
- config shape
- server/source/link examples
- common minimal setups
- field-by-field reference where it helps usage

### `docs/usage-guide.md`

Owns operational workflows:
- first-time setup
- local skill management
- source workflows
- reconciliation workflows
- push/pull/sync workflows
- troubleshooting-oriented usage notes

### `docs/design-guide.md`

Owns high-level architecture:
- module boundaries
- sync state model
- transport vs orchestration responsibilities
- where to look when changing a behavior

It should explain system shape, not serve as a user tutorial.

### `package.json`

Owns packaging metadata and scripts relevant to local delivery:
- `bin`
- `scripts`
- package description and install-facing metadata if needed
- optional script split for test tiers if the current shape is unclear

### `config.example.yaml`

Owns the smallest credible example config that matches the actual command/docs surface.

### `src/index.ts`

Owns help text and command descriptions only to the extent needed to align runtime help with the docs. It should not absorb new business logic in this stage.

### `tests/`

Owns explicit test-tier placement. The repository should make it easy to tell which files belong to unit, integration, and end2end validation.

## Recommended delivery approach

Recommended scope: documentation + packaging + ship checks.

Why this approach:
- it completes the productization arc after the four implementation milestones
- it keeps the scope bounded and avoids reopening core sync behavior
- it creates a stable point from which future work can branch into either release automation or new feature families

## Acceptance criteria

This stage is complete when:

1. `README.md` explains install/build, quick start, and command discovery clearly
2. `docs/config-guide.md`, `docs/usage-guide.md`, and `docs/design-guide.md` exist and reflect the actual implementation
3. `package.json`, `config.example.yaml`, and CLI help text are consistent with the docs
4. the repository has an explicit unit/integration/end2end test structure or equivalently clear tier boundaries
5. the default mandatory pass gate is clearly limited to unit tests plus build
6. broader integration and end2end validation paths are documented and runnable separately
7. no new CLI command or sync protocol behavior is introduced while completing this stage
