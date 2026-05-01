import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { getSyncPaths } from './config.js';

export async function listLocalSkillNames(homeDir: string): Promise<string[]> {
  const { skillsDir } = getSyncPaths(homeDir);

  await mkdir(skillsDir, { recursive: true });

  const entries = await readdir(skillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function hashSkillDirectory(skillDir: string): Promise<string> {
  const files = await collectFileEntries(skillDir);
  const hash = createHash('md5');

  for (const file of files) {
    hash.update(Buffer.from(file.relativePath, 'utf8'));
    hash.update(file.contents);
  }

  return hash.digest('hex');
}

export async function buildLocalSkillHashes(homeDir: string): Promise<Record<string, string>> {
  const { skillsDir } = getSyncPaths(homeDir);
  const skillNames = await listLocalSkillNames(homeDir);
  const entries = await Promise.all(
    skillNames.map(async (skillName) => [skillName, await hashSkillDirectory(join(skillsDir, skillName))] as const)
  );

  return Object.fromEntries(entries);
}

interface FileEntry {
  relativePath: string;
  contents: Buffer;
}

async function collectFileEntries(rootDir: string, currentDir = rootDir): Promise<FileEntry[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: FileEntry[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFileEntries(rootDir, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      const stat = await lstat(fullPath);

      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
    }

    files.push({
      relativePath: relative(rootDir, fullPath).replaceAll('\\', '/'),
      contents: await readFile(fullPath)
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
