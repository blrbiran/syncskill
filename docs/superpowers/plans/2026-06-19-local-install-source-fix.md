# 2026-06-19 Local Install Source Fix

## Goal

Restore the spec-promised `syncskill install <url-or-path>` local-directory flow without expanding this task into a broader `install` architecture rewrite.

## Confirmed Drift

- The spec and docs say `install <url-or-path>` supports local directories: `docs/superpowers/specs/syncskill-design.md:960-969`, `README.md:94-96`.
- `detectSourceType()` correctly classifies `~/code/skills/llmfusion` as `local`: `src/source.ts:156-162`.
- `addSourceFromUrl()` only special-cases local archives, then falls through to `parseGitHubUrl()` for plain local directories: `src/source.ts:1975-2073`.
- The fallback error still mentions `--url`, which no longer exists on the public `install` command surface: `src/source.ts:2064-2073`, `src/index.ts:1472-1479`.
- Non-archive local source paths still rely on `resolve(source.url)` / `resolve(source.url, source.path)` and therefore keep `~` as a literal path segment unless expanded earlier: `src/install.ts:145-163`, `src/source.ts:1594-1600`.

## Scope

1. Fix plain local-directory installs (`install /abs/path`, `install ./rel/path`, `install ~/path`).
2. Normalize local source roots consistently so persisted config and filesystem operations use expanded absolute paths.
3. Replace the stale fallback error/help text with wording that matches the current `install` interface.
4. Add targeted unit/integration coverage for the repaired behavior.

## Non-Goals

- Do **not** implement full external-source `--plan` / `--apply` support in this task. Current code only routes `install self` through `withPlanExecute()` (`src/index.ts:1410-1438`), while external installs still use the direct execution path.
- Do **not** broaden this into same-repo merge refactors or source dedupe redesign unless the local-directory fix directly needs a tiny shared helper.
- Do **not** change the documented `config.sources[*].path` contract: it must remain source-root-relative for local/git/http sources.

## Proposed Fix Design

### 1. Add an explicit plain-local-directory branch in `addSourceFromUrl()`

Target: `src/source.ts`

Insert a branch next to the existing local-archive handling:

- After `detectSourceType(urlOrName)`, if `detected?.type === 'local' && !detected.isArchive`:
  - expand `~`
  - resolve to an absolute source root
  - validate the path exists (spec plan-phase contract says local input should pass `fs.stat` validation)
  - build `SourceDefinition` as:
    - `type: 'local'`
    - `url: <expanded absolute local root>`
    - `path: options.skillSubdir ?? options.path ?? '.'`
  - infer `name` from the directory basename unless `--name` is provided
  - persist through `addSource()` and return early

This keeps the control flow parallel to the existing local-archive branch and prevents local directories from ever reaching the GitHub URL parser.

### 2. Introduce one shared local-path normalizer

Recommended target: `src/utils/utils.ts`

Add a tiny helper for non-agent filesystem paths, e.g. `expandHomePath()` or `resolveHomePath()`.

Use it in the local-source path entrypoints that currently rely on raw `resolve(source.url)`:

- `src/source.ts` local archive path normalization
- `src/source.ts` local materialized root calculation
- `src/install.ts` local checkout/materialized root helpers

Recommendation: keep `resolveAgentPath()` scoped to agent config paths and avoid reusing that name for sources. If helpful, `resolveAgentPath()` can later delegate to the new generic helper, but that refactor is optional and should not be required for this bug fix.

### 3. Keep persisted config aligned with the existing source contract

For local directory installs, persist:

- `source.url` = expanded absolute local source root
- `source.path` = relative subdirectory within that root (`.` by default)

Do **not** store `~` in config, and do **not** move the absolute path into `source.path`.

This matches the current documented contract in `docs/config-guide.md:331` and existing cerebrum guidance that `config.sources[*].path` must stay relative.

### 4. Update the fallback error text

Target: `src/source.ts`

When input is still unsupported/ambiguous after detection, replace the stale `--type, --url, and --path` hint with text that matches the current `install` UX.

Recommended direction:

- mention supported forms: Git URL, HTTP archive URL, local directory, local archive
- for ambiguous inputs, point to `--type` and `--path`
- do **not** mention `--url`

This should remain a narrow wording fix; no command-surface changes are needed.

## Test Plan

### Unit

1. `tests/unit/source.test.ts` or `tests/unit/source-github-url.test.ts`
   - `addSourceFromUrl(homeDir, <absolute-local-dir>)` registers a local source with `path: '.'`
   - `addSourceFromUrl(homeDir, '~/...')` expands to an absolute path before persisting
   - fallback error no longer mentions removed `--url`

2. `tests/unit/install.test.ts`
   - local install wrapper passes through correctly and no longer throws `Could not parse URL` for a valid local directory

### Integration

1. `tests/integration/install-cli.test.ts`
   - `syncskill install <absolute-local-dir> -y` installs/link skills from a local directory source
   - `syncskill install ~/... --type local --path . -y` (or direct `~/...` if the CLI fix covers it end-to-end) works under the test HOME and stores an expanded absolute source root in config

2. If error wording is asserted anywhere in help/docs tests, update those targeted assertions only.

## Validation

- `npm run build`
- `vitest run tests/unit/source*.test.ts tests/unit/install.test.ts`
- `vitest run tests/integration/install-cli.test.ts`

## Follow-Up (Separate Task)

The spec describes full external-install plan/execute behavior (`docs/superpowers/specs/syncskill-design.md:963-992`), but the current implementation only supports that machinery for `install self`. After this bug is fixed, decide separately whether to:

1. keep external install on the direct path and tighten the spec/docs around current behavior, or
2. fully migrate external install onto the shared plan/execute contract.
