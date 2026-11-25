import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * Promisified version of child_process.execFile.
 * Common utility used across source, transport, archive, and restore modules.
 */
export const execFileAsync = promisify(execFile);

/**
 * Check if an error is a "file not found" error (ENOENT).
 */
export function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Write text to a file without ever leaving a half-written one behind: the bytes go to a sibling
 * temp file, are fsync'd, and only then rename(2) into place. The previous file is kept as `.bak`
 * so a corrupt current file still has a known-good copy to restore.
 */
export async function writeJsonAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);

  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    await handle.close();

    try {
      await copyFile(path, `${path}.bak`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Read and parse a JSON file, returning a default value if the file doesn't exist.
 */
export async function readJsonOrDefault<T>(path: string, defaultValue: T): Promise<T> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultValue;
    }
    throw error;
  }
}

/**
 * Read a file's content, returning a default value if the file doesn't exist.
 */
export async function readFileOrDefault(path: string, defaultValue: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultValue;
    }
    throw error;
  }
}

/**
 * Check if a path exists (file or directory).
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

export function resolveHomePath(targetPath: string): string {
  if (targetPath.startsWith('~/')) {
    return resolve(homedir(), targetPath.slice(2));
  }

  if (targetPath === '~') {
    return homedir();
  }

  return resolve(targetPath);
}
