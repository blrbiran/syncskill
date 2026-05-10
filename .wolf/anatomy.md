# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-10T13:45:04.366Z
> Files: 68 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/plans/

- `transient-dreaming-hare.md` — Implementation Plan: syncskill UX Improvements (~1784 tok)

## ./

- `.gitignore` — Git ignore rules (~612 tok)
- `AGENTS.md` — AGENTS.md (~397 tok)
- `CLAUDE.md` — OpenWolf (~103 tok)
- `config.example.yaml` (~85 tok)
- `LICENSE` — Project license (~284 tok)
- `package-lock.json` — npm lock file (~24651 tok)
- `package.json` — Node.js package manifest (~216 tok)
- `README.md` — Project documentation (~987 tok)
- `tsconfig.build.json` — TypeScript build configuration (~41 tok)
- `tsconfig.json` — TypeScript configuration (~99 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `config-guide.md` — Configuration Guide (~1590 tok)
- `design-guide.md` — Design Guide (~1544 tok)
- `README.md` — Project documentation (~113 tok)
- `usage-guide.md` — Usage Guide (~1527 tok)

## docs/superpowers/specs/

- `syncskill-design.md` — Syncskill — TypeScript 实现设计，含 install 命令和 syncskill skill (~5800 tok)

## src/

- `config-ui.ts` — Exports PromptApi, createPromptApi, SafeSelectResult, safeSelect + 8 more (~5776 tok)
- `config.ts` — Exports SyncPaths, ConflictResolution, SyncSkillConfig, ConfiguredServer + 13 more (~2037 tok)
- `conflict.ts` — Exports SkillDeltaClassification, StatusRow, classifySkillDelta, reconcileManifest + 5 more (~1129 tok)
- `index.ts` — Exports createProgram (~9221 tok)
- `linker.ts` — Exports ScanOptions, LinkRequest, LinkStatus, formatLinkStatusMatrix + 8 more (~2787 tok)
- `manifest.ts` — Exports listLocalSkillNames, hashSkillDirectory, ManifestDirection, ManifestStatus + 16 more (~3312 tok)
- `matrix-editor.ts` — Exports MatrixEditorConfig, MatrixEditorResult, renderMatrixLine, createMatrixEditor (~2264 tok)
- `refresh.ts` — Exports RefreshStoredManifestOptions, listTrackedServers, loadTrackedManifests, shouldRefreshLocal + (~1329 tok)
- `repo.ts` — Exports InitializeRepoOptions, initializeRepo (~810 tok)
- `server.ts` — Exports ProbeLine, formatServerListLines, formatServerShowLines, formatProbeLines + 3 more (~438 tok)
- `skills-ignore.ts` — Exports IgnoredSkillEntry, SkillsIgnore, getSkillsIgnorePath, loadSkillsIgnore + 4 more (~523 tok)
- `skills-registry.ts` — Exports SkillRegistryEntry, SkillsRegistry, getSkillsRegistryPath, loadSkillsRegistry + 11 more (~1357 tok)
- `source.ts` — Git only: Convert source from git to local, keep store directory (~13086 tok)
- `sync_engine.ts` — Exports SyncEngineOptions, PushResult, PullResult, SyncStepResult + 6 more (~4583 tok)
- `transport.ts` — Exports ServerProbeResult, TransportRuntime, createTransportRuntime, refreshRemoteManifestFromServer (~3622 tok)
- `utils.ts` — Check if an error is a "file not found" error (ENOENT). (~359 tok)

## src/receiver/

- `bootstrap_remote.sh` (~140 tok)
- `sync_receiver.mjs` — syncRoot: readJson, readStdin, collectFileEntries + 11 more (~3101 tok)

## tests/end2end/

- `README.md` — Project documentation (~42 tok)
- `smoke.test.ts` — Declares execFileAsync (~319 tok)

## tests/helpers/

- `temp-dir.ts` — Create a managed temp directory tracker that auto-cleans after each test. (~138 tok)

## tests/integration/

- `config-cli.test.ts` — Declares homeDir (~2536 tok)
- `config-ui.test.ts` — PromptStub: createTestHome (~4190 tok)
- `discover.test.ts` — Declares tempDirs (~3400 tok)
- `help-output.test.ts` — Declares help (~184 tok)
- `README.md` — Project documentation (~37 tok)
- `reconciliation-cli.test.ts` — Declares tempDirs (~6355 tok)
- `remote-refresh.test.ts` — Declares tempDirs (~669 tok)
- `repo.test.ts` — Declares tempDirs (~1210 tok)
- `server-cli.test.ts` — Declares tempDirs (~1061 tok)
- `source-cli.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6228 tok)
- `source-remove.test.ts` — Declares SyncSkillConfig (~3145 tok)
- `sync-cli.test.ts` — Declares tempDirs (~4259 tok)
- `sync-engine.test.ts` — TransportRuntime: createRuntime (~3568 tok)
- `transport.test.ts` — receiverPath: importReceiverModule, runReceiverCommand, runReceiverApply, createReceiverManifest, cr (~9500 tok)

## tests/unit/

- `config.test.ts` — Declares tempDirs (~1612 tok)
- `conflict.test.ts` — Declares ServerManifest (~2429 tok)
- `docs.test.ts` — Declares rootDir (~1312 tok)
- `linker.test.ts` — Declares tempDirs (~2232 tok)
- `manifest.test.ts` — Declares tempDirs (~2639 tok)
- `matrix-editor.test.ts` — Declares config (~2278 tok)
- `package.test.ts` — Declares rootDir (~364 tok)
- `README.md` — Project documentation (~35 tok)
- `refresh.test.ts` — Declares tempDirs (~5658 tok)
- `server.test.ts` (~406 tok)
- `skills-ignore.test.ts` — Declares ignore (~510 tok)
- `skills-registry.test.ts` — Declares registry (~2109 tok)
- `source-github-url.test.ts` — Declares result (~1311 tok)
- `source.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture + 4 more (~20684 tok)
- `test-tiers.test.ts` — Declares rootDir (~368 tok)
