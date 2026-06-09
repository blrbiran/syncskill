# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-09T13:25:47.767Z
> Files: 161 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/

- `settings.json` (~766 tok)

## ./

- `.gitignore` — Git ignore rules (~612 tok)
- `AGENTS.md` — AGENTS.md (~397 tok)
- `CLAUDE.md` — OpenWolf (~103 tok)
- `config.example.yaml` (~84 tok)
- `LICENSE` — Project license (~284 tok)
- `package-lock.json` — npm lock file (~24651 tok)
- `package.json` — Node.js package manifest (~355 tok)
- `README.md` — Project documentation (~2200 tok)
- `tsconfig.build.json` — TypeScript build configuration (~41 tok)
- `tsconfig.json` — TypeScript configuration (~99 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `config-guide.md` — Configuration Guide (~3556 tok)
- `design-guide.md` — Design Guide (~3878 tok)
- `e2e-test-guide.md` — E2E Test Writing Guide (~3907 tok)
- `README.md` — Project documentation (~600 tok)
- `usage-guide.md` — Usage Guide with install/help, remote transport, and destructive-flag workflow notes (~4542 tok)

## docs/superpowers/plans/

- `2026-06-02-spec-alignment-audit.md` — 2026-06-02 Spec Alignment Audit Plan (~619 tok)

## docs/superpowers/specs/

- `e2e-test-design.md` — E2E 测试框架设计 (~4835 tok)
- `syncskill-design.md` — Syncskill — TypeScript 实现设计 (~20347 tok)

## skills/syncskill/

- `SKILL.md` — syncskill (~2014 tok)

## src/

- `dashboard.ts` — Exports DashboardSummary, loadDashboardSummary, formatDashboardSummary (~1121 tok)
- `index.ts` — Plan: selectTargetServers, prepareSyncTargetServers, getCommandPath + 18 more (~30551 tok)
- `install.ts` — Install embedded/external skills with shared link and ignore reconciliation helpers for fresh and same-repo flows (~3628 tok)
- `linker.ts` — Find stale links - symlinks in agent directories that point to syncskill-managed skills (~4849 tok)
- `refresh.ts` — Exports RefreshStoredManifestOptions, listTrackedServers, loadTrackedManifests, shouldRefreshLocal + (~1828 tok)
- `repo.ts` — Exports InitializeRepoOptions, initializeRepo (~1226 tok)
- `source.ts` — Git only: Convert source from git to local, keep path directory (~22096 tok)

## src/cli/

- `env.ts` — Environment variable handling for syncskill CLI. (~558 tok)
- `env.ts` — Environment variable loading and flag precedence merging for CLI config. (~340 tok)
- `executor.ts` — Exports ActionHandler, ExecutionContext, Executor, createExecutor (~297 tok)
- `exit-codes.ts` — Documented exit codes for syncskill CLI. (~586 tok)
- `index.ts` — src/cli/index.ts (~84 tok)
- `index.ts` — src/cli/index.ts (~40 tok)
- `output.ts` — Output controller that handles both JSONL and text output modes. (~1499 tok)
- `plan-execute.ts` — Exports PlanBuilder, PlanExecutor, ResolutionCollector, PlanExecuteOptions + 3 more (~537 tok)
- `plan.ts` — Exports PlanAction, UnresolvedItem, Plan, createPlan + 6 more (~563 tok)
- `resolution.ts` — Exports ResolutionValue, Resolutions, loadResolutions, resolveItem, hasResolution (~308 tok)
- `types.ts` — JSONL event types for --json mode output. (~393 tok)

## src/commands/

- `dashboard.ts` — Exports runDashboard (~98 tok)
- `index.ts` — Commands barrel export (~92 tok)
- `init.ts` — Exports InitOptions, runInit (~102 tok)

## src/config/

- `config-doctor.ts` — Exports DiagnosticCode, DiagnosticCodeType, DiagnosticItem, DiagnosticReport + 12 more (~3808 tok)
- `config-ui.ts` — Threshold for showing auto-refresh warning (~5957 tok)
- `config.ts` — Resolve an agent path, expanding ~ to the actual home directory. (~2591 tok)
- `matrix-editor.ts` — 2D matrix editor component (~2264 tok)
- `types.ts` — TypeScript type definitions for syncskill configuration (~288 tok)

## src/core/

- `conflict.ts` — Exports SkillDeltaClassification, StatusRow, classifySkillDelta, reconcileManifest + 5 more (~1248 tok)
- `manifest.ts` — Exports listLocalSkillNames, hashSkillDirectory, ManifestDirection, ManifestStatus + 16 more (~3346 tok)
- `private-agents.ts` — Pure function: compute default link targets based on config. (~999 tok)
- `registry-builder.ts` — Exports rebuildRegistryV2 (~434 tok)
- `server.ts` — Exports ProbeLine, ReceiverBackup, formatServerListLines, formatServerShowLines + 16 more (~2432 tok)
- `skills-registry.ts` — Exports SkillRegistryEntry, HttpBaseline, SkillsRegistry, SkillsRegistryV2 + 20 more (~3332 tok)
- `sync_engine.ts` — Exports SyncEngineOptions, PushResult, PullBackupRecord, PullResult + 3 more (~10869 tok)
- `transport.ts` — Exports ServerProbeResult, RemoteAgentScanEntry, RemoteAgentScanResult, ReceiverConfigPayload + 15 m (~6205 tok)

## src/receiver/

- `bootstrap_remote.sh` (~140 tok)
- `sync_receiver.mjs` — syncRoot: readJson, readStdin, collectFileEntries + 12 more (~3930 tok)

## src/source/

- `core.ts` — During transition, re-export from legacy source.ts (~67 tok)
- `detect.ts` — Exports SourceInputType, detectSourceInput, isGitUrl, isHttpUrl, isLocalArchive (~294 tok)
- `dirty.ts` — Exports DirtyCheckResult, isSkillDirty, DirtySkill (~145 tok)
- `discover.ts` — Exports DiscoveredSkill, discoverSourceSkills (~226 tok)
- `index.ts` (~33 tok)

## src/utils/

- `archive.ts` — Exports ArchiveType, ArchiveFormat, detectArchiveFormat, parseContentDisposition + 2 more (~955 tok)
- `backup.ts` — Exports getSidecarBackupDir, BackupSkillToSidecarOptions, backupSkillToSidecar, BackupDirtySkillsToS (~1099 tok)
- `utils.ts` — Exports execFileAsync, isNotFoundError, readJsonOrDefault, readFileOrDefault, pathExists (~438 tok)

## tests/end2end/

- `README.md` — Project documentation (~42 tok)
- `smoke.test.ts` — Declares execFileAsync (~319 tok)

## tests/end2end/cases/install/

- `install-local-archive.test.ts` — E2E tests for installing local archive files (.zip, .tar.gz). (~1223 tok)

## tests/end2end/cases/link/

- `link-reconcile.test.ts` — tests/end2end/cases/link/link-reconcile.test.ts (~1692 tok)
- `link-wildcard-change.test.ts` — E2E tests for changing link config from wildcard (*) to specific agents. (~2539 tok)

## tests/end2end/cases/smoke/

- `init.test.ts` — tests/end2end/cases/smoke/init.test.ts (~510 tok)

## tests/end2end/cases/source/

- `source-install-stale.test.ts` (~61 tok)
- `source-stale-checkout.test.ts` — tests/end2end/cases/source/source-stale-checkout.test.ts (~1540 tok)
- `source-update-dirty.test.ts` — tests/end2end/cases/source/source-update-dirty.test.ts (~1806 tok)
- `source-update-http.test.ts` — E2E tests for top-level update behavior with HTTP/local sources. (~3121 tok)
- `source-update.test.ts` — tests/end2end/cases/source/source-update.test.ts (~1161 tok)

## tests/end2end/cases/sync/

- `pull-skill-placement.test.ts` — Skipped stub for remote pull-placement e2e until an SSH-capable harness exists. (~44 tok)
- `pull-target.test.ts` — Skipped stub for remote pull-target e2e until an SSH-capable harness exists. (~43 tok)
- `push-server-integrity.test.ts` — Skipped stub for remote push-integrity e2e until an SSH-capable harness exists. (~44 tok)
- `receiver-update.test.ts` — Skipped stub for remote receiver-update e2e until an SSH-capable harness exists. (~42 tok)

## tests/end2end/framework/

- `cleanup.ts` — Prefix for all E2E temp directories. (~387 tok)
- `context.ts` — Agent name to skills directory path mapping. (~5853 tok)
- `e2e-test.ts` — e2eTest() wrapper for vitest it() with E2E options (timeout, network, skip). (~372 tok)
- `guard.ts` — Error thrown when E2E test attempts to access protected paths. (~593 tok)
- `index.ts` — Barrel export for all public E2E framework APIs. (~162 tok)
- `runner.ts` — Result of running a command. (~910 tok)
- `scenario.ts` — Agent name to skills directory path mapping. (~2126 tok)
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

- `cli-introspection.test.ts` — Declares program (~1030 tok)
- `config-cli.test.ts` — Declares homeDir (~4345 tok)
- `config-ui.test.ts` — Declares PromptStub (~4890 tok)
- `discover.test.ts` — Declares tempDirs (~3940 tok)
- `doctor-cli.test.ts` — tests/integration/doctor-cli.test.ts (~1299 tok)
- `help-output.test.ts` — Help-surface regression tests for public flags, install wording, and remote add options (~2148 tok)
- `install-cli.test.ts` — execFileAsync: execWithInput (~2892 tok)
- `README.md` — Project documentation (~37 tok)
- `reconciliation-cli.test.ts` — Declares actual (~13118 tok)
- `remote-refresh.test.ts` — Declares tempDirs (~894 tok)
- `repo.test.ts` — Declares pathExists (~1991 tok)
- `server-cli.test.ts` — Declares tempDirs (~5910 tok)
- `source-cli.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~3160 tok)
- `source-remove.test.ts` — Declares SourceConfig (~3129 tok)
- `source-update-dry-run.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~2058 tok)
- `source-update-force.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6444 tok)
- `sync-cli.test.ts` — Declares tempDirs (~9541 tok)
- `sync-engine.test.ts` — TransportRuntime: createRuntime (~10631 tok)
- `sync-timeout.test.ts` — Declares program (~273 tok)
- `transport.test.ts` — receiverPath: importReceiverModule, runReceiverCommandWithOutput, runReceiverCommand + 3 more (~12078 tok)

## tests/unit/

- `backup.test.ts` — Exports x (~2192 tok)
- `cli-env.test.ts` — tests/unit/cli-env.test.ts (~1282 tok)
- `cli-env.test.ts` — Unit tests for CLI env var parsing and flag-over-env precedence. (~910 tok)
- `cli-executor.test.ts` — Declares calls (~490 tok)
- `cli-output.test.ts` — tests/unit/cli-output.test.ts (~1601 tok)
- `cli-plan-execute.test.ts` — Declares buildPlan (~648 tok)
- `cli-plan.test.ts` — Declares plan (~504 tok)
- `cli-resolution.test.ts` — Declares dir (~505 tok)
- `cli-types.test.ts` — tests/unit/cli-types.test.ts (~510 tok)
- `config-doctor.test.ts` — Declares DiagnosticItem (~5530 tok)
- `config.test.ts` — Declares paths (~2999 tok)
- `conflict.test.ts` — Declares ServerManifest (~2877 tok)
- `dashboard.test.ts` — Declares ServerManifest (~1496 tok)
- `docs.test.ts` — Docs smoke assertions for README/guides/SKILL public CLI wording and transport fields (~2063 tok)
- `e2e-cleanup.test.ts` — tests/unit/e2e-cleanup.test.ts (~495 tok)
- `e2e-context.test.ts` — tests/unit/e2e-context.test.ts (~2371 tok)
- `e2e-fixtures-archive.test.ts` — tests/unit/e2e-fixtures-archive.test.ts (~588 tok)
- `e2e-fixtures-git.test.ts` — tests/unit/e2e-fixtures-git.test.ts (~765 tok)
- `e2e-fixtures-github.test.ts` — tests/unit/e2e-fixtures-github.test.ts (~561 tok)
- `e2e-fixtures-server.test.ts` — tests/unit/e2e-fixtures-server.test.ts (~806 tok)
- `e2e-fixtures-skill.test.ts` — tests/unit/e2e-fixtures-skill.test.ts (~582 tok)
- `e2e-fixtures-stale.test.ts` — Declares tempDirs (~535 tok)
- `e2e-guard.test.ts` — tests/unit/e2e-guard.test.ts (~376 tok)
- `e2e-runner.test.ts` — tests/unit/e2e-runner.test.ts (~540 tok)
- `e2e-scenario.test.ts` — tests/unit/e2e-scenario.test.ts (~931 tok)
- `exit-codes.test.ts` — tests/unit/exit-codes.test.ts (~750 tok)
- `install.test.ts` — Unit tests for embedded install, fresh source install, restored ignore flow, and same-repo scope expansion (~5979 tok)
- `linker.test.ts` — Declares SyncSkillConfig (~7055 tok)
- `manifest.test.ts` — Declares tempDirs (~2630 tok)
- `matrix-editor.test.ts` — Declares config (~2288 tok)
- `package.test.ts` — Declares rootDir (~597 tok)
- `private-agents.test.ts` — Declares tempDirs (~716 tok)
- `README.md` — Project documentation (~35 tok)
- `refresh.test.ts` — Declares tempDirs (~5915 tok)
- `registry-builder.test.ts` — Exports x (~868 tok)
- `server.test.ts` — Declares homeDir (~1381 tok)
- `skills-registry.test.ts` — Declares registry (~4983 tok)
- `source-detect.test.ts` (~255 tok)
- `source-dirty.test.ts` (~210 tok)
- `source-discover.test.ts` — Declares tempDirs (~582 tok)
- `source-github-url.test.ts` — Declares result (~1607 tok)
- `source.test.ts` — Large source module unit suite covering git/http/local flows, same-repo merge logic, add-source behavior, and legacy config compatibility cases (~27036 tok)
- `test-tiers.test.ts` — Declares rootDir (~382 tok)
- `transport.test.ts` — TransportRuntime: createRuntime (~2150 tok)
