import { readFile } from 'node:fs/promises';
import { isNotFoundError } from '../utils/utils.js';

async function readResolutionInput(path: string): Promise<string> {
  if (path !== '-') {
    return readFile(path, 'utf8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type ResolutionValue = Record<string, unknown>;
export type Resolutions = Record<string, ResolutionValue>;

export async function loadResolutions(path: string): Promise<Resolutions> {
  try {
    const content = await readResolutionInput(path);
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
