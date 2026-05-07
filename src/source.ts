import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { getSyncPaths, loadConfig, saveConfig } from './config.js';

const execFileAsync = promisify(execFile);

export type SourceType = 'local' | 'git' | 'http';

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

interface SkillOwnershipState {
  owners: Record<string, string>;
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
  keepStore?: boolean;
}

export async function removeSource(
  homeDir = homedir(),
  name: string,
  options: RemoveSourceOptions = {}
): Promise<void> {
  const config = await loadConfig(homeDir);

  if (config.sources[name] === undefined) {
    throw new Error(`Source not found: ${name}`);
  }

  delete config.sources[name];
  await saveConfig(config, homeDir);

  const ownershipState = await loadSkillOwnershipState(homeDir);
  const nextOwnership = structuredClone(ownershipState) as SkillOwnershipState;

  for (const [skill, owner] of Object.entries(nextOwnership.owners)) {
    if (owner === name) {
      delete nextOwnership.owners[skill];
    }
  }

  await saveSkillOwnershipState(homeDir, nextOwnership);

  if (!options.keepStore) {
    const sourceDir = join(getSyncPaths(homeDir).syncDir, '.sources', name);
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

async function loadSkillOwnershipState(homeDir: string): Promise<SkillOwnershipState> {
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
  const archiveFile = join(runtimeDir, 'archive.tar.gz');

  await rm(stagingDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    await downloadHttpArchive(source.url, archiveFile);
    await extractTarGzArchive(archiveFile, stagingDir);

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

async function extractTarGzArchive(archiveFile: string, destinationDir: string): Promise<void> {
  try {
    await execFileAsync('tar', ['-xzf', archiveFile, '-C', destinationDir]);
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

async function pathExists(targetPath: string): Promise<boolean> {
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
): Promise<{ name: string; source: SourceDefinition }> {
  const { syncDir } = getSyncPaths(homeDir);
  const parsed = parseGitHubUrl(urlOrName);

  if (parsed) {
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
