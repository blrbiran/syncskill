import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
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

async function syncSource(
  homeDir: string,
  name: string,
  source: SourceDefinition,
  updatedAt: string
): Promise<SourceState> {
  const materializedRoot = await prepareMaterializedRoot(homeDir, name, source);
  const previousState = await loadSourceState(homeDir, name);
  const { skillsDir } = getSyncPaths(homeDir);
  const materializedSkills = await listSkillDirectories(materializedRoot);

  const previousSkills = previousState?.materialized_skills ?? [];

  await mkdir(skillsDir, { recursive: true });
  await assertMaterializationTargetsAvailable(skillsDir, materializedRoot, previousSkills, materializedSkills, source.type);
  await removeStaleSkills(skillsDir, materializedRoot, previousSkills, materializedSkills, source.type);

  for (const skill of materializedSkills) {
    const sourceDir = join(materializedRoot, skill);
    const targetDir = join(skillsDir, skill);

    if (source.type === 'local') {
      await recreateSymlink(sourceDir, targetDir);
    } else if (source.type === 'git') {
      await copySkillDirectory(sourceDir, targetDir);
    } else {
      throw new Error(`Source type not implemented: ${source.type}`);
    }
  }

  const nextState: SourceState = {
    materialized_skills: materializedSkills,
    updated_at: updatedAt
  };

  await saveSourceState(homeDir, name, nextState);
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

async function saveSourceState(homeDir: string, name: string, state: SourceState): Promise<void> {
  const stateFile = getSourceStateFile(homeDir, name);
  await mkdir(join(getSyncPaths(homeDir).syncDir, '.sources', name), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function prepareMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  if (source.type === 'local') {
    return getLocalMaterializedRoot(source);
  }

  if (source.type === 'git') {
    return prepareGitMaterializedRoot(homeDir, name, source);
  }

  throw new Error(`Source type not implemented: ${source.type}`);
}

async function prepareGitMaterializedRoot(homeDir: string, name: string, source: SourceDefinition): Promise<string> {
  const checkoutDir = getGitCheckoutDir(homeDir, name);

  if (!(await pathExists(checkoutDir))) {
    await mkdir(dirname(checkoutDir), { recursive: true });
    await runGit(['clone', source.url, checkoutDir]);
  }

  await runGit(['-C', checkoutDir, 'fetch', '--tags', 'origin', source.ref ?? 'HEAD']);
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
  sourceType: SourceType
): Promise<void> {
  for (const staleSkill of previousSkills.filter((skill) => !nextSkills.includes(skill))) {
    const targetDir = join(skillsDir, staleSkill);

    if (sourceType === 'git') {
      if (!(await pathExists(targetDir))) {
        continue;
      }

      if (await isSymbolicLink(targetDir)) {
        continue;
      }

      await rm(targetDir, { recursive: true, force: true });
      continue;
    }

    const expectedTarget = join(materializedRoot, staleSkill);
    const currentTarget = await readlinkIfMatches(targetDir);

    if (currentTarget !== expectedTarget) {
      continue;
    }

    await rm(targetDir, { recursive: true, force: true });
  }
}

async function copySkillDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
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
  sourceType: SourceType
): Promise<void> {
  for (const skillName of skillNames) {
    const targetDir = join(skillsDir, skillName);
    const expectedTarget = join(materializedRoot, skillName);
    const currentTarget = await readlinkIfMatches(targetDir);

    if (currentTarget === expectedTarget) {
      continue;
    }

    if (sourceType === 'git' && previousSkills.includes(skillName) && (await isReusableManagedGitTarget(targetDir))) {
      continue;
    }

    if (currentTarget !== null || (await pathExists(targetDir))) {
      throw new Error(`Skill path is already occupied: ${skillName}`);
    }
  }
}

async function isReusableManagedGitTarget(targetPath: string): Promise<boolean> {
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

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync('git', args);
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    throw new Error(execError.stderr?.trim() || execError.message);
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
