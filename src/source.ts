import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { SyncSkillConfig } from './config.js';
import { getSyncPaths, loadConfig, saveConfig } from './config.js';

const execFileAsync = promisify(execFile);

export enum RemovalAction {
  /** Git only: Convert source from git to local, keep store directory */
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
  ref?: string;
}

/**
 * Auto-detect source type from a URL or path string.
 * Returns null if the format is unknown and requires interactive prompting.
 */
export function detectSourceType(input: string): DetectedSourceType | null {
  // File system paths
  if (input.startsWith('/') || input.startsWith('~') || input.startsWith('./') || input.startsWith('../')) {
    return { type: 'local', url: input };
  }

  // GitHub/GitLab URLs - delegate to existing parseGitHubUrl for detailed parsing
  const gitHostMatch = input.match(/^https?:\/\/(github\.com|gitlab\.com)\/([^\/]+)\/([^\/]+)/);
  if (gitHostMatch) {
    // Check for /tree/<branch>/<path> pattern
    const treeMatch = input.match(/\/tree\/([^\/]+)(\/.*)?$/);
    if (treeMatch) {
      const branch = treeMatch[1];
      const repoBase = input.replace(/\/tree\/.*$/, '');
      return { type: 'git', url: `${repoBase}.git`, ref: branch };
    }

    // Plain repo URL
    const url = input.endsWith('.git') ? input : `${input}.git`;
    return { type: 'git', url };
  }

  // .git suffix
  if (input.endsWith('.git')) {
    return { type: 'git', url: input };
  }

  // Archive files
  if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip)$/i.test(input)) {
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

export interface SourceDefinition {
  type: SourceType;
  url: string;
  store: string;
  ref?: string;
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

export interface SkillIndexEntry {
  path: string;
  origin: string;
  type: 'manual' | 'git' | 'http' | 'local';
}

export interface SkillsIndex {
  version: 1;
  skills: Record<string, SkillIndexEntry>;
}

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
  return sources.map((source) => `${source.name}\t${source.type}\t${source.url}\t${source.store}`);
}

export async function loadSourceState(homeDir = homedir(), name: string): Promise<SourceState | null> {
  const stateFile = getSourceStateFile(homeDir, name);

  try {
    return normalizeSourceState(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function materializeSource(
  homeDir = homedir(),
  name: string,
  source: SourceDefinition,
  updatedAt = new Date().toISOString()
): Promise<SourceState> {
  return syncSource(homeDir, name, source, updatedAt);
}

export async function updateSource(
  homeDir = homedir(),
  name: string,
  updatedAt = new Date().toISOString()
): Promise<SourceState> {
  const config = await loadConfig(homeDir);
  const source = normalizeSourceEntry(name, config.sources[name])[0];

  if (source === undefined) {
    throw new Error(`Source not found: ${name}`);
  }

  return syncSource(homeDir, name, source, updatedAt);
}

export async function updateAllSources(homeDir = homedir(), updatedAt = new Date().toISOString()): Promise<SourceState[]> {
  const sources = await listSources(homeDir);
  const states: SourceState[] = [];

  for (const source of sources) {
    states.push(await updateSource(homeDir, source.name, updatedAt));
  }

  return states;
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
  const sourceStore = source.store as string | undefined;

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
    // Convert to local source pointing to checkout directory with original store path
    const checkoutDir = join(sourceDir, 'checkout');
    const originalStore = sourceStore ?? '.';
    config.sources[name] = {
      type: 'local',
      url: checkoutDir,
      store: originalStore,
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

async function syncSource(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  updatedAt: string
): Promise<SourceState> {
  const materializedRoot = await prepareMaterializedRoot(homeDir, name, source);
  const previousState = await loadSourceState(homeDir, name);
  const ownershipState = await loadSkillOwnershipState(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const materializedSkills = await listSkillDirectories(materializedRoot);

  const previousSkills = previousState?.materialized_skills ?? [];
  const nextOwnership = structuredClone(ownershipState) as SkillOwnershipState;

  await mkdir(skillsDir, { recursive: true });
  await assertMaterializationTargetsAvailable(skillsDir, materializedRoot, previousSkills, materializedSkills, source.type, name, ownershipState);
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

  if (typeof value.url !== 'string' || typeof value.store !== 'string') {
    return [];
  }

  if (typeof value.ref === 'string') {
    return [{ name, type: value.type, url: value.url, store: value.store, ref: value.ref }];
  }

  return [{ name, type: value.type, url: value.url, store: value.store }];
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { owners: {} };
    }

    throw error;
  }
}

export function normalizeSkillsIndex(value: unknown): SkillsIndex {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).skills !== 'object'
  ) {
    return { version: 1, skills: {} };
  }
  return value as SkillsIndex;
}

export async function loadSkillsIndex(homeDir = homedir()): Promise<SkillsIndex> {
  const { syncDir } = getSyncPaths(homeDir);
  const indexFile = join(syncDir, 'skills-index.json');

  try {
    const raw = await readFile(indexFile, 'utf-8');
    return normalizeSkillsIndex(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, skills: {} };
    }
    throw error;
  }
}

export async function saveSkillsIndex(homeDir = homedir(), index: SkillsIndex): Promise<void> {
  const { syncDir } = getSyncPaths(homeDir);
  await mkdir(syncDir, { recursive: true });
  const indexFile = join(syncDir, 'skills-index.json');
  await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
}

export async function buildSkillsIndex(homeDir = homedir()): Promise<SkillsIndex> {
  const config = await loadConfig(homeDir);
  const { skillsDir } = getSyncPaths(homeDir);
  const ownershipState = await loadSkillOwnershipState(homeDir);
  const index: SkillsIndex = { version: 1, skills: {} };

  // 1. Add manual skills from ~/.syncskill/skills/
  // Manual skills ALWAYS take priority over source skills with the same name
  if (await pathExists(skillsDir)) {
    const manualSkills = await listSkillDirectories(skillsDir);
    for (const skill of manualSkills) {
      index.skills[skill] = {
        path: join(skillsDir, skill),
        origin: 'manual',
        type: 'manual',
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
      // Skip if already added as manual skill
      if (index.skills[skill]?.origin === 'manual') continue;

      const materializedRoot = getMaterializedRootPath(homeDir, sourceName, sourceEntry);
      index.skills[skill] = {
        path: join(materializedRoot, skill),
        origin: sourceName,
        type: sourceEntry.type,
      };
    }
  }

  return index;
}

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

async function prepareMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  if (source.type === 'local') {
    return getLocalMaterializedRoot(source);
  }

  if (source.type === 'git') {
    return prepareGitMaterializedRoot(homeDir, name, source);
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
  const archiveFormat = detectArchiveFormat(source.url);
  const archiveFile = join(runtimeDir, `archive${archiveFormat.extension}`);

  await rm(stagingDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    await downloadHttpArchive(source.url, archiveFile);
    await extractArchive(archiveFile, stagingDir, archiveFormat.type);

    if (isAbsolute(source.store)) {
      throw new Error('HTTP source store must be a relative path');
    }

    const materializedRoot = resolve(stagingDir, source.store);
    const relativePath = relative(stagingDir, materializedRoot);

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('HTTP source store must stay within the checkout root');
    }

    await replaceCheckoutDirectory(checkoutDir, stagingDir, backupDir);
    return resolve(checkoutDir, source.store);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(archiveFile, { force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
}

async function prepareGitMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const checkoutDir = getGitCheckoutDir(homeDir, name);
  const ref = source.ref ?? (await detectGitDefaultBranch(source.url));

  if (!(await pathExists(checkoutDir))) {
    await mkdir(dirname(checkoutDir), { recursive: true });
    await runGit(['clone', '--single-branch', '--depth', '1', '--branch', ref, source.url, checkoutDir]);
  }

  await runGit(['-C', checkoutDir, 'fetch', '--depth=1', 'origin', ref]);
  await runGit(['-C', checkoutDir, 'reset', '--hard', 'FETCH_HEAD']);

  if (isAbsolute(source.store)) {
    throw new Error('Git source store must be a relative path');
  }

  const materializedRoot = resolve(checkoutDir, source.store);
  const relativePath = relative(checkoutDir, materializedRoot);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Git source store must stay within the checkout root');
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
  if (isAbsolute(source.store)) {
    throw new Error('Local source store must be a relative path');
  }

  const sourceRoot = resolve(source.url);
  const materializedRoot = resolve(sourceRoot, source.store);
  const relativePath = relative(sourceRoot, materializedRoot);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Local source store must stay within the source root');
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function isSymbolicLink(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function downloadHttpArchive(url: string, destinationFile: string): Promise<void> {
  const response = await fetch(url);

  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download HTTP source archive: ${response.status} ${response.statusText}`.trim());
  }

  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destinationFile));
  } catch (error) {
    await rm(destinationFile, { force: true });
    throw error;
  }
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

export type ArchiveType = 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'zip';

export interface ArchiveFormat {
  type: ArchiveType;
  extension: string;
}

export function detectArchiveFormat(url: string): ArchiveFormat {
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.endsWith('.tar.gz') || lowerUrl.endsWith('.tgz')) {
    return { type: 'tar.gz', extension: '.tar.gz' };
  }
  if (lowerUrl.endsWith('.tar.bz2') || lowerUrl.endsWith('.tbz2')) {
    return { type: 'tar.bz2', extension: '.tar.bz2' };
  }
  if (lowerUrl.endsWith('.tar.xz') || lowerUrl.endsWith('.txz')) {
    return { type: 'tar.xz', extension: '.tar.xz' };
  }
  if (lowerUrl.endsWith('.zip')) {
    return { type: 'zip', extension: '.zip' };
  }

  // Default to tar.gz for unknown formats
  return { type: 'tar.gz', extension: '.tar.gz' };
}

async function extractArchive(archiveFile: string, destinationDir: string, archiveType: ArchiveType): Promise<void> {
  try {
    switch (archiveType) {
      case 'tar.gz':
        await execFileAsync('tar', ['-xzf', archiveFile, '-C', destinationDir]);
        break;
      case 'tar.bz2':
        await execFileAsync('tar', ['-xjf', archiveFile, '-C', destinationDir]);
        break;
      case 'tar.xz':
        await execFileAsync('tar', ['-xJf', archiveFile, '-C', destinationDir]);
        break;
      case 'zip':
        await execFileAsync('unzip', ['-q', archiveFile, '-d', destinationDir]);
        break;
    }
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    throw new Error(execError.stderr?.trim() || execError.message);
  }
}

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args);
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    throw new Error(execError.stderr?.trim() || execError.message);
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

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

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
  store?: string;
  skillSubdir?: string;
  ref?: string;
}

export async function addSourceFromUrl(
  homeDir = homedir(),
  urlOrName: string,
  options: AddSourceFromUrlOptions = {}
): Promise<{ name: string; source: SourceDefinition; sameRepoMatch?: ExistingSourceMatch }> {
  const { syncDir } = getSyncPaths(homeDir);
  const parsed = parseGitHubUrl(urlOrName);

  if (parsed) {
    // Check for existing source with same URL
    const existingMatch = await findExistingSourceByUrl(homeDir, parsed.cloneUrl);

    if (existingMatch) {
      // Return the match for CLI to handle interactively
      return {
        name: existingMatch.name,
        source: existingMatch.source,
        sameRepoMatch: existingMatch,
      };
    }

    const name = options.name ?? parsed.skillName;
    const store = options.store ?? join(syncDir, 'sources', parsed.repo);
    const source: SourceDefinition = {
      type: options.type ?? 'git',
      url: parsed.cloneUrl,
      store: relative(syncDir, store) || '.',
      ...(parsed.branch || options.ref ? { ref: options.ref ?? parsed.branch } : {}),
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
  if (!options.type || !options.store) {
    const expectedFormats = [
      'https://github.com/<org>/<repo>/tree/<branch>/<path>',
      'https://github.com/<org>/<repo>.git',
      'https://github.com/<org>/<repo>'
    ];
    throw new Error(
      `Could not parse URL. Expected GitHub URL formats:\n${expectedFormats.map(f => `  ${f}`).join('\n')}\n\nOr provide explicit --type, --url, and --store options.`
    );
  }

  const name = options.name ?? urlOrName;
  const source: SourceDefinition = {
    type: options.type,
    url: urlOrName,
    store: options.store,
    ...(options.ref ? { ref: options.ref } : {}),
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
    return isAbsolute(source.store) ? source.store : resolve(checkoutDir, source.store);
  }

  if (source.type === 'http') {
    const checkoutDir = getHttpCheckoutDir(homeDir, name);
    return isAbsolute(source.store) ? source.store : resolve(checkoutDir, source.store);
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
    sourceRaw.store = newSubdir;

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
      sourceRaw.store = parentDir.endsWith('/') ? parentDir : parentDir + '/';

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

    // Just add the new sibling skill, update store to parent, ignore others
    const parentDir = dirname(existingSubdir);
    const existingSkillName = existingSubdir.split('/').pop()!;
    sourceRaw.store = parentDir.endsWith('/') ? parentDir : parentDir + '/';

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
      store: newSubdir,
      ...(existingSource.ref ? { ref: existingSource.ref } : {}),
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
