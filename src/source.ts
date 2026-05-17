import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { select } from '@inquirer/prompts';

import type { SyncSkillConfig } from './config/config.js';
import { getSyncPaths, loadConfig, saveConfig } from './config/config.js';
import {
  SkillsRegistry,
  SkillRegistryEntry,
  loadSkillsRegistry,
  saveSkillsRegistry,
  isSkillIgnored,
  activateSkill,
} from './core/skills-registry.js';
import { hashSkillDirectory } from './core/manifest.js';
import { recordGitOverwrite, recordHttpOverwrite, clearSourceHistory, type GitUpdateRecord } from './core/update-history.js';
import { backupDirtySkills } from './utils/backup.js';
import { isNotFoundError, pathExists } from './utils/utils.js';
import {
  type ArchiveType,
  type ArchiveFormat,
  detectArchiveFormat,
  parseContentDisposition,
  detectArchiveFormatFromFilename,
  extractArchive,
} from './utils/archive.js';

const execFileAsync = promisify(execFile);

async function gitStashAndRecord(
  checkoutDir: string,
  timestamp: string
): Promise<{ stashCommit: string; beforeCommit: string }> {
  const { stdout: beforeCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);
  const stashMessage = `syncskill: auto-stash before update (${timestamp})`;
  await execFileAsync('git', ['-C', checkoutDir, 'stash', 'push', '-m', stashMessage]);
  const { stdout: stashCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'stash@{0}']);

  return {
    stashCommit: stashCommit.trim(),
    beforeCommit: beforeCommit.trim(),
  };
}

interface PerformStashOrBackupOptions {
  homeDir: string;
  sourceName: string;
  sourceType: 'git' | 'http';
  dirtySkills: DirtySkillInfo[];
  backupsDir: string;
  checkoutDir?: string;
  updatedAt: string;
  options: UpdateSourceOptions;
}

async function performStashOrBackup(opts: PerformStashOrBackupOptions): Promise<void> {
  const { homeDir, sourceName, sourceType, dirtySkills, backupsDir, checkoutDir, updatedAt, options } = opts;

  if (sourceType === 'git' && checkoutDir) {
    console.log('⚠ Stashing local changes before update...');
    const { stashCommit, beforeCommit } = await gitStashAndRecord(checkoutDir, updatedAt);
    options.gitOverwriteRecord = {
      before_commit: beforeCommit,
      stash_commit: stashCommit,
    };
    console.log(`  ✓ Stashed changes (${stashCommit.slice(0, 7)})`);
    console.log(`  To restore: syncskill source restore ${sourceName}`);
  } else if (dirtySkills.length > 0) {
    console.log('⚠ Backing up dirty skills before update...');
    const backupResult = await backupDirtySkills({
      backupsDir,
      sourceName,
      dirtySkills: dirtySkills.map(s => ({
        name: s.name,
        path: s.path,
        hash: s.hash || 'unknown'
      }))
    });
    for (const backed of backupResult.backedUp) {
      console.log(`  ✓ Backed up ${backed.name} to ${backed.backupPath}`);
    }
    if (sourceType === 'http' && backupResult.backedUp.length > 0) {
      await recordHttpOverwrite(homeDir, sourceName, {
        type: 'http',
        backup_path: join(backupsDir, sourceName),
        dirty_skills: backupResult.backedUp.map(backed => backed.name),
        timestamp: new Date().toISOString(),
      });
      console.log(`  To restore: syncskill source restore ${sourceName}`);
    }
  }
}

export type { ArchiveType, ArchiveFormat };
export { detectArchiveFormat, parseContentDisposition, detectArchiveFormatFromFilename };

export enum RemovalAction {
  /** Git only: Convert source from git to local, keep path directory */
  ConvertToLocal = 'convert-to-local',
  /** Remove source config and links, keep skill files on disk */
  RemoveConfigKeepFiles = 'remove-config-keep-files',
  /** Remove source config, links, and all skill files */
  RemoveAll = 'remove-all',
}

export enum SameRepoScenario {
  /** Scenario 1: New skill path is within existing multi-skill directory */
  NewWithinExisting = 'new-within-existing',
  /** Scenario 2: New multi-skill directory contains existing single skill */
  NewContainsExisting = 'new-contains-existing',
  /** Scenario 3: Same parent directory, different single skills */
  SameParentSiblings = 'same-parent-siblings',
  /** Scenario 4: Different parent directories entirely */
  DifferentParents = 'different-parents',
}

export function classifySameRepoScenario(
  existingSubdir: string,
  newSubdir: string,
  existingHasSkillMd: boolean,
  newHasSkillMd: boolean
): SameRepoScenario {
  const existingNorm = existingSubdir.replace(/\/$/, '');
  const newNorm = newSubdir.replace(/\/$/, '');

  // Check if new is within existing (scenario 1)
  if (!existingHasSkillMd && newHasSkillMd && newNorm.startsWith(existingNorm + '/')) {
    return SameRepoScenario.NewWithinExisting;
  }

  // Check if new contains existing (scenario 2)
  if (existingHasSkillMd && !newHasSkillMd && existingNorm.startsWith(newNorm + '/')) {
    return SameRepoScenario.NewContainsExisting;
  }

  // Check if same parent directory (scenario 3)
  const existingParent = dirname(existingNorm);
  const newParent = dirname(newNorm);
  if (existingParent === newParent && existingHasSkillMd && newHasSkillMd) {
    return SameRepoScenario.SameParentSiblings;
  }

  // Different parents (scenario 4)
  return SameRepoScenario.DifferentParents;
}

export type SourceType = 'local' | 'git' | 'http';

export interface DetectedSourceType {
  type: SourceType;
  url: string;
  branch?: string;
  isArchive?: boolean;
}

/** Archive file extensions regex */
const ARCHIVE_EXTENSIONS_REGEX = /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip)$/i;

/**
 * Auto-detect source type from a URL or path string.
 * Returns null if the format is unknown and requires interactive prompting.
 */
export function detectSourceType(input: string): DetectedSourceType | null {
  // File system paths
  if (input.startsWith('/') || input.startsWith('~') || input.startsWith('./') || input.startsWith('../')) {
    // Check if it's an archive file
    const isArchive = ARCHIVE_EXTENSIONS_REGEX.test(input);
    return { type: 'local', url: input, isArchive };
  }

  // GitHub/GitLab URLs - delegate to existing parseGitHubUrl for detailed parsing
  const gitHostMatch = input.match(/^https?:\/\/(github\.com|gitlab\.com)\/([^\/]+)\/([^\/]+)/);
  if (gitHostMatch) {
    // Check for /tree/<branch>/<path> pattern
    const treeMatch = input.match(/\/tree\/([^\/]+)(\/.*)?$/);
    if (treeMatch) {
      const branch = treeMatch[1];
      const repoBase = input.replace(/\/tree\/.*$/, '');
      return { type: 'git', url: `${repoBase}.git`, branch };
    }

    // Plain repo URL
    const url = input.endsWith('.git') ? input : `${input}.git`;
    return { type: 'git', url };
  }

  // .git suffix
  if (input.endsWith('.git')) {
    return { type: 'git', url: input };
  }

  // Archive files (HTTP URLs)
  if (ARCHIVE_EXTENSIONS_REGEX.test(input)) {
    return { type: 'http', url: input };
  }

  // Unknown - return null to trigger interactive prompt
  return null;
}

export interface DiscoveredSkill {
  name: string;
  relativePath: string;
  absolutePath: string;
}

/**
 * Recursively scan a directory for skills (directories containing SKILL.md).
 * Returns all discovered skills with their paths.
 */
export async function scanSkillsInDirectory(baseDir: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];

  async function scanDir(dir: string, relPath: string = ''): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(dir, entry.name);
        const relativePath = relPath ? `${relPath}/${entry.name}` : entry.name;

        try {
          await readFile(join(fullPath, 'SKILL.md'), 'utf8');
          skills.push({
            name: entry.name,
            relativePath,
            absolutePath: fullPath
          });
        } catch {
          // No SKILL.md, recurse into subdirectory
          await scanDir(fullPath, relativePath);
        }
      }
    } catch {
      // Directory not accessible
    }
  }

  await scanDir(baseDir);
  return skills;
}

/**
 * Alias for scanSkillsInDirectory.
 * Recursively scan a source directory for skills (directories containing SKILL.md).
 * Returns all discovered skills sorted by name.
 */
export async function scanSkillsInSource(sourceDir: string): Promise<DiscoveredSkill[]> {
  const skills = await scanSkillsInDirectory(sourceDir);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SourceDefinition {
  type: SourceType;
  url: string;
  path: string;
  branch?: string;
  archive_path?: string;  // For local archive sources, points to original archive file
}

export interface SourceEntry extends SourceDefinition {
  name: string;
}

export interface SourceState {
  materialized_skills: string[];
  updated_at: string;
}

export interface SkillOwnershipState {
  owners: Record<string, string>; // skill name -> source name
}

// Re-export SkillsRegistry types for backward compatibility
export type { SkillsRegistry, SkillRegistryEntry } from './core/skills-registry.js';

export async function listSources(homeDir = homedir()): Promise<SourceEntry[]> {
  const config = await loadConfig(homeDir);

  return Object.entries(config.sources)
    .flatMap(([name, value]) => normalizeSourceEntry(name, value))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function addSource(homeDir = homedir(), name: string, source: SourceDefinition): Promise<void> {
  const config = await loadConfig(homeDir);
  const previousSource = config.sources[name];
  config.sources[name] = source;
  await saveConfig(config, homeDir);

  if (source.type !== 'local') {
    return;
  }

  try {
    await materializeSource(homeDir, name, source);
  } catch (error) {
    if (previousSource === undefined) {
      delete config.sources[name];
    } else {
      config.sources[name] = previousSource;
    }

    await saveConfig(config, homeDir);
    throw error;
  }
}

export function formatSourceListLines(sources: SourceEntry[]): string[] {
  return sources.map((source) => `${source.name}\t${source.type}\t${source.url}\t${source.path}`);
}

export async function loadSourceState(homeDir = homedir(), name: string): Promise<SourceState | null> {
  const stateFile = getSourceStateFile(homeDir, name);

  try {
    return normalizeSourceState(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function materializeSource(
  homeDir = homedir(),
  name: string,
  source: SourceDefinition,
  updatedAt = new Date().toISOString(),
  options: UpdateSourceOptions = {}
): Promise<SourceState> {
  return syncSource(homeDir, name, source, updatedAt, options);
}

export interface UpdateSourceOptions {
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  gitOverwriteRecord?: Pick<GitUpdateRecord, 'before_commit' | 'stash_commit'>;
}

export async function updateSource(
  homeDir = homedir(),
  name: string,
  options: UpdateSourceOptions = {},
  updatedAt = new Date().toISOString()
): Promise<SourceState> {
  const config = await loadConfig(homeDir);
  const source = normalizeSourceEntry(name, config.sources[name])[0];

  if (source === undefined) {
    throw new Error(`Source not found: ${name}`);
  }

  return syncSource(homeDir, name, source, updatedAt, options);
}

/**
 * Check if a source can be updated (has remote URL to fetch from)
 */
export function isSourceUpdatable(source: SourceEntry): boolean {
  // Local sources (directory or archive) cannot be updated
  if (source.type === 'local') {
    return false;
  }
  // Git and HTTP sources need a URL
  return Boolean(source.url);
}

/**
 * Get list of updatable sources
 */
export async function getUpdatableSources(homeDir = homedir()): Promise<SourceEntry[]> {
  const sources = await listSources(homeDir);
  return sources.filter(isSourceUpdatable);
}

type HttpConfirmResult = 'yes' | 'no' | 'all' | 'quit';

/**
 * Ask for confirmation before updating an HTTP source.
 * Returns 'yes', 'no', 'all' (yes to all), or 'quit'.
 */
async function confirmHttpUpdate(sourceName: string, sourceUrl: string): Promise<HttpConfirmResult> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY) {
    // Non-interactive: default to yes
    return 'yes';
  }

  const choice = await select({
    message: `Update HTTP source "${sourceName}"? (${sourceUrl})`,
    choices: [
      { name: '(Y) Yes — update this source', value: 'yes' as const },
      { name: '(n) No — skip this source', value: 'no' as const },
      { name: '(a) Yes to all — update this and all remaining HTTP sources', value: 'all' as const },
      { name: '(q) Quit — stop update', value: 'quit' as const },
    ],
    default: 'yes',
  });

  return choice;
}

/**
 * Handle skills that were removed from a source after update.
 * Ask user if they want to keep each skill as a manual skill.
 */
async function handleRemovedSkills(
  homeDir: string,
  sourceName: string,
  removedSkills: string[],
  skillsDir: string,
  ownershipState: SkillOwnershipState,
  options: UpdateSourceOptions
): Promise<void> {
  const { syncDir, configFile } = getSyncPaths(homeDir);
  const manualSkillsDir = join(syncDir, 'skills');
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;

  // Try to load config, but don't fail if it doesn't exist
  let config: SyncSkillConfig | null = null;
  try {
    config = await loadConfig(homeDir);
  } catch {
    // Config doesn't exist in test scenarios, that's OK
  }

  for (const skillName of removedSkills) {
    const sourceSkillPath = join(skillsDir, skillName);

    // Check if skill still exists on disk
    if (!(await pathExists(sourceSkillPath))) {
      delete ownershipState.owners[skillName];
      continue;
    }

    // Default behavior with -y: keep as manual skill
    let keepAsManual = options.yes ?? false;

    if (!options.yes && isTTY) {
      const answer = await select({
        message: `Skill "${skillName}" was removed from source "${sourceName}". Keep it as a local skill?`,
        choices: [
          { name: '(Y) Yes — keep as local skill', value: true },
          { name: '(n) No — remove skill', value: false },
        ],
        default: true,
      });
      keepAsManual = answer;
    }

    if (keepAsManual) {
      // Move to manual skills directory
      const manualPath = join(manualSkillsDir, skillName);
      await mkdir(manualSkillsDir, { recursive: true });

      // Copy if it's in a different location (source skills dir vs manual dir)
      if (sourceSkillPath !== manualPath && !(await pathExists(manualPath))) {
        await cp(sourceSkillPath, manualPath, { recursive: true });
      }

      // Update ownership to manual (remove from source ownership so removeStaleSkills skips it)
      delete ownershipState.owners[skillName];

      // Update registry to mark as manual
      const registry = await loadSkillsRegistry(homeDir);
      if (registry.skills[skillName]) {
        registry.skills[skillName].origin = 'manual';
        registry.skills[skillName].type = 'manual';
        registry.skills[skillName].path = manualPath;
        await saveSkillsRegistry(homeDir, registry);
      }

      console.log(`  ✓ Kept "${skillName}" as local skill`);
    } else {
      // Will be removed by removeStaleSkills
      // Also remove from links if config exists
      if (config) {
        delete config.links[skillName];
      }
      console.log(`  ✓ Removed "${skillName}"`);
    }
  }

  // Save config if it was loaded and potentially modified
  if (config) {
    await saveConfig(config, homeDir);
  }
}

export interface UpdateResult {
  sourceName: string;
  status: 'success' | 'skipped' | 'failed';
  reason?: string;
  previousSkills: string[];
  currentSkills: string[];
  addedSkills: string[];
  removedSkills: string[];
}

export async function updateAllSources(
  homeDir = homedir(),
  updatedAt = new Date().toISOString(),
  options: UpdateSourceOptions = {}
): Promise<SourceState[]> {
  const sources = await listSources(homeDir);
  const updatableSources = sources.filter(isSourceUpdatable);
  const states: SourceState[] = [];
  const results: UpdateResult[] = [];

  if (updatableSources.length === 0) {
    console.log(options.dryRun ? '[dry-run] No updatable sources found.' : 'No updatable sources found.');
    return states;
  }

  if (options.dryRun) {
    console.log('\n[dry-run] Updatable sources:');
    for (const source of updatableSources) {
      const urlDisplay = source.url ? ` — ${source.url}` : '';
      console.log(`  ${source.name} (${source.type})${urlDisplay}`);
    }

    const dirtySummaries: Array<{ source: SourceEntry; dirtySkills: string[]; hasNonSkillDirty: boolean }> = [];
    for (const source of updatableSources) {
      const previousState = await loadSourceState(homeDir, source.name);
      const previousSkills = previousState?.materialized_skills ?? [];
      if (previousSkills.length === 0) {
        continue;
      }

      if (source.type === 'git') {
        const checkoutDir = join(getSyncPaths(homeDir).syncDir, '.sources', source.name, 'checkout');
        if (!(await pathExists(checkoutDir))) {
          continue;
        }
        const dirtyResult = await detectGitDirty(checkoutDir, source.path);
        if (dirtyResult.isDirty) {
          dirtySummaries.push({
            source,
            dirtySkills: dirtyResult.dirtySkills.map(skill => skill.name),
            hasNonSkillDirty: dirtyResult.nonSkillDirty,
          });
        }
        continue;
      }

      if (source.type === 'http') {
        const dirtyResult = await detectHttpDirty(homeDir, source.name, previousSkills);
        if (dirtyResult.isDirty) {
          dirtySummaries.push({
            source,
            dirtySkills: dirtyResult.dirtySkills.map(skill => skill.name),
            hasNonSkillDirty: false,
          });
        }
      }
    }

    if (dirtySummaries.length > 0) {
      console.log('\n[dry-run] Dirty sources:');
      for (const summary of dirtySummaries) {
        const details: string[] = [];
        if (summary.dirtySkills.length > 0) {
          details.push(`skills: ${summary.dirtySkills.join(', ')}`);
        }
        if (summary.hasNonSkillDirty) {
          details.push('non-skill changes present');
        }
        console.log(`  ${summary.source.name} (${summary.source.type})${details.length > 0 ? ` — ${details.join('; ')}` : ''}`);
      }
    }

    console.log('\n[dry-run] No changes were made.');
    console.log('[dry-run] Without --force, dirty sources would be skipped.');
    console.log('[dry-run] With --force, syncskill would back up or stash local changes before updating.');
    return states;
  }

  // Show list of sources to be updated
  console.log('\nUpdatable sources:');
  for (const source of updatableSources) {
    const urlDisplay = source.url ? ` — ${source.url}` : '';
    console.log(`  ${source.name} (${source.type})${urlDisplay}`);
  }
  console.log('');

  // Track "Yes to all" state for HTTP sources
  let httpYesToAll = false;

  for (const source of updatableSources) {
    // Get previous state for comparison
    const previousState = await loadSourceState(homeDir, source.name);
    const previousSkills = previousState?.materialized_skills ?? [];

    try {
      // HTTP sources: ask for confirmation (unless -y or "Yes to all")
      if (source.type === 'http' && !options.yes && !httpYesToAll) {
        const confirm = await confirmHttpUpdate(source.name, source.url);

        if (confirm === 'quit') {
          console.log('\nUpdate cancelled by user.');
          break;
        }

        if (confirm === 'no') {
          results.push({
            sourceName: source.name,
            status: 'skipped',
            reason: 'user skipped',
            previousSkills,
            currentSkills: previousSkills,
            addedSkills: [],
            removedSkills: [],
          });
          console.log(`Skipped: ${source.name}`);
          continue;
        }

        if (confirm === 'all') {
          httpYesToAll = true;
        }
        // 'yes' or 'all' - proceed with update
      }

      const newState = await updateSource(homeDir, source.name, options, updatedAt);
      states.push(newState);

      const currentSkills = newState.materialized_skills;
      const addedSkills = currentSkills.filter(s => !previousSkills.includes(s));
      const removedSkills = previousSkills.filter(s => !currentSkills.includes(s));

      results.push({
        sourceName: source.name,
        status: 'success',
        previousSkills,
        currentSkills,
        addedSkills,
        removedSkills,
      });
    } catch (error) {
      if (error instanceof DirtySourceQuitError) {
        results.push({
          sourceName: source.name,
          status: 'skipped',
          reason: 'dirty — local modifications',
          previousSkills,
          currentSkills: previousSkills,
          addedSkills: [],
          removedSkills: [],
        });
        console.log('\nUpdate cancelled by user.');
        break;
      }
      // Record failure
      results.push({
        sourceName: source.name,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        previousSkills,
        currentSkills: previousSkills,
        addedSkills: [],
        removedSkills: [],
      });
    }
  }

  // Print update summary
  printUpdateSummary(results);

  return states;
}

function printUpdateSummary(results: UpdateResult[]): void {
  if (results.length === 0) return;

  const successful = results.filter(r => r.status === 'success');
  const skipped = results.filter(r => r.status === 'skipped');
  const failed = results.filter(r => r.status === 'failed');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Update Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const result of successful) {
    const changes: string[] = [];
    if (result.addedSkills.length > 0) {
      changes.push(`+${result.addedSkills.length} new`);
    }
    if (result.removedSkills.length > 0) {
      changes.push(`-${result.removedSkills.length} removed`);
    }
    const changeStr = changes.length > 0 ? ` (${changes.join(', ')})` : '';
    console.log(`✓ ${result.sourceName}${changeStr}`);

    if (result.addedSkills.length > 0) {
      console.log(`    + ${result.addedSkills.join(', ')}`);
    }
    if (result.removedSkills.length > 0) {
      console.log(`    - ${result.removedSkills.join(', ')}`);
    }
  }

  for (const result of skipped) {
    console.log(`⚠ ${result.sourceName}: skipped (${result.reason})`);
  }

  for (const result of failed) {
    console.log(`✗ ${result.sourceName}: failed (${result.reason})`);
  }

  // Summary line
  const parts: string[] = [];
  if (successful.length > 0) parts.push(`${successful.length} updated`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  console.log(`\n${parts.join(', ')}`);
}

export interface RemoveSourceOptions {
  /** @deprecated Use action instead */
  keepStore?: boolean;
  /** Removal action to perform */
  action?: RemovalAction;
}

export async function removeSource(
  homeDir = homedir(),
  name: string,
  options: RemoveSourceOptions = {}
): Promise<void> {
  const config = await loadConfig(homeDir);
  const sourceRaw = config.sources[name];

  if (sourceRaw === undefined) {
    throw new Error(`Source not found: ${name}`);
  }

  // Type-guard for source properties
  const source = sourceRaw as Record<string, unknown>;
  const sourceType = source.type as string | undefined;
  const sourceStore = source.path as string | undefined;

  const ownershipState = await loadSkillOwnershipState(homeDir);
  const sourceState = await loadSourceState(homeDir, name);
  const ownedSkills = sourceState?.materialized_skills ?? [];
  const { skillsDir, syncDir } = getSyncPaths(homeDir);
  const sourceDir = join(syncDir, '.sources', name);

  // Handle legacy keepStore option
  const action = options.action ??
    (options.keepStore ? RemovalAction.RemoveConfigKeepFiles : RemovalAction.RemoveAll);

  if (action === RemovalAction.ConvertToLocal) {
    if (sourceType !== 'git') {
      throw new Error(`ConvertToLocal only valid for git sources, got: ${sourceType}`);
    }
    // Convert to local source pointing to checkout directory with original path
    const checkoutDir = join(sourceDir, 'checkout');
    const originalStore = sourceStore ?? '.';
    config.sources[name] = {
      type: 'local',
      url: checkoutDir,
      path: originalStore,
    };
    await saveConfig(config, homeDir);
    return;
  }

  // Remove source from config
  delete config.sources[name];

  // Remove links for owned skills
  const nextOwnership = structuredClone(ownershipState) as SkillOwnershipState;
  for (const skill of ownedSkills) {
    if (nextOwnership.owners[skill] === name) {
      delete nextOwnership.owners[skill];
      delete config.links[skill];
    }
  }

  await saveConfig(config, homeDir);
  await saveSkillOwnershipState(homeDir, nextOwnership);

  if (action === RemovalAction.RemoveAll) {
    // Delete skill files
    for (const skill of ownedSkills) {
      const skillPath = join(skillsDir, skill);
      await rm(skillPath, { recursive: true, force: true });
    }
    // Delete source directory
    await rm(sourceDir, { recursive: true, force: true });
  }
}

export interface DirtySkillInfo {
  name: string;
  path: string;
  hash: string;
}

export interface DirtyDetectionResult {
  isDirty: boolean;
  dirtySkills: DirtySkillInfo[];
  nonSkillDirty: boolean;
}

/** Thrown when user chooses 'quit' in dirty source interactive prompt */
export class DirtySourceQuitError extends Error {
  constructor() {
    super('User quit dirty source update');
    this.name = 'DirtySourceQuitError';
  }
}

type DirtyDecision = 'update' | 'skip' | 'quit';

interface HandleDirtySourceOptions {
  homeDir: string;
  sourceName: string;
  sourceType: 'git' | 'http';
  dirtyResult: DirtyDetectionResult;
  hasSkillDirty: boolean;
  hasNonSkillDirty: boolean;
  options: UpdateSourceOptions;
  backupsDir: string;
  allSkills: string[];
  checkoutDir?: string;
  updatedAt: string;
}

/**
 * Handle dirty source detection with interactive prompts.
 * Returns 'update' to proceed, 'skip' to skip this source, 'quit' to stop all updates.
 */
async function handleDirtySource(opts: HandleDirtySourceOptions): Promise<DirtyDecision> {
  const {
    homeDir,
    sourceName,
    sourceType,
    dirtyResult,
    hasSkillDirty,
    hasNonSkillDirty,
    options,
    backupsDir,
    allSkills,
    checkoutDir,
    updatedAt
  } = opts;
  const dirtySkillNames = dirtyResult.dirtySkills.map(s => s.name).join(', ');
  const allSkillNames = allSkills.join(', ');

  // --force: stash/backup and update
  if (options.force) {
    if ((sourceType === 'git' && checkoutDir && (hasSkillDirty || hasNonSkillDirty)) || hasSkillDirty) {
      await performStashOrBackup({
        homeDir,
        sourceName,
        sourceType,
        dirtySkills: dirtyResult.dirtySkills,
        backupsDir,
        checkoutDir,
        updatedAt,
        options
      });
    }
    return 'update';
  }

  // -y/--yes: behavior differs based on dirty type
  if (options.yes) {
    if (hasSkillDirty) {
      // Skill dirty with -y: skip (safe default)
      console.log(`⚠ Skipped: ${sourceName} (dirty — ${dirtyResult.dirtySkills.length} skills have local modifications)`);
      console.log(`  Dirty skills: ${dirtySkillNames}`);
      if (sourceType === 'git' && allSkills.length > dirtyResult.dirtySkills.length) {
        console.log(`  All skills in source: ${allSkillNames}`);
        console.log(`  Skipping this source will skip ALL ${allSkills.length} skills, not just the dirty ones.`);
      }
      console.log('  Use --force to overwrite local changes.');
      return 'skip';
    } else if (hasNonSkillDirty) {
      // Non-skill dirty with -y: update (doesn't affect skills)
      return 'update';
    }
  }

  // Interactive mode
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY) {
    // Non-interactive: skip with message
    if (hasSkillDirty) {
      console.log(`⚠ Skipped: ${sourceName} (dirty — ${dirtyResult.dirtySkills.length} skills have local modifications)`);
      console.log(`  Dirty skills: ${dirtySkillNames}`);
      if (sourceType === 'git' && allSkills.length > dirtyResult.dirtySkills.length) {
        console.log(`  All skills in source: ${allSkillNames}`);
        console.log(`  Skipping this source will skip ALL ${allSkills.length} skills, not just the dirty ones.`);
      }
    } else {
      console.log(`⚠ Skipped: ${sourceName} (uncommitted non-skill changes)`);
    }
    console.log('  Use --force to backup and update, or --yes to skip.');
    return 'skip';
  }

  // Interactive prompt
  if (hasSkillDirty) {
    console.log(`\n⚠ Source "${sourceName}" has local modifications:`);
    console.log(`  Dirty skills: ${dirtySkillNames}`);
    if (sourceType === 'git' && allSkills.length > 0) {
      console.log(`  All skills in source: ${allSkillNames}`);
      if (allSkills.length > dirtyResult.dirtySkills.length) {
        console.log(`  ⚠ Updating or skipping will affect ALL ${allSkills.length} skills, not just the dirty ones.`);
      }
    }
    console.log('');

    const choice = await select({
      message: 'Choose action:',
      choices: [
        { name: '(S) Skip — keep local modifications, skip this source', value: 'skip' as const },
        { name: '(o) Overwrite — stash local changes and update to latest', value: 'update' as const },
        { name: '(q) Quit — stop update', value: 'quit' as const }
      ],
      default: 'skip'
    });

    if (choice === 'update') {
      await performStashOrBackup({
        homeDir,
        sourceName,
        sourceType,
        dirtySkills: dirtyResult.dirtySkills,
        backupsDir,
        checkoutDir,
        updatedAt,
        options
      });
    }

    return choice;
  } else if (hasNonSkillDirty) {
    // Non-skill dirty: different message, default to update
    console.log(`\n⚠ Source "${sourceName}" has uncommitted changes (not in skills):`);
    console.log(`  These files are not skills, but \`git reset --hard\` will discard them.`);
    console.log('');

    const choice = await select({
      message: 'Choose action:',
      choices: [
        { name: '(S) Skip — keep local modifications, skip this source', value: 'skip' as const },
        { name: '(o) Overwrite — stash local changes and update to latest', value: 'update' as const },
        { name: '(q) Quit — stop update', value: 'quit' as const }
      ],
      default: 'skip'
    });

    return choice;
  }

  return 'update';
}

async function detectGitDirty(checkoutDir: string, sourcePath: string): Promise<DirtyDetectionResult> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, 'status', '--porcelain']);
    // Don't use trim() - it removes leading spaces from git status format "XY PATH"
    const lines = stdout.split('\n').filter(line => line.length > 0);

    if (lines.length === 0) {
      return { isDirty: false, dirtySkills: [], nonSkillDirty: false };
    }

    const dirtySkills: DirtySkillInfo[] = [];
    let nonSkillDirty = false;

    // Normalize source path (remove leading/trailing slashes, handle '.')
    const normalizedPath = sourcePath === '.' ? '' : sourcePath.replace(/^\/|\/$/g, '');
    const pathPrefix = normalizedPath ? normalizedPath + '/' : '';

    for (const line of lines) {
      const filePath = line.slice(3);

      // Check if file is within the source path
      if (pathPrefix && !filePath.startsWith(pathPrefix)) {
        nonSkillDirty = true;
        continue;
      }

      // Extract relative path within source directory
      const relativePath = pathPrefix ? filePath.slice(pathPrefix.length) : filePath;
      const parts = relativePath.split('/');

      // First directory component is the skill name
      if (parts.length >= 1 && parts[0]) {
        const skillName = parts[0];
        if (!dirtySkills.some(s => s.name === skillName)) {
          dirtySkills.push({
            name: skillName,
            path: join(checkoutDir, normalizedPath, skillName),
            hash: ''
          });
        }
      } else {
        nonSkillDirty = true;
      }
    }

    return { isDirty: true, dirtySkills, nonSkillDirty };
  } catch {
    return { isDirty: false, dirtySkills: [], nonSkillDirty: false };
  }
}

async function detectHttpDirty(
  homeDir: string,
  sourceName: string,
  materializedSkills: string[]
): Promise<DirtyDetectionResult> {
  const registry = await loadSkillsRegistry(homeDir);
  const dirtySkills: DirtySkillInfo[] = [];

  for (const skillName of materializedSkills) {
    const entry = registry.skills[skillName];
    if (!entry || entry.origin !== sourceName || !entry.last_update_hash) continue;

    // Use registry path directly instead of constructing from skillsDir
    const skillPath = entry.path;
    try {
      const currentHash = await hashSkillDirectory(skillPath);
      if (currentHash !== entry.last_update_hash) {
        dirtySkills.push({ name: skillName, path: skillPath, hash: currentHash });
      }
    } catch {
      // Skill path may not exist
    }
  }

  return {
    isDirty: dirtySkills.length > 0,
    dirtySkills,
    nonSkillDirty: false
  };
}

async function updateRegistryHashesForHttp(
  homeDir: string,
  sourceName: string,
  skillsDir: string,
  skills: string[]
): Promise<void> {
  const registry = await loadSkillsRegistry(homeDir);
  let changed = false;

  for (const skillName of skills) {
    const skillPath = join(skillsDir, skillName);
    try {
      const hash = await hashSkillDirectory(skillPath);
      if (registry.skills[skillName]) {
        registry.skills[skillName].last_update_hash = hash;
        changed = true;
      }
    } catch {
      // Skill may not exist
    }
  }

  if (changed) {
    await saveSkillsRegistry(homeDir, registry);
  }
}

async function syncSource(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  updatedAt: string,
  options: UpdateSourceOptions = {}
): Promise<SourceState> {
  if (options.dryRun) {
    const previousState = await loadSourceState(homeDir, name);
    return previousState ?? { materialized_skills: [], updated_at: updatedAt };
  }

  const { skillsDir, syncDir } = getSyncPaths(homeDir);
  const previousState = await loadSourceState(homeDir, name);
  const previousSkills = previousState?.materialized_skills ?? [];

  // Dirty detection for git sources (before fetch)
  if (source.type === 'git' && previousSkills.length > 0) {
    const checkoutDir = join(syncDir, '.sources', name, 'checkout');
    if (await pathExists(checkoutDir)) {
      const dirtyResult = await detectGitDirty(checkoutDir, source.path);
      const hasSkillDirty = dirtyResult.dirtySkills.length > 0;
      const hasNonSkillDirty = dirtyResult.nonSkillDirty && !hasSkillDirty;

      if (dirtyResult.isDirty && (hasSkillDirty || hasNonSkillDirty)) {
        const decision = await handleDirtySource({
          homeDir,
          sourceName: name,
          sourceType: 'git',
          dirtyResult,
          hasSkillDirty,
          hasNonSkillDirty,
          options,
          backupsDir: join(syncDir, 'backups'),
          allSkills: previousSkills,
          checkoutDir,
          updatedAt
        });

          if (decision === 'skip') {
          return previousState ?? { materialized_skills: previousSkills, updated_at: updatedAt };
        }
        if (decision === 'quit') {
          throw new DirtySourceQuitError();
        }
        // decision === 'update' - continue with update
      }
    }
  }

  // Dirty detection for HTTP sources (before download)
  if (source.type === 'http' && previousSkills.length > 0) {
    const dirtyResult = await detectHttpDirty(homeDir, name, previousSkills);

    if (dirtyResult.isDirty) {
      const decision = await handleDirtySource({
        homeDir,
        sourceName: name,
        sourceType: 'http',
        dirtyResult,
        hasSkillDirty: dirtyResult.dirtySkills.length > 0,
        hasNonSkillDirty: false, // HTTP sources don't have non-skill files
        options,
        backupsDir: join(syncDir, 'backups'),
        allSkills: previousSkills,
        updatedAt
      });

      if (decision === 'skip') {
        return previousState ?? { materialized_skills: previousSkills, updated_at: updatedAt };
      }
      if (decision === 'quit') {
        throw new DirtySourceQuitError();
      }
      // decision === 'update' - continue with update
    }
  }

  const materializedRoot = await prepareMaterializedRoot(homeDir, name, source, options.gitOverwriteRecord);
  const ownershipState = await loadSkillOwnershipState(homeDir);
  const materializedSkills = await listSkillDirectories(materializedRoot);

  const nextOwnership = structuredClone(ownershipState) as SkillOwnershipState;

  await mkdir(skillsDir, { recursive: true });
  await assertMaterializationTargetsAvailable(skillsDir, materializedRoot, previousSkills, materializedSkills, source.type, name, ownershipState);

  // Identify removed skills and ask user what to do
  const removedSkills = previousSkills.filter(
    skill => !materializedSkills.includes(skill) && ownershipState.owners[skill] === name
  );

  if (removedSkills.length > 0) {
    await handleRemovedSkills(homeDir, name, removedSkills, skillsDir, nextOwnership, options);
  }

  await removeStaleSkills(skillsDir, materializedRoot, previousSkills, materializedSkills, source.type, name, nextOwnership);

  for (const skill of materializedSkills) {
    const sourceDir = join(materializedRoot, skill);
    const targetDir = join(skillsDir, skill);

    if (source.type === 'local') {
      await recreateSymlink(sourceDir, targetDir);
    } else if (source.type === 'git' || source.type === 'http') {
      await copySkillDirectory(sourceDir, targetDir);
    } else {
      throw new Error(`Source type not implemented: ${source.type}`);
    }

    nextOwnership.owners[skill] = name;
  }

  const nextState: SourceState = {
    materialized_skills: materializedSkills,
    updated_at: updatedAt
  };

  await saveSourceState(homeDir, name, nextState);
  await saveSkillOwnershipState(homeDir, nextOwnership);

  // Update last_update_hash for HTTP sources after successful update
  if (source.type === 'http') {
    await updateRegistryHashesForHttp(homeDir, name, skillsDir, materializedSkills);
  }

  if (source.type === 'http' && !options.force) {
    await clearSourceHistory(homeDir, name);
  }

  return nextState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSourceEntry(name: string, value: unknown): SourceEntry[] {
  if (!isRecord(value)) {
    return [];
  }

  if (value.type !== 'local' && value.type !== 'git' && value.type !== 'http') {
    return [];
  }

  // Support legacy 'store' field for backward compatibility
  const pathValue = typeof value.path === 'string' ? value.path : (value as Record<string, unknown>).store;
  if (typeof value.url !== 'string' || typeof pathValue !== 'string') {
    return [];
  }

  if (typeof value.branch === 'string') {
    return [{ name, type: value.type, url: value.url, path: pathValue, branch: value.branch }];
  }

  return [{ name, type: value.type, url: value.url, path: pathValue }];
}

function normalizeSourceState(value: unknown): SourceState {
  if (!isRecord(value) || typeof value.updated_at !== 'string') {
    throw new Error('Source state is invalid');
  }

  return {
    materialized_skills: Array.isArray(value.materialized_skills)
      ? value.materialized_skills.filter((skill): skill is string => typeof skill === 'string').sort()
      : [],
    updated_at: value.updated_at
  };
}

function getSourceStateFile(homeDir: string, name: string): string {
  return join(getSyncPaths(homeDir).syncDir, '.sources', name, 'state.json');
}

function getSkillOwnershipStateFile(homeDir: string): string {
  return join(getSyncPaths(homeDir).syncDir, '.sources', 'skills.json');
}

export async function loadSkillOwnershipState(homeDir: string): Promise<SkillOwnershipState> {
  const stateFile = getSkillOwnershipStateFile(homeDir);

  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    return normalizeSkillOwnershipState(value);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { owners: {} };
    }
    throw error;
  }
}

// Re-export registry functions for backward compatibility
export { loadSkillsRegistry, saveSkillsRegistry } from './core/skills-registry.js';

export async function buildSkillsRegistry(homeDir = homedir()): Promise<SkillsRegistry> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const existingRegistry = await loadSkillsRegistry(homeDir);
  const registry: SkillsRegistry = { version: 1, skills: {} };

  // Preserve ignored skills from existing registry
  for (const [name, entry] of Object.entries(existingRegistry.skills)) {
    if (entry.status === 'ignored') {
      registry.skills[name] = entry;
    }
  }

  // 1. Add manual skills from ~/.syncskill/skills/
  // Manual skills ALWAYS take priority over source skills with the same name
  if (await pathExists(skillsDir)) {
    const manualSkills = await listSkillDirectories(skillsDir);
    for (const skill of manualSkills) {
      // Don't overwrite ignored status if it exists
      if (registry.skills[skill]?.status === 'ignored') continue;

      registry.skills[skill] = {
        path: join(skillsDir, skill),
        origin: 'manual',
        type: 'manual',
        status: 'active',
      };
    }
  }

  // 2. Add skills from configured sources
  for (const [sourceName, sourceDef] of Object.entries(config.sources)) {
    const sourceEntry = normalizeSourceEntry(sourceName, sourceDef)[0];
    if (!sourceEntry) continue;

    const sourceState = await loadSourceState(homeDir, sourceName);
    if (!sourceState) continue;

    for (const skill of sourceState.materialized_skills) {
      // Skip if already added as manual skill or ignored
      if (registry.skills[skill]?.origin === 'manual') continue;
      if (registry.skills[skill]?.status === 'ignored') continue;

      const materializedRoot = getMaterializedRootPath(homeDir, sourceName, sourceEntry);
      registry.skills[skill] = {
        path: join(materializedRoot, skill),
        origin: sourceName,
        type: sourceEntry.type,
        status: 'active',
      };
    }
  }

  return registry;
}

// Backward compatibility aliases
export const buildSkillsIndex = buildSkillsRegistry;
export const loadSkillsIndex = loadSkillsRegistry;
export const saveSkillsIndex = saveSkillsRegistry;

async function saveSkillOwnershipState(homeDir: string, state: SkillOwnershipState): Promise<void> {
  const stateFile = getSkillOwnershipStateFile(homeDir);
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function saveSourceState(homeDir: string, name: string, state: SourceState): Promise<void> {
  const stateFile = getSourceStateFile(homeDir, name);
  await mkdir(join(getSyncPaths(homeDir).syncDir, '.sources', name), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function normalizeSkillOwnershipState(value: unknown): SkillOwnershipState {
  if (!isRecord(value) || !isRecord(value.owners)) {
    return { owners: {} };
  }

  const owners: Record<string, string> = {};

  for (const [skill, owner] of Object.entries(value.owners)) {
    if (typeof owner === 'string') {
      owners[skill] = owner;
    }
  }

  return { owners };
}

async function prepareMaterializedRoot(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  gitOverwriteRecord?: Pick<GitUpdateRecord, 'before_commit' | 'stash_commit'>
): Promise<string> {
  if (source.type === 'local') {
    // Local archive: extract to ~/.syncskill/sources/<name>/checkout/
    if (source.archive_path) {
      return prepareLocalArchiveMaterializedRoot(homeDir, name, source);
    }
    // Local directory: use as-is
    return getLocalMaterializedRoot(source);
  }

  if (source.type === 'git') {
    return prepareGitMaterializedRoot(homeDir, name, source, gitOverwriteRecord);
  }

  if (source.type === 'http') {
    return prepareHttpMaterializedRoot(homeDir, name, source);
  }

  throw new Error(`Source type not implemented: ${source.type}`);
}

async function prepareHttpMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const checkoutDir = getHttpCheckoutDir(homeDir, name);
  const runtimeDir = dirname(checkoutDir);
  const stagingDir = join(runtimeDir, 'checkout.next');
  const backupDir = join(runtimeDir, 'checkout.prev');

  // Detect format from URL first
  const urlFormat = detectArchiveFormat(source.url);
  // Use a temporary extension for download, will be updated after checking Content-Disposition
  const tempArchiveFile = join(runtimeDir, 'archive.download');

  await rm(stagingDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    const { detectedFormat } = await downloadHttpArchive(source.url, tempArchiveFile);

    // Prefer Content-Disposition format over URL format (for URLs without clear extension)
    // Only use Content-Disposition if URL gave us the default tar.gz fallback
    const isUrlFormatDefault = urlFormat.type === 'tar.gz' && !source.url.split('?')[0].toLowerCase().match(/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|zip)$/);
    const archiveFormat = (isUrlFormatDefault && detectedFormat) ? detectedFormat : urlFormat;

    const archiveFile = join(runtimeDir, `archive${archiveFormat.extension}`);
    await rename(tempArchiveFile, archiveFile);

    await extractArchive(archiveFile, stagingDir, archiveFormat.type);

    if (isAbsolute(source.path)) {
      throw new Error('HTTP source path must be a relative path');
    }

    const materializedRoot = resolve(stagingDir, source.path);
    const relativePath = relative(stagingDir, materializedRoot);

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('HTTP source path must stay within the checkout root');
    }

    await replaceCheckoutDirectory(checkoutDir, stagingDir, backupDir);
    return resolve(checkoutDir, source.path);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    // Clean up any archive files (both temp and final)
    await rm(tempArchiveFile, { force: true });
    const archiveFiles = await readdir(runtimeDir).catch(() => []);
    for (const file of archiveFiles) {
      if (file.startsWith('archive.')) {
        await rm(join(runtimeDir, file), { force: true });
      }
    }
    await rm(backupDir, { recursive: true, force: true });
  }
}

async function prepareLocalArchiveMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const checkoutDir = join(getSyncPaths(homeDir).syncDir, '.sources', name, 'checkout');
  const runtimeDir = dirname(checkoutDir);
  const stagingDir = join(runtimeDir, 'checkout.next');
  const backupDir = join(runtimeDir, 'checkout.prev');

  // Resolve the archive path (handle ~ expansion)
  const archivePath = source.archive_path ?? source.url;
  const resolvedArchivePath = archivePath.startsWith('~')
    ? join(homedir(), archivePath.slice(1))
    : resolve(archivePath);

  // Detect format from archive file name
  const archiveFormat = detectArchiveFormat(resolvedArchivePath);

  await rm(stagingDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    await extractArchive(resolvedArchivePath, stagingDir, archiveFormat.type);

    if (isAbsolute(source.path)) {
      throw new Error('Local archive source path must be a relative path');
    }

    const materializedRoot = resolve(stagingDir, source.path);
    const relativePath = relative(stagingDir, materializedRoot);

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('Local archive source path must stay within the extracted root');
    }

    await replaceCheckoutDirectory(checkoutDir, stagingDir, backupDir);
    return resolve(checkoutDir, source.path);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
}

async function prepareGitMaterializedRoot(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  gitOverwriteRecord?: Pick<GitUpdateRecord, 'before_commit' | 'stash_commit'>
): Promise<string> {
  const checkoutDir = getGitCheckoutDir(homeDir, name);
  const branch = source.branch ?? (await detectGitDefaultBranch(source.url));

  if (await pathExists(checkoutDir)) {
    // Directory exists - check if it's a valid git repo with matching remote URL
    const isValid = await isValidGitRepoWithMatchingRemote(checkoutDir, source.url);
    if (!isValid) {
      // Remove stale/mismatched checkout and re-clone
      await rm(checkoutDir, { recursive: true, force: true });
    }
  }

  if (!(await pathExists(checkoutDir))) {
    await mkdir(dirname(checkoutDir), { recursive: true });
    await runGit(['clone', '--single-branch', '--depth', '1', '--branch', branch, source.url, checkoutDir]);
  }

  await runGit(['-C', checkoutDir, 'fetch', '--depth=1', 'origin', branch]);
  await runGit(['-C', checkoutDir, 'reset', '--hard', 'FETCH_HEAD']);

  if (gitOverwriteRecord) {
    const { stdout: afterCommit } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD']);
    await recordGitOverwrite(homeDir, name, {
      type: 'git',
      before_commit: gitOverwriteRecord.before_commit,
      after_commit: afterCommit.trim(),
      stash_commit: gitOverwriteRecord.stash_commit,
      timestamp: new Date().toISOString(),
    });
  } else {
    await clearSourceHistory(homeDir, name);
  }

  if (isAbsolute(source.path)) {
    throw new Error('Git source path must be a relative path');
  }

  const materializedRoot = resolve(checkoutDir, source.path);
  const relativePath = relative(checkoutDir, materializedRoot);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Git source path must stay within the checkout root');
  }

  return materializedRoot;
}

function getGitCheckoutDir(homeDir: string, name: string): string {
  return join(getSyncPaths(homeDir).syncDir, '.sources', name, 'checkout');
}

function getHttpCheckoutDir(homeDir: string, name: string): string {
  return join(getSyncPaths(homeDir).syncDir, '.sources', name, 'checkout');
}

function getLocalMaterializedRoot(source: SourceDefinition): string {
  if (isAbsolute(source.path)) {
    throw new Error('Local source path must be a relative path');
  }

  const sourceRoot = resolve(source.url);
  const materializedRoot = resolve(sourceRoot, source.path);
  const relativePath = relative(sourceRoot, materializedRoot);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Local source path must stay within the source root');
  }

  return materializedRoot;
}

async function listSkillDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function listSkillDirectoriesWithSkillMd(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const skills: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(root, entry.name, 'SKILL.md');
      if (await pathExists(skillMdPath)) {
        skills.push(entry.name);
      }
    }

    return skills.sort();
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function removeStaleSkills(
  skillsDir: string,
  materializedRoot: string,
  previousSkills: string[],
  nextSkills: string[],
  sourceType: SourceType,
  sourceName: string,
  ownershipState: SkillOwnershipState
): Promise<void> {
  for (const staleSkill of previousSkills.filter((skill) => !nextSkills.includes(skill))) {
    if (ownershipState.owners[staleSkill] !== sourceName) {
      continue;
    }

    const targetDir = join(skillsDir, staleSkill);

    if (sourceType === 'git' || sourceType === 'http') {
      if (!(await pathExists(targetDir))) {
        delete ownershipState.owners[staleSkill];
        continue;
      }

      if (await isSymbolicLink(targetDir)) {
        continue;
      }

      await rm(targetDir, { recursive: true, force: true });
      delete ownershipState.owners[staleSkill];
      continue;
    }

    const expectedTarget = join(materializedRoot, staleSkill);
    const currentTarget = await readlinkIfMatches(targetDir);

    if (currentTarget !== expectedTarget) {
      continue;
    }

    await rm(targetDir, { recursive: true, force: true });
    delete ownershipState.owners[staleSkill];
  }
}

async function copySkillDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const parentDir = dirname(targetDir);
  const targetName = relative(parentDir, targetDir);
  const stagingDir = join(parentDir, `${targetName}.next`);
  const backupDir = join(parentDir, `${targetName}.prev`);
  const hadTarget = await pathExists(targetDir);

  await rm(stagingDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });

  try {
    await cp(sourceDir, stagingDir, { recursive: true });

    if (hadTarget) {
      await renamePath(targetDir, backupDir);
    }

    try {
      await renamePath(stagingDir, targetDir);
    } catch (error) {
      if (hadTarget && !(await pathExists(targetDir)) && (await pathExists(backupDir))) {
        await rename(backupDir, targetDir);
      }

      throw error;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
}

async function recreateSymlink(sourceDir: string, targetDir: string): Promise<void> {
  const currentTarget = await readlinkIfMatches(targetDir);

  if (currentTarget === sourceDir) {
    return;
  }

  await rm(targetDir, { recursive: true, force: true });
  await symlink(sourceDir, targetDir, 'dir');
}

async function assertMaterializationTargetsAvailable(
  skillsDir: string,
  materializedRoot: string,
  previousSkills: string[],
  skillNames: string[],
  sourceType: SourceType,
  sourceName: string,
  ownershipState: SkillOwnershipState
): Promise<void> {
  for (const skillName of skillNames) {
    const targetDir = join(skillsDir, skillName);
    const expectedTarget = join(materializedRoot, skillName);
    const currentTarget = await readlinkIfMatches(targetDir);

    if (currentTarget === expectedTarget) {
      continue;
    }

    if (
      (sourceType === 'git' || sourceType === 'http') &&
      previousSkills.includes(skillName) &&
      ownershipState.owners[skillName] === sourceName &&
      (await isReusableManagedCopiedTarget(targetDir))
    ) {
      continue;
    }

    if (currentTarget !== null || (await pathExists(targetDir))) {
      throw new Error(`Skill path is already occupied: ${skillName}`);
    }
  }
}

async function isReusableManagedCopiedTarget(targetPath: string): Promise<boolean> {
  try {
    const stats = await lstat(targetPath);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function readlinkIfMatches(targetDir: string): Promise<string | null> {
  try {
    const stats = await lstat(targetDir);

    if (!stats.isSymbolicLink()) {
      return null;
    }

    return resolve(dirname(targetDir), await readlink(targetDir));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function isSymbolicLink(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

interface DownloadResult {
  /** Archive format detected from Content-Disposition header, if any */
  detectedFormat: ArchiveFormat | null;
}

async function downloadHttpArchive(url: string, destinationFile: string): Promise<DownloadResult> {
  const response = await fetch(url);

  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download HTTP source archive: ${response.status} ${response.statusText}`.trim());
  }

  // Try to detect format from Content-Disposition header
  const contentDisposition = response.headers.get('content-disposition');
  const filename = parseContentDisposition(contentDisposition);
  const detectedFormat = filename ? detectArchiveFormatFromFilename(filename) : null;

  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destinationFile));
  } catch (error) {
    await rm(destinationFile, { force: true });
    throw error;
  }

  return { detectedFormat };
}

async function replaceCheckoutDirectory(checkoutDir: string, stagingDir: string, backupDir: string): Promise<void> {
  const hadCheckout = await pathExists(checkoutDir);

  if (hadCheckout) {
    await renamePath(checkoutDir, backupDir);
  }

  try {
    await renamePath(stagingDir, checkoutDir);
  } catch (error) {
    if (hadCheckout && !(await pathExists(checkoutDir)) && (await pathExists(backupDir))) {
      await renamePath(backupDir, checkoutDir);
    }

    throw error;
  }
}

async function renamePath(sourcePath: string, destinationPath: string): Promise<void> {
  if (process.env.SYNCSKILL_TEST_FAIL_RENAME_TO !== undefined && destinationPath.endsWith(process.env.SYNCSKILL_TEST_FAIL_RENAME_TO)) {
    throw new Error('simulated rename failure');
  }

  await rename(sourcePath, destinationPath);
}

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args);
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    throw new Error(execError.stderr?.trim() || execError.message);
  }
}

function normalizeGitUrl(url: string): string {
  let normalized = url.trim();
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');
  // Remove .git suffix for comparison
  normalized = normalized.replace(/\.git$/, '');
  return normalized;
}

async function isValidGitRepoWithMatchingRemote(checkoutDir: string, expectedUrl: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, 'remote', 'get-url', 'origin']);
    const currentUrl = stdout.trim();
    return normalizeGitUrl(currentUrl) === normalizeGitUrl(expectedUrl);
  } catch {
    // Any git error (not a git repo, no 'origin' remote, permission denied, corrupted repo)
    // is treated as invalid — we'll re-clone to ensure correctness
    return false;
  }
}

export async function detectGitDefaultBranch(url: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', url, 'HEAD']);
    const match = stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
    return match?.[1] ?? 'main';
  } catch {
    return 'main';
  }
}

// pathExists is now exported from utils.ts and re-exported here for backwards compatibility
export { pathExists } from './utils/utils.js';

export async function discoverSourceSkills(
  sourceRoot: string,
  fallbackName?: string
): Promise<string[]> {
  // Priority 1: Check for skills/ subdirectory (multi-skill mode)
  const skillsSubdir = join(sourceRoot, 'skills');
  if (await pathExists(skillsSubdir)) {
    const entries = await readdir(skillsSubdir, { withFileTypes: true });
    const skills: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(skillsSubdir, entry.name, 'SKILL.md');
      if (await pathExists(skillMdPath)) {
        skills.push(entry.name);
      }
    }

    return skills.sort();
  }

  // Priority 2: Check for SKILL.md in root (single-skill mode)
  const rootSkillMd = join(sourceRoot, 'SKILL.md');
  if (await pathExists(rootSkillMd) && fallbackName) {
    return [fallbackName];
  }

  return [];
}

export function resolveSkillPath(
  sourceRoot: string,
  skillName: string,
  skillSubdir?: string
): string {
  if (skillSubdir) {
    return join(sourceRoot, skillSubdir, skillName);
  }

  // Default: skills/ subdirectory
  return join(sourceRoot, 'skills', skillName);
}

export interface GitHubUrlParsed {
  org: string;
  repo: string;
  branch?: string;
  path: string;
  cloneUrl: string;
  skillName: string;
}

export interface AddSourceFromUrlOptions {
  name?: string;
  type?: SourceType;
  path?: string;
  skillSubdir?: string;
  branch?: string;
  /** Skip interactive skill selection, select all non-duplicate skills */
  skipPrompt?: boolean;
  /** Callback for interactive skill selection (when not skipPrompt) */
  onSelectSkills?: (skills: DiscoveredSkill[], existingSkills: Set<string>) => Promise<string[]>;
}

export interface AddSourceFromUrlResult {
  name: string;
  source: SourceDefinition;
  sameRepoMatch?: ExistingSourceMatch;
  restoredFromIgnore?: boolean;
  restoredSkill?: string;
}

export async function addSourceFromUrl(
  homeDir = homedir(),
  urlOrName: string,
  options: AddSourceFromUrlOptions = {}
): Promise<AddSourceFromUrlResult> {
  const { syncDir } = getSyncPaths(homeDir);

  // Check if input is a local archive file
  const detected = detectSourceType(urlOrName);
  if (detected?.type === 'local' && detected.isArchive) {
    // Resolve archive path
    const archivePath = urlOrName.startsWith('~')
      ? join(homedir(), urlOrName.slice(1))
      : resolve(urlOrName);

    // Extract name from archive file name (remove extension)
    const baseName = archivePath.split('/').pop() ?? 'archive';
    const nameWithoutExt = baseName
      .replace(/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip)$/i, '');
    const sourceName = options.name ?? nameWithoutExt;

    // Set up source with archive_path
    const source: SourceDefinition = {
      type: 'local',
      url: join(syncDir, '.sources', sourceName, 'checkout'),
      path: options.skillSubdir ?? '.',
      archive_path: archivePath,
    };

    await addSource(homeDir, sourceName, source);
    return { name: sourceName, source };
  }

  const parsed = parseGitHubUrl(urlOrName);

  if (parsed) {
    // Check for existing source with same URL
    const existingMatch = await findExistingSourceByUrl(homeDir, parsed.cloneUrl);

    if (existingMatch) {
      // Check if the requested skill is in the ignore list
      const registry = await loadSkillsRegistry(homeDir);
      const requestedSkillName = parsed.skillName;

      if (requestedSkillName && isSkillIgnored(registry, requestedSkillName)) {
        // Restore from ignore list (activate it)
        const updatedRegistry = activateSkill(registry, requestedSkillName);
        await saveSkillsRegistry(homeDir, updatedRegistry);

        // Add to links
        const config = await loadConfig(homeDir);
        config.links[requestedSkillName] = ['*'];
        await saveConfig(config, homeDir);

        return {
          name: existingMatch.name,
          source: existingMatch.source,
          sameRepoMatch: existingMatch,
          restoredFromIgnore: true,
          restoredSkill: requestedSkillName
        };
      }

      // Not in ignore - return for CLI to handle interactively
      return {
        name: existingMatch.name,
        source: existingMatch.source,
        sameRepoMatch: existingMatch,
      };
    }

    const name = options.name ?? parsed.skillName;
    const targetPath = options.path ?? join(syncDir, 'sources', parsed.repo);
    const source: SourceDefinition = {
      type: options.type ?? 'git',
      url: parsed.cloneUrl,
      path: relative(syncDir, targetPath) || '.',
      ...(parsed.branch || options.branch ? { branch: options.branch ?? parsed.branch } : {}),
    };

    await addSource(homeDir, name, source);
    return { name, source };
  }

  // For non-GitHub URLs with explicit type
  if (options.type === 'git' || options.type === 'http') {
    const existingMatch = await findExistingSourceByUrl(homeDir, urlOrName);
    if (existingMatch) {
      return {
        name: existingMatch.name,
        source: existingMatch.source,
        sameRepoMatch: existingMatch,
      };
    }
  }

  // Not a GitHub URL - require explicit parameters
  if (!options.type || !options.path) {
    const expectedFormats = [
      'https://github.com/<org>/<repo>/tree/<branch>/<path>',
      'https://github.com/<org>/<repo>.git',
      'https://github.com/<org>/<repo>'
    ];
    throw new Error(
      `Could not parse URL. Expected GitHub URL formats:\n${expectedFormats.map(f => `  ${f}`).join('\n')}\n\nOr provide explicit --type, --url, and --path options.`
    );
  }

  const name = options.name ?? urlOrName;
  const source: SourceDefinition = {
    type: options.type,
    url: urlOrName,
    path: options.path,
    ...(options.branch ? { branch: options.branch } : {}),
  };

  await addSource(homeDir, name, source);
  return { name, source };
}

export function parseGitHubUrl(url: string): GitHubUrlParsed | null {
  // Pattern: https://github.com/<org>/<repo>/tree/<branch>/<path>
  const treeMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
  if (treeMatch) {
    const [, org, repo, branch, path = ''] = treeMatch;
    const skillName = path ? path.split('/').pop()! : repo;
    return {
      org,
      repo,
      branch,
      path,
      cloneUrl: `https://github.com/${org}/${repo}.git`,
      skillName
    };
  }

  // Pattern: https://github.com/<org>/<repo>.git
  const gitMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/);
  if (gitMatch) {
    const [, org, repo] = gitMatch;
    return {
      org,
      repo,
      branch: undefined,
      path: '',
      cloneUrl: url,
      skillName: repo
    };
  }

  // Pattern: https://github.com/<org>/<repo>
  const plainMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (plainMatch) {
    const [, org, repo] = plainMatch;
    return {
      org,
      repo,
      branch: undefined,
      path: '',
      cloneUrl: `https://github.com/${org}/${repo}.git`,
      skillName: repo
    };
  }

  return null;
}

export async function discoverAllSkills(
  homeDir: string,
  config: SyncSkillConfig
): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);
  const allSkills = new Set<string>();

  // 1. Discover skills from ~/.syncskill/skills/
  if (await pathExists(skillsDir)) {
    const localSkills = await listSkillDirectories(skillsDir);
    for (const skill of localSkills) {
      allSkills.add(skill);
    }
  }

  // 2. Discover skills from configured sources
  for (const [name, sourceDef] of Object.entries(config.sources)) {
    const sourceEntry = normalizeSourceEntry(name, sourceDef)[0];
    if (!sourceEntry) continue;

    try {
      const materializedRoot = getMaterializedRootPath(homeDir, name, sourceEntry);
      if (!(await pathExists(materializedRoot))) continue;

      const sourceSkills = await discoverSourceSkills(materializedRoot, name);
      for (const skill of sourceSkills) {
        allSkills.add(skill);
      }
    } catch {
      // Skip sources that can't be read
    }
  }

  return Array.from(allSkills).sort();
}

function getMaterializedRootPath(homeDir: string, name: string, source: SourceEntry): string {
  if (source.type === 'local') {
    return getLocalMaterializedRoot(source);
  }

  if (source.type === 'git') {
    const checkoutDir = getGitCheckoutDir(homeDir, name);
    return isAbsolute(source.path) ? source.path : resolve(checkoutDir, source.path);
  }

  if (source.type === 'http') {
    const checkoutDir = getHttpCheckoutDir(homeDir, name);
    return isAbsolute(source.path) ? source.path : resolve(checkoutDir, source.path);
  }

  throw new Error(`Unknown source type: ${source.type}`);
}

export function findOrphanSkills(
  sourceName: string,
  _config: SyncSkillConfig,
  ownershipState: SkillOwnershipState,
  localSkills: Set<string>
): string[] {
  const orphans: string[] = [];

  for (const [skill, owner] of Object.entries(ownershipState.owners)) {
    if (owner !== sourceName) continue;

    // Check if skill exists in local skills directory (manual management)
    if (localSkills.has(skill)) continue;

    orphans.push(skill);
  }

  return orphans.sort();
}

export interface ExistingSourceMatch {
  name: string;
  source: SourceEntry;
}

export interface SameRepoMergeOptions {
  existingName: string;
  existingSubdir: string;
  newSubdir: string;
  scenario: SameRepoScenario;
  expandToParent?: boolean;
}

export interface SameRepoMergeResult {
  action: 'restored-from-ignore' | 'already-covered' | 'expanded-to-multi' | 'added-sibling' | 'created-new-entry';
  skillName?: string;
  newSkills?: string[];
  newSourceName?: string;
}

export async function findExistingSourceByUrl(
  homeDir = homedir(),
  url: string
): Promise<ExistingSourceMatch | null> {
  const config = await loadConfig(homeDir);

  for (const [name, sourceDef] of Object.entries(config.sources)) {
    const entry = normalizeSourceEntry(name, sourceDef)[0];
    if (!entry) continue;

    if (entry.url === url) {
      return { name, source: entry };
    }
  }

  return null;
}

export async function handleSameRepoMerge(
  homeDir = homedir(),
  options: SameRepoMergeOptions
): Promise<SameRepoMergeResult> {
  const config = await loadConfig(homeDir);
  const { existingName, existingSubdir, newSubdir, scenario } = options;
  const sourceRaw = config.sources[existingName] as Record<string, unknown>;

  if (!sourceRaw) {
    throw new Error(`Source not found: ${existingName}`);
  }

  if (scenario === SameRepoScenario.NewWithinExisting) {
    // Scenario 1: Check if skill is in ignore list
    const skillName = newSubdir.split('/').pop()!;
    const ignoreList = (sourceRaw.ignore as string[] | undefined) ?? [];

    if (ignoreList.includes(skillName)) {
      // Remove from ignore, add to links
      sourceRaw.ignore = ignoreList.filter(s => s !== skillName);
      if ((sourceRaw.ignore as string[]).length === 0) {
        delete sourceRaw.ignore;
      }
      config.links[skillName] = ['*'];
      await saveConfig(config, homeDir);
      return { action: 'restored-from-ignore', skillName };
    }

    // Skill already covered by multi-skill source
    return { action: 'already-covered', skillName };
  }

  if (scenario === SameRepoScenario.NewContainsExisting) {
    // Scenario 2: Expand to multi-skill directory
    const { syncDir } = getSyncPaths(homeDir);
    const sourceDir = join(syncDir, '.sources', existingName, 'checkout');
    const multiSkillPath = join(sourceDir, newSubdir);

    // Discover all skills in the new multi-skill directory
    // The multiSkillPath is already a skills directory, so scan its subdirectories directly
    const allSkills = await listSkillDirectoriesWithSkillMd(multiSkillPath);
    const existingSkillName = existingSubdir.split('/').pop()!;
    const newSkills = allSkills.filter(s => s !== existingSkillName);

    // Update source to point to multi-skill directory
    sourceRaw.path = newSubdir;

    // Add new skills to links and update ownership (non-conflicting ones)
    const ownershipState = await loadSkillOwnershipState(homeDir);
    const conflicting: string[] = [];
    for (const skill of newSkills) {
      if (ownershipState.owners[skill] && ownershipState.owners[skill] !== existingName) {
        conflicting.push(skill);
      } else {
        config.links[skill] = ['*'];
        ownershipState.owners[skill] = existingName;  // Track ownership
      }
    }

    // Add conflicting skills to ignore (deduplicated)
    if (conflicting.length > 0) {
      const existingIgnore = (sourceRaw.ignore as string[] | undefined) ?? [];
      sourceRaw.ignore = [...new Set([...existingIgnore, ...conflicting])];
    }

    await saveConfig(config, homeDir);
    await saveSkillOwnershipState(homeDir, ownershipState);
    return { action: 'expanded-to-multi', newSkills };
  }

  if (scenario === SameRepoScenario.SameParentSiblings) {
    const newSkillName = newSubdir.split('/').pop()!;

    if (options.expandToParent) {
      // Expand to shared parent directory
      const parentDir = dirname(existingSubdir);
      sourceRaw.path = parentDir.endsWith('/') ? parentDir : parentDir + '/';

      const { syncDir } = getSyncPaths(homeDir);
      const sourceDir = join(syncDir, '.sources', existingName, 'checkout');
      const allSkills = await listSkillDirectoriesWithSkillMd(join(sourceDir, parentDir));

      const ownershipState = await loadSkillOwnershipState(homeDir);
      const conflicting: string[] = [];
      for (const skill of allSkills) {
        if (config.links[skill]) continue;
        if (ownershipState.owners[skill] && ownershipState.owners[skill] !== existingName) {
          conflicting.push(skill);
        } else {
          config.links[skill] = ['*'];
          ownershipState.owners[skill] = existingName;
        }
      }

      if (conflicting.length > 0) {
        const existingIgnore = (sourceRaw.ignore as string[] | undefined) ?? [];
        sourceRaw.ignore = [...new Set([...existingIgnore, ...conflicting])];
      }

      await saveConfig(config, homeDir);
      await saveSkillOwnershipState(homeDir, ownershipState);
      return { action: 'expanded-to-multi', newSkills: allSkills };
    }

    // Just add the new sibling skill, update path to parent, ignore others
    const parentDir = dirname(existingSubdir);
    const existingSkillName = existingSubdir.split('/').pop()!;
    sourceRaw.path = parentDir.endsWith('/') ? parentDir : parentDir + '/';

    const { syncDir } = getSyncPaths(homeDir);
    const sourceDir = join(syncDir, '.sources', existingName, 'checkout');
    const allSkills = await listSkillDirectoriesWithSkillMd(join(sourceDir, parentDir));
    const ignoredSkills = allSkills.filter(s => s !== existingSkillName && s !== newSkillName);

    if (ignoredSkills.length > 0) {
      const existingIgnore = (sourceRaw.ignore as string[] | undefined) ?? [];
      sourceRaw.ignore = [...new Set([...existingIgnore, ...ignoredSkills])];
    }

    config.links[newSkillName] = ['*'];
    const ownershipState = await loadSkillOwnershipState(homeDir);
    ownershipState.owners[newSkillName] = existingName;

    await saveConfig(config, homeDir);
    await saveSkillOwnershipState(homeDir, ownershipState);
    return { action: 'added-sibling', skillName: newSkillName };
  }

  if (scenario === SameRepoScenario.DifferentParents) {
    const existingSource = normalizeSourceEntry(existingName, sourceRaw)[0]!;

    let suffix = 2;
    let newName = `${existingName}.${suffix}`;
    while (config.sources[newName]) {
      suffix++;
      newName = `${existingName}.${suffix}`;
    }

    config.sources[newName] = {
      type: existingSource.type,
      url: existingSource.url,
      path: newSubdir,
      ...(existingSource.branch ? { branch: existingSource.branch } : {}),
    };

    const newSkillName = newSubdir.split('/').pop()!;
    config.links[newSkillName] = ['*'];

    const ownershipState = await loadSkillOwnershipState(homeDir);
    ownershipState.owners[newSkillName] = newName;

    await saveConfig(config, homeDir);
    await saveSkillOwnershipState(homeDir, ownershipState);
    return { action: 'created-new-entry', newSourceName: newName, skillName: newSkillName };
  }

  throw new Error(`Unhandled scenario: ${scenario}`);
}
