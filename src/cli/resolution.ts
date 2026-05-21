import { readFile } from 'node:fs/promises';
import { isNotFoundError } from '../utils/utils.js';

export type ResolutionValue = Record<string, unknown>;
export type Resolutions = Record<string, ResolutionValue>;

export async function loadResolutions(path: string): Promise<Resolutions> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as Resolutions;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

export function resolveItem(resolutions: Resolutions, kind: string): ResolutionValue | undefined {
  return resolutions[kind];
}

export function hasResolution(resolutions: Resolutions, kind: string): boolean {
  return kind in resolutions;
}
