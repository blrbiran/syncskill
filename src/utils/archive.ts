import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as compressing from 'compressing';

const execFileAsync = promisify(execFile);

export type ArchiveType = 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'zip';

export interface ArchiveFormat {
  type: ArchiveType;
  extension: string;
}

export function detectArchiveFormat(url: string): ArchiveFormat {
  const urlWithoutQuery = url.split('?')[0];
  const lowerUrl = urlWithoutQuery.toLowerCase();

  if (lowerUrl.endsWith('.tar.gz') || lowerUrl.endsWith('.tgz')) {
    return { type: 'tar.gz', extension: '.tar.gz' };
  }
  if (lowerUrl.endsWith('.tar.bz2') || lowerUrl.endsWith('.tbz2')) {
    return { type: 'tar.bz2', extension: '.tar.bz2' };
  }
  if (lowerUrl.endsWith('.tar.xz') || lowerUrl.endsWith('.txz')) {
    return { type: 'tar.xz', extension: '.tar.xz' };
  }
  if (lowerUrl.endsWith('.zip')) {
    return { type: 'zip', extension: '.zip' };
  }

  return { type: 'tar.gz', extension: '.tar.gz' };
}

export function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const extendedMatch = /filename\*=(?:utf-8''|UTF-8'')([^;\s]+)/i.exec(header);
  if (extendedMatch) {
    try {
      return decodeURIComponent(extendedMatch[1]);
    } catch {
      // Fall through to regular filename
    }
  }

  const quotedMatch = /filename=["']([^"']+)["']/i.exec(header);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  const unquotedMatch = /filename=([^;\s]+)/i.exec(header);
  return unquotedMatch ? unquotedMatch[1] : null;
}

export function detectArchiveFormatFromFilename(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return { type: 'tar.gz', extension: '.tar.gz' };
  }
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    return { type: 'tar.bz2', extension: '.tar.bz2' };
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    return { type: 'tar.xz', extension: '.tar.xz' };
  }
  if (lower.endsWith('.zip')) {
    return { type: 'zip', extension: '.zip' };
  }

  return null;
}

export async function extractArchive(archiveFile: string, destinationDir: string, archiveType: ArchiveType): Promise<void> {
  switch (archiveType) {
    case 'tar.gz':
      await compressing.tgz.uncompress(archiveFile, destinationDir);
      break;
    case 'zip':
      await compressing.zip.uncompress(archiveFile, destinationDir);
      break;
    case 'tar.bz2':
    case 'tar.xz':
      await extractArchiveCli(archiveFile, destinationDir, archiveType);
      break;
  }
}

async function extractArchiveCli(archiveFile: string, destinationDir: string, archiveType: ArchiveType): Promise<void> {
  try {
    switch (archiveType) {
      case 'tar.gz':
        await execFileAsync('tar', ['-xzf', archiveFile, '-C', destinationDir]);
        break;
      case 'tar.bz2':
        await execFileAsync('tar', ['-xjf', archiveFile, '-C', destinationDir]);
        break;
      case 'tar.xz':
        await execFileAsync('tar', ['-xJf', archiveFile, '-C', destinationDir]);
        break;
      case 'zip':
        await execFileAsync('unzip', ['-q', archiveFile, '-d', destinationDir]);
        break;
    }
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    throw new Error(execError.stderr?.trim() || execError.message);
  }
}
