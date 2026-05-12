# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-12T13:10:23.734Z
> Files: 78 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/plans/

- `transient-dreaming-hare.md` — Implementation Plan: syncskill UX Improvements (~1784 tok)

## ./

- `.gitignore` — Git ignore rules (~612 tok)
- `AGENTS.md` — AGENTS.md (~397 tok)
- `CLAUDE.md` — OpenWolf (~103 tok)
- `config.example.yaml` (~84 tok)
- `LICENSE` — Project license (~284 tok)
- `package-lock.json` — npm lock file (~24651 tok)
- `package.json` — Node.js package manifest (~241 tok)
- `README.md` — Project documentation (~1094 tok)
- `tsconfig.build.json` — TypeScript build configuration (~41 tok)
- `tsconfig.json` — TypeScript configuration (~99 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `config-guide.md` — Configuration Guide (~1606 tok)
- `design-guide.md` — Design Guide (~1544 tok)
- `README.md` — Project documentation (~221 tok)
- `usage-guide.md` — Usage Guide (~2091 tok)

## docs/superpowers/specs/

- `syncskill-design.md` — Syncskill — TypeScript 实现设计 (~11628 tok)

## skills/syncskill/

- `SKILL.md` — syncskill (~936 tok)

## src/

- `backup.ts` — Exports BackupMetaEntry, BackupMeta, getBackupDir, loadBackupMeta + 6 more (~772 tok)
- `config-doctor.ts` — Discover existing skills by scanning skillsDir and sources. (~3985 tok)
- `config-ui.ts` — Threshold for showing auto-refresh warning (~5954 tok)
- `config.ts` — Exports SyncPaths, ConflictResolution, SyncSkillConfig, ConfiguredServer + 13 more (~2055 tok)
- `conflict.ts` — Exports SkillDeltaClassification, StatusRow, classifySkillDelta, reconcileManifest + 5 more (~1129 tok)
- `index.ts` — Exports createProgram (~12586 tok)
- `install.ts` — Get the path to the embedded syncskill skill in dist/skills/syncskill/ (~915 tok)
- `linker.ts` — Exports ScanOptions, LinkRequest, LinkStatus, formatLinkStatusMatrix + 8 more (~2823 tok)
- `manifest.ts` — Exports listLocalSkillNames, hashSkillDirectory, ManifestDirection, ManifestStatus + 16 more (~3312 tok)
- `matrix-editor.ts` — Exports MatrixEditorConfig, MatrixEditorResult, renderMatrixLine, createMatrixEditor (~2264 tok)
- `refresh.ts` — Exports RefreshStoredManifestOptions, listTrackedServers, loadTrackedManifests, shouldRefreshLocal + (~1329 tok)
- `repo.ts` — Exports InitializeRepoOptions, initializeRepo (~1179 tok)
- `server.ts` — Exports ProbeLine, formatServerListLines, formatServerShowLines, formatProbeLines + 3 more (~438 tok)
- `skills-ignore.ts` — Exports IgnoredSkillEntry, SkillsIgnore, getSkillsIgnorePath, loadSkillsIgnore + 4 more (~523 tok)
- `skills-registry.ts` — Exports SkillRegistryEntry, SkillsRegistry, getSkillsRegistryPath, loadSkillsRegistry + 12 more (~2180 tok)
- `source.ts` — Git only: Convert source from git to local, keep path directory (~17130 tok)
- `sync_engine.ts` — Exports SyncEngineOptions, PushResult, PullResult, SyncStepResult + 6 more (~4689 tok)
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
- `config-ui.test.ts` — Declares PromptStub (~4796 tok)
- `discover.test.ts` — Declares tempDirs (~3869 tok)
- `doctor-cli.test.ts` — tests/integration/doctor-cli.test.ts (~1171 tok)
- `help-output.test.ts` — Declares help (~421 tok)
- `install-cli.test.ts` — Declares execFileAsync (~511 tok)
- `README.md` — Project documentation (~37 tok)
- `reconciliation-cli.test.ts` — Declares tempDirs (~6355 tok)
- `remote-refresh.test.ts` — Declares tempDirs (~669 tok)
- `repo.test.ts` — Declares pathExists (~1883 tok)
- `server-cli.test.ts` — Declares tempDirs (~1061 tok)
- `source-cli.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6256 tok)
- `source-remove.test.ts` — Declares SyncSkillConfig (~3145 tok)
- `source-update-force.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~4705 tok)
- `sync-cli.test.ts` — Declares tempDirs (~4259 tok)
- `sync-engine.test.ts` — TransportRuntime: createRuntime (~3568 tok)
- `transport.test.ts` — receiverPath: importReceiverModule, runReceiverCommand, runReceiverApply, createReceiverManifest, cr (~9500 tok)

## tests/unit/

- `backup.test.ts` — Declares result (~1339 tok)
- `config-doctor.test.ts` — Declares DiagnosticItem (~5718 tok)
- `config.test.ts` — Declares tempDirs (~1628 tok)
- `conflict.test.ts` — Declares ServerManifest (~2429 tok)
- `docs.test.ts` — Declares rootDir (~1312 tok)
- `install.test.ts` — Declares path (~1694 tok)
- `linker.test.ts` — Declares tempDirs (~2232 tok)
- `manifest.test.ts` — Declares tempDirs (~2639 tok)
- `matrix-editor.test.ts` — Declares config (~2278 tok)
- `package.test.ts` — Declares rootDir (~584 tok)
- `README.md` — Project documentation (~35 tok)
- `refresh.test.ts` — Declares tempDirs (~5658 tok)
- `server.test.ts` (~406 tok)
- `skills-ignore.test.ts` — Declares ignore (~510 tok)
- `skills-registry.test.ts` — Declares registry (~3690 tok)
- `source-github-url.test.ts` — Declares result (~1288 tok)
- `source.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture + 4 more (~22331 tok)
- `test-tiers.test.ts` — Declares rootDir (~368 tok)
