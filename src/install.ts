import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addAction, addUnresolved, createPlan, type Plan } from './cli/plan.js';
import { resolveItem, type Resolutions } from './cli/resolution.js';
import { getSyncPaths, loadConfig, saveConfig } from './config/config.js';
import { computeDefaultLinkTargets, ensureDefaultLinkTargets } from './core/private-agents.js';
import { linkConfiguredSkills, type LinkStatus } from './linker.js';
import {
  addSourceFromUrl,
  detectSourceType,
  discoverAllSkills,
  discoverMaterializedSkillEntries,
  findExistingSourceByUrl,
  parseGitHubUrl,
  materializeSource,
  type AddSourceFromUrlResult,
  type DiscoveredSkill,
  type ExistingSourceMatch,
  type SourceDefinition,
} from './source.js';
import { isNotFoundError, pathExists, resolveHomePath } from './utils/utils.js';

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
  alreadyInstalledSkills: string[];
  linkedAgents: string[];
  linkStatuses: LinkStatus[];
}

interface ResolvedInstallSkills {
  installedSkills: string[];
  alreadyInstalledSkills: string[];
}

export interface ExternalInstallPlanOptions {
  name?: string;
  path?: string;
  skillSubdir?: string;
  type?: 'git' | 'http' | 'local';
  branch?: string;
}

export interface ExternalInstallExecutionOptions extends ExternalInstallPlanOptions {
  yes?: boolean;
  applyMode?: boolean;
  selectSkills?: (skills: Array<{ name: string; relativePath: string }>, existingSkills: Set<string>) => Promise<string[]>;
}

export interface ExternalInstallExecutionResult extends InstallFromSourceResult {
  source: {
    name: string;
    type: SourceDefinition['type'];
    url: string;
    path: string;
    branch?: string;
    archive_path?: string;
  };
  ignoredSkills: string[];
  alreadyInstalledSkills: string[];
  installActionId?: string;
  linkActionId?: string;
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

type InstallSourceAction = {
  id?: string;
  op: 'install-source';
  input: string;
  name: string;
  source_type: SourceDefinition['type'];
  url: string;
  path: string;
  requested_path: string;
  branch?: string;
  archive_path?: string;
};

interface ExternalInstallProbeResult {
  name: string;
  source: SourceDefinition;
  sameRepoMatch?: ExistingSourceMatch;
  restoredFromIgnore?: boolean;
  restoredSkill?: string;
}

function normalizeSubdir(subdir: string | undefined): string {
  const normalized = (subdir ?? '.')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');

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

function getConfiguredIgnoredSkills(sourceRecord: Record<string, unknown> | undefined): string[] {
  return Array.isArray(sourceRecord?.ignore)
    ? sourceRecord.ignore.filter((value): value is string => typeof value === 'string')
    : [];
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
): Promise<ResolvedInstallSkills> {
  await materializeSource(homeDir, sourceName, source);

  const materializedRoot = getMaterializedRootPath(homeDir, sourceName, source);
  const discoveredSkills = await scanSkillsForInstallRoot(sourceName, source, materializedRoot);
  const selectedNames = options.onSelectSkills
    ? await options.onSelectSkills(discoveredSkills, existingSkills)
    : discoveredSkills.filter((skill) => !existingSkills.has(skill.name)).map((skill) => skill.name);

  const selectedSet = new Set(selectedNames);
  const config = await loadConfig(homeDir);
  const alreadyInstalledSkills = discoveredSkills
    .filter((skill) => selectedSet.has(skill.name) && existingSkills.has(skill.name))
    .map((skill) => skill.name);
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

  return {
    installedSkills,
    alreadyInstalledSkills
  };
}

async function resolveSameRepoInstalledSkills(
  homeDir: string,
  result: AddSourceFromUrlResult,
  urlOrPath: string,
  existingSkills: Set<string>,
  options: InstallFromSourceOptions
): Promise<ResolvedInstallSkills> {
  const existingMatch = result.sameRepoMatch;
  if (!existingMatch) {
    return {
      installedSkills: [],
      alreadyInstalledSkills: []
    };
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
  const alreadyInstalledSkills = requestedSkillNames.filter((skillName) => existingSkills.has(skillName));

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

  return {
    installedSkills,
    alreadyInstalledSkills
  };
}

async function resolveInstalledSkills(
  homeDir: string,
  result: AddSourceFromUrlResult,
  urlOrPath: string,
  existingSkills: Set<string>,
  options: InstallFromSourceOptions
): Promise<ResolvedInstallSkills> {
  if (result.restoredFromIgnore && result.restoredSkill) {
    return {
      installedSkills: [result.restoredSkill],
      alreadyInstalledSkills: []
    };
  }

  if (result.sameRepoMatch) {
    return resolveSameRepoInstalledSkills(homeDir, result, urlOrPath, existingSkills, options);
  }

  return installNewSourceSkills(homeDir, result.name, result.source, existingSkills, options);
}

async function linkInstalledSkills(homeDir: string, skillNames: Iterable<string>): Promise<{ linkedAgents: string[]; linkStatuses: LinkStatus[] }> {
  const linkedAgentSet = new Set<string>();
  const linkStatuses: LinkStatus[] = [];

  for (const skillName of skillNames) {
    const results = await linkConfiguredSkills(homeDir, { all: false, skillName });
    for (const result of results) {
      if (result.state === 'linked') {
        linkedAgentSet.add(result.agent);
        linkStatuses.push(result);
      }
    }
  }

  return {
    linkedAgents: [...linkedAgentSet].sort(),
    linkStatuses
  };
}

function parseInstallSourceAction(plan: Plan): InstallSourceAction {
  const action = plan.actions.find((item) => item.op === 'install-source');
  if (!action) {
    throw new Error('E_USAGE: install plan is missing install-source action');
  }

  if (
    typeof action.input !== 'string' ||
    typeof action.name !== 'string' ||
    typeof action.source_type !== 'string' ||
    typeof action.url !== 'string' ||
    typeof action.path !== 'string' ||
    typeof action.requested_path !== 'string'
  ) {
    throw new Error('E_USAGE: install-source action is malformed');
  }

  return {
    id: typeof action.id === 'string' ? action.id : undefined,
    op: 'install-source',
    input: action.input,
    name: action.name,
    source_type: action.source_type as SourceDefinition['type'],
    url: action.url,
    path: action.path,
    requested_path: action.requested_path,
    ...(typeof action.branch === 'string' ? { branch: action.branch } : {}),
    ...(typeof action.archive_path === 'string' ? { archive_path: action.archive_path } : {})
  };
}

async function probeInstallSource(
  homeDir: string,
  urlOrPath: string,
  options: ExternalInstallPlanOptions = {}
): Promise<ExternalInstallProbeResult> {
  const { syncDir } = getSyncPaths(homeDir);
  const detected = detectSourceType(urlOrPath);
  const shouldHandleAsLocal = detected?.type === 'local' && (options.type === undefined || options.type === 'local');

  if (shouldHandleAsLocal) {
    const localPath = resolveHomePath(urlOrPath);
    let stats;

    try {
      stats = await stat(localPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(`Local source path not found: ${urlOrPath}`);
      }
      throw error;
    }

    const configuredPath = options.skillSubdir ?? options.path ?? '.';

    if (detected.isArchive) {
      if (!stats.isFile()) {
        throw new Error(`Local archive path must be a file: ${urlOrPath}`);
      }

      const sourceName = options.name ?? localPath.split('/').pop()!.replace(/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|zip)$/i, '');
      return {
        name: sourceName,
        source: {
          type: 'local',
          url: join(syncDir, '.sources', sourceName, 'checkout'),
          path: configuredPath,
          archive_path: localPath,
        }
      };
    }

    if (!stats.isDirectory()) {
      throw new Error(`Local source path must be a directory: ${urlOrPath}`);
    }

    return {
      name: options.name ?? localPath.split('/').pop()!,
      source: {
        type: 'local',
        url: localPath,
        path: configuredPath,
      }
    };
  }

  const parsed = parseGitHubUrl(urlOrPath);
  if (parsed) {
    const existingMatch = await findExistingSourceByUrl(homeDir, parsed.cloneUrl);
    if (existingMatch) {
      const config = await loadConfig(homeDir);
      const sourceRaw = config.sources[existingMatch.name] as Record<string, unknown> | undefined;
      const ignoreList = getConfiguredIgnoredSkills(sourceRaw);

      if (parsed.skillName && ignoreList.includes(parsed.skillName)) {
        return {
          name: existingMatch.name,
          source: existingMatch.source,
          sameRepoMatch: existingMatch,
          restoredFromIgnore: true,
          restoredSkill: parsed.skillName,
        };
      }

      return {
        name: existingMatch.name,
        source: existingMatch.source,
        sameRepoMatch: existingMatch,
      };
    }

    const inferredPath = options.skillSubdir ?? options.path ?? parsed.path;
    return {
      name: options.name ?? parsed.skillName,
      source: {
        type: options.type ?? 'git',
        url: parsed.cloneUrl,
        path: inferredPath === '' ? '.' : inferredPath,
        ...(parsed.branch || options.branch ? { branch: options.branch ?? parsed.branch } : {}),
      }
    };
  }

  if (options.type === 'git' || options.type === 'http') {
    const existingMatch = await findExistingSourceByUrl(homeDir, urlOrPath);
    if (existingMatch) {
      return {
        name: existingMatch.name,
        source: existingMatch.source,
        sameRepoMatch: existingMatch,
      };
    }
  }

  if (!options.type || !options.path) {
    const expectedFormats = [
      'https://github.com/<org>/<repo>/tree/<branch>/<path>',
      'https://github.com/<org>/<repo>.git',
      'https://github.com/<org>/<repo>',
      '/path/to/local-source',
      './local-source',
      '/path/to/source.zip'
    ];
    throw new Error(
      `Could not parse source input. Supported formats include:\n${expectedFormats.map((format) => `  ${format}`).join('\n')}\n\nOr provide explicit --type and --path options.`
    );
  }

  return {
    name: options.name ?? urlOrPath,
    source: {
      type: options.type,
      url: urlOrPath,
      path: options.path,
      ...(options.branch ? { branch: options.branch } : {}),
    }
  };
}

function parseSelectionResolution(resolution: Record<string, unknown>, availableSkillNames: string[]): string[] | null {
  if (resolution.all === true) {
    return availableSkillNames;
  }

  const candidateKeys = ['selected', 'skills', 'values', 'value'];
  for (const key of candidateKeys) {
    const value = resolution[key];
    if (Array.isArray(value)) {
      return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
    }
  }

  return null;
}

/**
 * Build a plan for external install so the command can use the shared plan/apply contract.
 */
export async function buildExternalInstallPlan(
  homeDir: string,
  urlOrPath: string,
  options: ExternalInstallPlanOptions = {}
): Promise<Plan> {
  const probe = await probeInstallSource(homeDir, urlOrPath, options);
  let plan = createPlan('install');
  const config = await loadConfig(homeDir);
  const defaultAgents = (await computeDefaultLinkTargets(homeDir, config)).targets;
  const plannedLinkAgents = probe.restoredFromIgnore ? Object.keys(config.agents).sort() : defaultAgents;
  const source = probe.source;

  if (!probe.sameRepoMatch) {
    plan = addAction(plan, {
      op: 'register-source',
      input: urlOrPath,
      name: probe.name,
      source_type: source.type,
      url: source.url,
      path: source.path,
      ...(source.branch ? { branch: source.branch } : {}),
      ...(source.archive_path ? { archive_path: source.archive_path } : {}),
    });
  }

  plan = addAction(plan, {
    op: 'install-source',
    input: urlOrPath,
    name: probe.name,
    source_type: source.type,
    url: source.url,
    path: source.path,
    requested_path: getRequestedSubdir(urlOrPath, options),
    ...(source.branch ? { branch: source.branch } : {}),
    ...(source.archive_path ? { archive_path: source.archive_path } : {}),
  } satisfies InstallSourceAction);

  plan = addAction(plan, {
    op: 'link-skill',
    skill: probe.restoredSkill ?? '*',
    agents: plannedLinkAgents,
  });

  if (!probe.restoredFromIgnore && !probe.sameRepoMatch) {
    plan = addUnresolved(plan, {
      kind: 'skill-selection',
      resolve_phase: 'execute',
      input: urlOrPath,
      source: {
        name: probe.name,
        type: source.type,
        url: source.url,
        path: source.path,
      },
      default_under_y: 'all',
    });
  }

  return plan;
}

/**
 * Execute an external install plan by delegating to the existing install flow.
 */
export async function executeExternalInstallPlan(
  homeDir: string,
  plan: Plan,
  resolutions: Resolutions,
  options: ExternalInstallExecutionOptions = {}
): Promise<ExternalInstallExecutionResult> {
  const installAction = parseInstallSourceAction(plan);
  const linkAction = plan.actions.find((action) => action.op === 'link-skill');
  const selectionState: {
    discovered: string[];
    existing: Set<string>;
    selected: string[];
  } = {
    discovered: [],
    existing: new Set<string>(),
    selected: [],
  };

  const result = await installFromSource(homeDir, installAction.input, {
    name: installAction.name,
    path: installAction.requested_path,
    type: installAction.source_type,
    branch: installAction.branch,
    skipPrompt: options.yes,
    onSelectSkills: async (skills, existingSkills) => {
      const available = skills.filter((skill) => !existingSkills.has(skill.name));
      selectionState.discovered = skills.map((skill) => skill.name);
      selectionState.existing = new Set(existingSkills);

      if (available.length === 0) {
        selectionState.selected = [];
        return [];
      }

      const resolution = resolveItem(resolutions, 'skill-selection');
      if (resolution) {
        const selected = parseSelectionResolution(resolution, available.map((skill) => skill.name));
        if (!selected) {
          throw new Error('E_UNRESOLVED: resolution for skill-selection must include selected[] or all=true');
        }

        selectionState.selected = selected.filter((skill) => available.some((candidate) => candidate.name === skill));
        return selectionState.selected;
      }

      if (options.yes) {
        selectionState.selected = available.map((skill) => skill.name);
        return selectionState.selected;
      }

      if (options.applyMode) {
        throw new Error('E_UNRESOLVED: install plan contains execute-phase skill-selection; provide --resolutions when using --apply');
      }

      if (!options.selectSkills) {
        throw new Error('E_NEEDS_INPUT: This command requires interactive input');
      }

      selectionState.selected = await options.selectSkills(skills, existingSkills);
      return selectionState.selected;
    }
  });

  const availableDiscovered = selectionState.discovered.filter((skill) => !selectionState.existing.has(skill));
  const ignoredSkills = availableDiscovered.filter((skill) => !selectionState.selected.includes(skill));
  const alreadyInstalledSkills = result.alreadyInstalledSkills.length > 0
    ? result.alreadyInstalledSkills
    : selectionState.discovered.filter((skill) => selectionState.existing.has(skill));
  const config = await loadConfig(homeDir);
  const sourceRecord = config.sources[result.sourceName] as Record<string, unknown> | undefined;
  const finalSource = sourceRecord
    ? {
        name: result.sourceName,
        type: (sourceRecord.type as SourceDefinition['type']) ?? installAction.source_type,
        url: (typeof sourceRecord.url === 'string' ? sourceRecord.url : installAction.url),
        path: (typeof sourceRecord.path === 'string' ? sourceRecord.path : installAction.path),
        ...(typeof sourceRecord.branch === 'string' ? { branch: sourceRecord.branch } : installAction.branch ? { branch: installAction.branch } : {}),
        ...(typeof sourceRecord.archive_path === 'string' ? { archive_path: sourceRecord.archive_path } : installAction.archive_path ? { archive_path: installAction.archive_path } : {}),
      }
    : {
        name: installAction.name,
        type: installAction.source_type,
        url: installAction.url,
        path: installAction.path,
        ...(installAction.branch ? { branch: installAction.branch } : {}),
        ...(installAction.archive_path ? { archive_path: installAction.archive_path } : {}),
      };

  return {
    ...result,
    source: finalSource,
    ignoredSkills,
    alreadyInstalledSkills,
    installActionId: installAction.id,
    linkActionId: typeof linkAction?.id === 'string' ? linkAction.id : undefined,
  };
}

/**
 * Install skills from a URL or local path via the unified install flow.
 */
export async function installFromSource(
  homeDir: string,
  urlOrPath: string,
  options: InstallFromSourceOptions = {}
): Promise<InstallFromSourceResult> {
  const config = await loadConfig(homeDir);
  const existingSkills = new Set(await discoverAllSkills(homeDir, config));

  const result = await addSourceFromUrl(homeDir, urlOrPath, {
    name: options.name,
    path: options.path,
    skillSubdir: options.skillSubdir,
    type: options.type,
    branch: options.branch,
    skipPrompt: options.skipPrompt,
    onSelectSkills: options.onSelectSkills
  });

  const { installedSkills, alreadyInstalledSkills } = await resolveInstalledSkills(homeDir, result, urlOrPath, existingSkills, options);
  const { linkedAgents, linkStatuses } = await linkInstalledSkills(homeDir, installedSkills);

  return {
    sourceName: result.name,
    installedSkills,
    alreadyInstalledSkills,
    linkedAgents,
    linkStatuses,
  };
}
