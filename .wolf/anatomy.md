# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-09T12:31:36.955Z
> Files: 64 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~612 tok)
- `AGENTS.md` — AGENTS.md (~397 tok)
- `CLAUDE.md` — OpenWolf (~103 tok)
- `config.example.yaml` (~85 tok)
- `LICENSE` — Project license (~284 tok)
- `package-lock.json` — npm lock file (~24651 tok)
- `package.json` — Node.js package manifest (~216 tok)
- `README.md` — Project documentation (~621 tok)
- `tsconfig.build.json` — TypeScript build configuration (~41 tok)
- `tsconfig.json` — TypeScript configuration (~99 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `config-guide.md` — Configuration Guide (~1083 tok)
- `design-guide.md` — Design Guide (~620 tok)
- `usage-guide.md` — Usage Guide (~974 tok)

## docs/superpowers/plans/

- `2026-05-09-ux-optimizations.md` — UX Optimizations Implementation Plan (~11975 tok)

## docs/superpowers/specs/

- `syncskill-design.md` — Syncskill TypeScript 实现设计，含 UX 优化（source add 流程、push 交互、--dry-run 等） (~5500 tok)

## docs/temp/

- `ux-optimization-proposals.md` — UX 优化提案存档（已合并到 syncskill-design.md） (~1919 tok)

## src/

- `config-ui.ts` — Exports PromptApi, createPromptApi, SafeSelectResult, safeSelect + 8 more (~5776 tok)
- `config.ts` — Exports SyncPaths, ConflictResolution, SyncSkillConfig, ConfiguredServer + 13 more (~2037 tok)
- `conflict.ts` — Exports SkillDeltaClassification, StatusRow, classifySkillDelta, reconcileManifest + 5 more (~1129 tok)
- `index.ts` — Exports createProgram (~7887 tok)
- `linker.ts` — Exports ScanOptions, LinkRequest, LinkStatus, UnmanagedSkill, listLocalSkills, findUnmanagedSkills + 6 more (~2200 tok)
- `manifest.ts` — Exports listLocalSkillNames, hashSkillDirectory, ManifestDirection, ManifestStatus + 16 more (~3315 tok)
- `matrix-editor.ts` — Exports MatrixEditorConfig, MatrixEditorResult, renderMatrixLine, createMatrixEditor (~1847 tok)
- `refresh.ts` — Exports RefreshStoredManifestOptions, listTrackedServers, loadTrackedManifests, shouldRefreshLocal + (~1324 tok)
- `repo.ts` — Exports InitializeRepoOptions, initializeRepo (~810 tok)
- `server.ts` — Exports ProbeLine, formatServerListLines, formatServerShowLines, formatProbeLines + 3 more (~438 tok)
- `skills-ignore.ts` — Exports IgnoredSkillEntry, SkillsIgnore, getSkillsIgnorePath, loadSkillsIgnore + 4 more (~518 tok)
- `source.ts` — Exports AddSourceFromUrlResult, addSourceFromUrl + source management functions. Supports restoring skills from ignore list on same-repo add (~13300 tok)
- `sync_engine.ts` — Push/pull/sync engine with dryRun support. Exports SyncEngineOptions, PushResult, PullResult, SyncStepResult + 6 more (~3686 tok)
- `transport.ts` — Exports ServerProbeResult, TransportRuntime, createTransportRuntime, refreshRemoteManifestFromServer + 6 more (~3216 tok)

## src/receiver/

- `bootstrap_remote.sh` (~55 tok)
- `sync_receiver.mjs` — syncRoot: readJson, readStdin, collectFileEntries + 8 more (~2463 tok)

## tests/end2end/

- `README.md` — Project documentation (~42 tok)
- `smoke.test.ts` — Declares execFileAsync (~319 tok)

## tests/integration/

- `config-cli.test.ts` — Declares homeDir (~1079 tok)
- `config-ui.test.ts` — PromptStub: createTestHome (~4014 tok)
- `discover.test.ts` — Declares tempDirs (~2848 tok)
- `help-output.test.ts` — Declares help (~152 tok)
- `README.md` — Project documentation (~37 tok)
- `reconciliation-cli.test.ts` — Declares tempDirs (~6308 tok)
- `remote-refresh.test.ts` — Declares tempDirs (~669 tok)
- `repo.test.ts` — Declares tempDirs (~1236 tok)
- `server-cli.test.ts` — Declares tempDirs (~1061 tok)
- `source-cli.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture (~6160 tok)
- `source-remove.test.ts` — Declares SyncSkillConfig (~3145 tok)
- `sync-cli.test.ts` — Declares tempDirs (~3879 tok)
- `sync-engine.test.ts` — TransportRuntime: createRuntime (~3568 tok)
- `transport.test.ts` — receiverPath: importReceiverModule, runReceiverCommand, runReceiverApply, createReceiverManifest, createRuntime (~6110 tok)

## tests/unit/

- `config.test.ts` — Declares tempDirs (~1676 tok)
- `conflict.test.ts` — Declares ServerManifest (~2429 tok)
- `docs.test.ts` — Declares rootDir (~1312 tok)
- `linker.test.ts` — Declares tempDirs (~1327 tok)
- `manifest.test.ts` — Declares tempDirs (~2639 tok)
- `matrix-editor.test.ts` — Declares config (~1744 tok)
- `package.test.ts` — Declares rootDir (~364 tok)
- `README.md` — Project documentation (~35 tok)
- `refresh.test.ts` — Declares tempDirs (~5658 tok)
- `server.test.ts` (~406 tok)
- `skills-ignore.test.ts` — Declares ignore (~510 tok)
- `source-github-url.test.ts` — Declares result (~1311 tok)
- `source.test.ts` — execFileAsync: git, commitAll, createGitSourceFixture. Tests addSourceFromUrl with skills-ignore restoration (~20800 tok)
- `test-tiers.test.ts` — Declares rootDir (~368 tok)
