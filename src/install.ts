import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSyncPaths, loadConfig, saveConfig } from './config/config.js';
import { listLocalSkillNames } from './core/manifest.js';
import { ensureDefaultLinkTargets } from './core/private-agents.js';
import { linkConfiguredSkills } from './linker.js';
import { addSourceFromUrl, discoverMaterializedSkillEntries, inferRootSkillName, materializeSource, parseGitHubUrl, type AddSourceFromUrlResult, type DiscoveredSkill, type SourceDefinition } from './source.js';
import { pathExists, resolveHomePath } from './utils/utils.js';

/**
 * Get the path to the embedded syncskill skill in dist/skills/syncskill/
 */
export function getEmbeddedSkillPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);
  return join(distDir, 'skills', 'syncskill');
}

export interface InstallSyncskillSkillResult {
  alreadyInstalled: boolean;
  installedPath?: string;
  linkedAgents?: string[];
}

/**
 * Install the embedded syncskill skill to ~/.syncskill/skills/syncskill/
 */
export async function installSyncskillSkill(homeDir: string): Promise<InstallSyncskillSkillResult> {
  const { skillsDir } = getSyncPaths(homeDir);
  const targetPath = join(skillsDir, 'syncskill');

  if (await pathExists(targetPath)) {
    return { alreadyInstalled: true };
  }

  const sourcePath = getEmbeddedSkillPath();

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Embedded syncskill skill not found at: ${sourcePath}`);
  }

  await mkdir(skillsDir, { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true });

  const config = await loadConfig(homeDir);
  if (!config.links['syncskill']) {
    config.links['syncskill'] = await ensureDefaultLinkTargets(homeDir, config);
    await saveConfig(config, homeDir);
  }

  const linkResults = await linkConfiguredSkills(homeDir, { all: false, skillName: 'syncskill' });
  const linkedAgents = [...new Set(linkResults.map((result) => result.agent))].sort();

  return {
    alreadyInstalled: false,
    installedPath: targetPath,
    linkedAgents
  };
}

export interface InstallFromSourceOptions {
  name?: string;
  path?: string;
  skillSubdir?: string;
  type?: 'git' | 'http' | 'local';
  branch?: string;
  skipPrompt?: boolean;
  onSelectSkills?: (skills: DiscoveredSkill[], existingSkills: Set<string>) => Promise<string[]>;
}

export interface InstallFromSourceResult {
  sourceName: string;
  installedSkills: string[];
  linkedAgents: string[];
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

function normalizeSubdir(subdir: string | undefined): string {
  const normalized = (subdir ?? '.')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$|^$/g, '');

  return normalized === '' ? '.' : normalized;
}

function subdirContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeSubdir(parent);
  const normalizedChild = normalizeSubdir(child);

  if (normalizedParent === '.') {
    return true;
  }

  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function getCommonParentSubdir(left: string, right: string): string {
  const normalizedLeft = normalizeSubdir(left);
  const normalizedRight = normalizeSubdir(right);

  if (normalizedLeft === '.' || normalizedRight === '.') {
    return '.';
  }

  const leftParts = normalizedLeft.split('/');
  const rightParts = normalizedRight.split('/');
  const shared: string[] = [];

  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      break;
    }

    shared.push(leftParts[index]);
  }

  return shared.length > 0 ? shared.join('/') : '.';
}

function getRequestedSubdir(urlOrPath: string, options: InstallFromSourceOptions): string {
  const parsed = parseGitHubUrl(urlOrPath);
  return normalizeSubdir(options.skillSubdir ?? options.path ?? parsed?.path ?? '.');
}

function getCheckoutRootPath(homeDir: string, sourceName: string, source: SourceDefinition): string {
  if (source.type === 'local' && !source.archive_path) {
    return resolveHomePath(source.url);
  }

  return resolve(getSyncPaths(homeDir).syncDir, '.sources', sourceName, 'checkout');
}

function getMaterializedRootPath(homeDir: string, sourceName: string, source: SourceDefinition): string {
  if (source.type === 'local') {
    if (source.archive_path) {
      return join(getSyncPaths(homeDir).syncDir, '.sources', sourceName, 'checkout');
    }

    return resolve(resolveHomePath(source.url), source.path);
  }

  return resolve(getSyncPaths(homeDir).syncDir, '.sources', sourceName, 'checkout', source.path);
}

function getIgnoredSkills(sourceRecord: Record<string, unknown> | undefined): Set<string> {
  const ignored = Array.isArray(sourceRecord?.ignore)
    ? sourceRecord.ignore.filter((value): value is string => typeof value === 'string')
    : [];

  return new Set(ignored);
}

function setIgnoredSkills(sourceRecord: Record<string, unknown>, ignoredSkills: Iterable<string>): void {
  const ignoredNames = [...new Set(ignoredSkills)].sort();

  if (ignoredNames.length > 0) {
    sourceRecord.ignore = ignoredNames;
  } else {
    delete sourceRecord.ignore;
  }
}

async function ensureSkillLinks(
  homeDir: string,
  config: LoadedConfig,
  skillNames: Iterable<string>
): Promise<string[]> {
  const requestedSkills = [...new Set(skillNames)].sort();

  for (const skillName of requestedSkills) {
    if (config.links[skillName]) {
      continue;
    }

    config.links[skillName] = await ensureDefaultLinkTargets(homeDir, config);
  }

  return requestedSkills;
}

function isSkillWithinScope(skill: DiscoveredSkill, scope: string): boolean {
  return subdirContains(scope, skill.relativePath);
}

async function scanSkillsForInstallRoot(sourceName: string, source: SourceDefinition, sourceRoot: string): Promise<DiscoveredSkill[]> {
  const discoveredSkills = await discoverMaterializedSkillEntries(sourceName, source, sourceRoot);
  return discoveredSkills.map((skill) => ({
    ...skill,
    relativePath: normalizeSubdir(skill.relativePath)
  }));
}

async function installNewSourceSkills(
  homeDir: string,
  sourceName: string,
  source: SourceDefinition,
  existingSkills: Set<string>,
  options: InstallFromSourceOptions
): Promise<string[]> {
  await materializeSource(homeDir, sourceName, source);

  const materializedRoot = getMaterializedRootPath(homeDir, sourceName, source);
  const discoveredSkills = await scanSkillsForInstallRoot(sourceName, source, materializedRoot);
  const selectedNames = options.onSelectSkills
    ? await options.onSelectSkills(discoveredSkills, existingSkills)
    : discoveredSkills.filter((skill) => !existingSkills.has(skill.name)).map((skill) => skill.name);

  const selectedSet = new Set(selectedNames);
  const config = await loadConfig(homeDir);
  const installableSkillNames = discoveredSkills
    .filter((skill) => selectedSet.has(skill.name) && !existingSkills.has(skill.name))
    .map((skill) => skill.name);

  const installedSkills = await ensureSkillLinks(homeDir, config, installableSkillNames);

  const sourceRecord = config.sources[sourceName] as Record<string, unknown> | undefined;
  if (sourceRecord) {
    setIgnoredSkills(
      sourceRecord,
      discoveredSkills
        .filter((skill) => !selectedSet.has(skill.name) && !existingSkills.has(skill.name))
        .map((skill) => skill.name)
    );
  }

  await saveConfig(config, homeDir);

  return installedSkills;
}

async function resolveSameRepoInstalledSkills(
  homeDir: string,
  result: AddSourceFromUrlResult,
  urlOrPath: string,
  existingSkills: Set<string>,
  options: InstallFromSourceOptions
): Promise<string[]> {
  const existingMatch = result.sameRepoMatch;
  if (!existingMatch) {
    return [];
  }

  const sourceName = existingMatch.name;
  const source = existingMatch.source;
  const existingSubdir = normalizeSubdir(source.path);
  const requestedSubdir = getRequestedSubdir(urlOrPath, options);

  await materializeSource(homeDir, sourceName, source);

  const checkoutRoot = getCheckoutRootPath(homeDir, sourceName, source);
  const discoveredSkills = await scanSkillsForInstallRoot(sourceName, source, checkoutRoot);
  const config = await loadConfig(homeDir);
  const sourceRecord = config.sources[sourceName] as Record<string, unknown> | undefined;

  if (!sourceRecord) {
    throw new Error(`Source not found: ${sourceName}`);
  }

  const ignoredSkills = getIgnoredSkills(sourceRecord);
  const requestedSkills = discoveredSkills.filter((skill) => isSkillWithinScope(skill, requestedSubdir));
  const existingScopeSkills = discoveredSkills.filter((skill) => isSkillWithinScope(skill, existingSubdir));
  const requestedSkillNames = requestedSkills.map((skill) => skill.name);

  for (const skillName of requestedSkillNames) {
    ignoredSkills.delete(skillName);
  }

  const installedSkills = await ensureSkillLinks(
    homeDir,
    config,
    requestedSkillNames.filter((skillName) => !existingSkills.has(skillName))
  );

  const requestedScopeNames = new Set(requestedSkillNames);
  const existingScopeNames = new Set(existingScopeSkills.map((skill) => skill.name));
  let nextSourcePath = existingSubdir;

  if (subdirContains(existingSubdir, requestedSubdir) && existingSubdir !== requestedSubdir) {
    // Keep existing scope; requested skills are already activated above.
  } else if (subdirContains(requestedSubdir, existingSubdir)) {
    nextSourcePath = requestedSubdir;
    sourceRecord.path = nextSourcePath;
    ignoredSkills.clear();
  } else {
    nextSourcePath = getCommonParentSubdir(existingSubdir, requestedSubdir);
    sourceRecord.path = nextSourcePath;

    for (const skill of discoveredSkills) {
      if (existingScopeNames.has(skill.name) || requestedScopeNames.has(skill.name) || config.links[skill.name]) {
        continue;
      }

      ignoredSkills.add(skill.name);
    }
  }

  setIgnoredSkills(sourceRecord, ignoredSkills);

  if (nextSourcePath !== existingSubdir) {
    await materializeSource(homeDir, sourceName, { ...source, path: nextSourcePath });
  }

  await saveConfig(config, homeDir);

  return installedSkills;
}

async function resolveInstalledSkills(
  homeDir: string,
  result: AddSourceFromUrlResult,
  urlOrPath: string,
  existingSkills: Set<string>,
  options: InstallFromSourceOptions
): Promise<string[]> {
  if (result.restoredFromIgnore && result.restoredSkill) {
    return [result.restoredSkill];
  }

  if (result.sameRepoMatch) {
    return resolveSameRepoInstalledSkills(homeDir, result, urlOrPath, existingSkills, options);
  }

  return installNewSourceSkills(homeDir, result.name, result.source, existingSkills, options);
}

async function linkInstalledSkills(homeDir: string, skillNames: Iterable<string>): Promise<string[]> {
  const linkedAgentSet = new Set<string>();

  for (const skillName of skillNames) {
    const linkResults = await linkConfiguredSkills(homeDir, { all: false, skillName });
    for (const linkResult of linkResults) {
      linkedAgentSet.add(linkResult.agent);
    }
  }

  return [...linkedAgentSet].sort();
}

/**
 * Install skills from a URL or local path via the unified install flow.
 */
export async function installFromSource(
  homeDir: string,
  urlOrPath: string,
  options: InstallFromSourceOptions = {}
): Promise<InstallFromSourceResult> {
  const existingSkills = new Set(await listLocalSkillNames(homeDir));

  const result = await addSourceFromUrl(homeDir, urlOrPath, {
    name: options.name,
    path: options.path,
    skillSubdir: options.skillSubdir,
    type: options.type,
    branch: options.branch,
    skipPrompt: options.skipPrompt,
    onSelectSkills: options.onSelectSkills
  });

  const installedSkills = await resolveInstalledSkills(homeDir, result, urlOrPath, existingSkills, options);
  const linkedAgents = await linkInstalledSkills(homeDir, installedSkills);

  return {
    sourceName: result.name,
    installedSkills,
    linkedAgents
  };
}
