import { cp, link, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashSkillDirectory } from './core/manifest.js';
import { resolveConfiguredSkillSourceDir } from './linker.js';
import { listSources, loadSkillOwnershipState, loadSourceState } from './source.js';

export const LOCK_FILE_NAME = 'syncskill-lock.json';

export class InjectError extends Error {
  constructor(readonly code: 'E_SKILL_NOT_FOUND' | 'E_TARGET_OCCUPIED', message: string) {
    super(message);
  }
}

export interface LockSource { name: string; type: string; url: string; branch?: string }
export interface LockSkill { name: string; source: LockSource | null; resolved_commit: string | null; content_md5: string }
export interface SkillLock { schema: 'syncskill-lock-v1'; created_at: string; profile: string | null; skills: LockSkill[] }

export function normalizeSkillList(skills: string[]): string[] {
  return [...new Set(skills)].sort();
}

export function buildLock(profile: string | null, skills: LockSkill[], createdAt: string): SkillLock {
  return {
    schema: 'syncskill-lock-v1',
    created_at: createdAt,
    profile,
    skills: [...skills].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function injectSkills(
  homeDir: string,
  request: { skills: string[]; profile: string | null; target: string }
): Promise<{ target: string; lockPath: string; lock: SkillLock }> {
  const target = resolve(request.target);
  const skills = normalizeSkillList(request.skills);

  const sourceDirs = new Map<string, string>();
  for (const skill of skills) {
    try {
      sourceDirs.set(skill, await resolveConfiguredSkillSourceDir(homeDir, skill));
    } catch (error) {
      throw new InjectError('E_SKILL_NOT_FOUND', `Skill not found: ${skill} (${(error as Error).message})`);
    }
  }

  const lockPath = join(target, LOCK_FILE_NAME);
  for (const path of [...skills.map((skill) => join(target, skill)), lockPath]) {
    if (await exists(path)) {
      throw new InjectError('E_TARGET_OCCUPIED', `Target already holds ${path}`);
    }
  }

  const owners = (await loadSkillOwnershipState(homeDir)).owners;
  const sources = new Map((await listSources(homeDir)).map((source) => [source.name, source]));

  await mkdir(target, { recursive: true });
  const staging = join(target, `.syncskill-inject-${process.pid}`);
  const placed: string[] = [];
  try {
    await mkdir(staging);
    for (const skill of skills) {
      await cp(sourceDirs.get(skill)!, join(staging, skill), { recursive: true, dereference: true });
    }
    for (const skill of skills) {
      await rename(join(staging, skill), join(target, skill));
      placed.push(join(target, skill));
    }

    const entries: LockSkill[] = [];
    for (const skill of skills) {
      const ownerName = owners[skill];
      const owner = ownerName === undefined ? undefined : sources.get(ownerName);
      const state = owner === undefined ? null : await loadSourceState(homeDir, owner.name);
      entries.push({
        name: skill,
        source: owner === undefined ? null : {
          name: owner.name, type: owner.type, url: owner.url, ...(owner.branch === undefined ? {} : { branch: owner.branch })
        },
        resolved_commit: state?.resolved_commit ?? null,
        content_md5: await hashSkillDirectory(join(target, skill))
      });
    }

    const lock = buildLock(request.profile, entries, new Date().toISOString());
    const stagedLock = join(staging, LOCK_FILE_NAME);
    await writeFile(stagedLock, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    try {
      await link(stagedLock, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new InjectError('E_TARGET_OCCUPIED', `Target already holds ${lockPath}`);
      }
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
    return { target, lockPath, lock };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    for (const path of placed) await rm(path, { recursive: true, force: true });
    throw error;
  }
}
