# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-18T15:57:07.571Z
> Files: 129 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~612 tok)
- `AGENTS.md` — AGENTS.md (~397 tok)
- `CLAUDE.md` — OpenWolf (~103 tok)
- `config.example.yaml` (~84 tok)
- `LICENSE` — Project license (~284 tok)
- `package-lock.json` — npm lock file (~24651 tok)
- `package.json` — Node.js package manifest (~355 tok)
- `README.md` — Project documentation (~1402 tok)
- `tsconfig.build.json` — TypeScript build configuration (~41 tok)
- `tsconfig.json` — TypeScript configuration (~99 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `config-guide.md` — Configuration Guide (~2641 tok)
- `design-guide.md` — Design Guide (~2878 tok)
- `e2e-test-guide.md` — E2E Test Writing Guide (~3922 tok)
- `README.md` — Project documentation (~349 tok)
- `usage-guide.md` — Usage Guide (~3177 tok)

## docs/superpowers/specs/

- `e2e-test-design.md` — E2E 测试框架设计 (~4850 tok)
- `syncskill-design.md` — Syncskill — TypeScript 实现设计 (~16925 tok)

## skills/syncskill/

- `SKILL.md` — syncskill (~1424 tok)

## src/

- `dashboard.ts` — Exports DashboardSummary, loadDashboardSummary, formatDashboardSummary (~1021 tok)
- `index.ts` — Exports createProgram (~15864 tok)
- `install.ts` — Get the path to the embedded syncskill skill in dist/skills/syncskill/ (~890 tok)
- `linker.ts` — Find stale links - symlinks in agent directories that point to syncskill-managed skills (~4680 tok)
- `refresh.ts` — Auto-refresh manifests hook (~1337 tok)
- `repo.ts` — Exports InitializeRepoOptions, initializeRepo (~1179 tok)
- `source-restore.ts` — Exports RestoreResult, restoreSource (~1318 tok)
- `source.ts` — Git only: Convert source from git to local, keep path directory (~22010 tok)

## src/config/

- `config-doctor.ts` — Config diagnosis and repair (~3986 tok)
- `config-ui.ts` — Interactive TUI config editing (~5956 tok)
- `config.ts` — Resolve an agent path, expanding ~ to the actual home directory. (~2255 tok)
- `matrix-editor.ts` — 2D matrix editor component (~2264 tok)
- `types.ts` — TypeScript type definitions for syncskill configuration (~274 tok)

## src/core/

- `conflict.ts` — 3-way conflict detection and resolution (~1129 tok)
- `manifest.ts` — Hash computation and manifest management (~3316 tok)
- `private-agents.ts` — Compute default link targets for shared and private agent skill directories (~414 tok)
- `server.ts` — Server config formatting (~440 tok)
- `skills-registry.ts` — Exports SkillRegistryEntry, SkillsRegistry, getSkillsRegistryPath, loadSkillsRegistry + 12 more (~2187 tok)
- `sync_engine.ts` — Exports SyncEngineOptions, PushResult, PullResult, SyncStepResult + 3 more (~5424 tok)
- `transport.ts` — Exports ServerProbeResult, TransportRuntime, withTimeout, createTransportRuntime + 9 more (~4280 tok)
- `update-history.ts` — Exports GitUpdateRecord, HttpUpdateRecord, UpdateRecord, UpdateHistory + 6 more (~667 tok)

## src/receiver/

- `bootstrap_remote.sh` (~140 tok)
- `sync_receiver.mjs` — syncRoot: readJson, readStdin, collectFileEntries + 11 more (~3101 tok)

## src/utils/

- `archive.ts` — Exports ArchiveType, ArchiveFormat, detectArchiveFormat, parseContentDisposition + 2 more (~955 tok)
- `backup.ts` — Exports BackupMetaEntry, BackupMeta, getBackupDir, loadBackupMeta + 6 more (~772 tok)
- `utils.ts` — Exports execFileAsync, isNotFoundError, readJsonOrDefault, readFileOrDefault, pathExists (~438 tok)

## tests/end2end/

- `README.md` — Project documentation (~42 tok)
- `smoke.test.ts` — Declares execFileAsync (~319 tok)

## tests/end2end/cases/install/

- `install-local-archive.test.ts` — E2E tests for installing local archive files (.zip, .tar.gz). (~1539 tok)

## tests/end2end/cases/link/

- `link-reconcile.test.ts` — E2E tests for link reconciliation (stale symlink removal, preserving real dirs and external symlinks) (~1716 tok)
- `link-wildcard-change.test.ts` — E2E tests for changing link config from wildcard (*) to specific agents. (~2587 tok)

## tests/end2end/cases/smoke/

- `init.test.ts` — tests/end2end/cases/smoke/init.test.ts (~511 tok)

## tests/end2end/cases/source/

- `source-install-stale.test.ts` — E2E tests for install when stale checkout exists. (~1679 tok)
- `source-stale-checkout.test.ts` — E2E tests for stale checkout handling (URL mismatch, non-git dir) (~1568 tok)
- `source-update-dirty.test.ts` — E2E tests for dirty state detection and backup creation during update (~2704 tok)
- `source-update-http.test.ts` — E2E tests for HTTP source update behavior. (~1854 tok)
- `source-update.test.ts` — tests/end2end/cases/source/source-update.test.ts (~1291 tok)

## tests/end2end/cases/sync/

- `pull-skill-placement.test.ts` — E2E tests for pull skill placement by source type. (~2783 tok)
- `pull-target.test.ts` — Pull target path resolution tests. (~3316 tok)
- `push-server-integrity.test.ts` — E2E tests for push server integrity scenarios (deleted skills, manifest mismatches). (~2650 tok)
- `receiver-update.test.ts` — E2E tests for receiver version update scenarios. (~1320 tok)

## tests/end2end/framework/

- `cleanup.ts` — Prefix for all E2E temp directories. (~387 tok)
- `context.ts` — Agent name to skills directory path mapping. (~5752 tok)
- `e2e-test.ts` — e2eTest() wrapper for vitest it() with E2E options (timeout, network, skip). (~372 tok)
- `guard.ts` — Error thrown when E2E test attempts to access protected paths. (~593 tok)
- `index.ts` — Barrel export for all public E2E framework APIs. (~162 tok)
- `runner.ts` — Result of running a command. (~910 tok)
- `scenario.ts` — E2EScenario builder for declarative test setup with fluent API. (~2146 tok)
- `setup.ts` — Global beforeAll/afterEach hooks for E2E tests (cleanup, diagnostics). (~168 tok)

## tests/end2end/framework/fixtures/

- `archive.ts` — Create an archive file containing skills. (~515 tok)
- `git.ts` — Create a bare git repository. (~876 tok)
- `github.ts` — Official test repository configuration. (~364 tok)
- `index.ts` — tests/end2end/framework/fixtures/index.ts (~62 tok)
- `server.ts` — Create a mock server directory structure. (~599 tok)
- `skill.ts` — Default SKILL.md content template. (~300 tok)
- `stale.ts` — Create a stale git checkout with a mismatched remote URL. (~486 tok)

## tests/helpers/

- `temp-dir.ts` — Create a managed temp directory tracker that auto-cleans after each test. (~138 tok)

## tests/integration/

- `config-cli.test.ts` — Declares homeDir (~4175 tok)
- `config-ui.test.ts` — Declares PromptStub (~4865 tok)
- `discover.test.ts` — Declares tempDirs (~3912 tok)
- `doctor-cli.test.ts` — tests/integration/doctor-cli.test.ts (~1228 tok)
- `help-output.test.ts` — Declares help (~894 tok)
- `install-cli.test.ts` — Declares execFileAsync (~1140 tok)
- `README.md` — Project documentation (~37 tok)
- `reconciliation-cli.test.ts` — Declares actual (~8467 tok)
- `remote-refresh.test.ts` — Declares tempDirs (~669 tok)
- `repo.test.ts` — Declares pathExists (~1942 tok)
- `server-cli.test.ts` — Declares tempDirs (~1061 tok)
- `source-cli.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6530 tok)
- `source-remove.test.ts` — Declares SourceConfig (~3048 tok)
- `source-restore.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~1867 tok)
- `source-update-dry-run.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~1103 tok)
- `source-update-force.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6910 tok)
- `sync-cli.test.ts` — Declares tempDirs (~4296 tok)
- `sync-engine.test.ts` — TransportRuntime: createRuntime (~7558 tok)
- `sync-timeout.test.ts` — Declares program (~273 tok)
- `transport.test.ts` — receiverPath: importReceiverModule, runReceiverCommand, runReceiverApply, createReceiverManifest, cr (~9591 tok)

## tests/unit/

- `backup.test.ts` — Declares result (~1339 tok)
- `config-doctor.test.ts` — Declares DiagnosticItem (~5859 tok)
- `config.test.ts` — Declares tempDirs (~2026 tok)
- `conflict.test.ts` — Declares ServerManifest (~2429 tok)
- `dashboard.test.ts` — Declares ServerManifest (~1422 tok)
- `docs.test.ts` — Declares rootDir (~1320 tok)
- `e2e-cleanup.test.ts` — tests/unit/e2e-cleanup.test.ts (~495 tok)
- `e2e-context.test.ts` — tests/unit/e2e-context.test.ts (~1744 tok)
- `e2e-fixtures-archive.test.ts` — tests/unit/e2e-fixtures-archive.test.ts (~588 tok)
- `e2e-fixtures-git.test.ts` — tests/unit/e2e-fixtures-git.test.ts (~765 tok)
- `e2e-fixtures-github.test.ts` — tests/unit/e2e-fixtures-github.test.ts (~561 tok)
- `e2e-fixtures-server.test.ts` — tests/unit/e2e-fixtures-server.test.ts (~806 tok)
- `e2e-fixtures-skill.test.ts` — tests/unit/e2e-fixtures-skill.test.ts (~582 tok)
- `e2e-fixtures-stale.test.ts` — Declares tempDirs (~535 tok)
- `e2e-guard.test.ts` — tests/unit/e2e-guard.test.ts (~376 tok)
- `e2e-runner.test.ts` — tests/unit/e2e-runner.test.ts (~540 tok)
- `e2e-scenario.test.ts` — Unit tests for E2EScenario builder class. (~931 tok)
- `install.test.ts` — Declares path (~1694 tok)
- `linker.test.ts` — Declares SyncSkillConfig (~6912 tok)
- `manifest.test.ts` — Declares tempDirs (~2630 tok)
- `matrix-editor.test.ts` — Declares config (~2288 tok)
- `package.test.ts` — Declares rootDir (~597 tok)
- `private-agents.test.ts` — Declares tempDirs (~591 tok)
- `README.md` — Project documentation (~35 tok)
- `refresh.test.ts` — Declares tempDirs (~5658 tok)
- `server.test.ts` (~406 tok)
- `skills-registry.test.ts` — Declares registry (~3690 tok)
- `source-github-url.test.ts` — Declares result (~1291 tok)
- `source.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture + 4 more (~27843 tok)
- `test-tiers.test.ts` — Declares rootDir (~382 tok)
- `transport.test.ts` — TransportRuntime: createRuntime (~1383 tok)
- `update-history.test.ts` — Declares UpdateHistory (~1397 tok)
