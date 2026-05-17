import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
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
