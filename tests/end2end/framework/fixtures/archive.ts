// tests/end2end/framework/fixtures/archive.ts
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as compressing from 'compressing';

import { createMultipleSkills } from './skill.js';

export interface ArchiveConfig {
  skills: string[];
  format?: 'zip' | 'tar.gz';
  skillContents?: Record<string, string>;
}

/**
 * Create an archive file containing skills.
 * Skills are placed at the root of the archive (no wrapper directory).
 */
export async function createArchive(
  parentDir: string,
  name: string,
  config: ArchiveConfig
): Promise<string> {
  const format = config.format ?? 'zip';
  const archivePath = join(parentDir, name);

  // Create temp directory for skills
  const contentDir = join(parentDir, `${name}-content`);
  await mkdir(contentDir, { recursive: true });

  // Create skills
  await createMultipleSkills(contentDir, config.skills, config.skillContents);

  // Create archive using Stream API to place skills at root level
  const stream =
    format === 'zip'
      ? new compressing.zip.Stream()
      : new compressing.tgz.Stream();

  // Add each skill directory with empty relativePath to place at root
  const entries = await readdir(contentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      stream.addEntry(join(contentDir, entry.name), { relativePath: '' });
    }
  }

  // Write stream to file
  const destStream = createWriteStream(archivePath);
  await new Promise<void>((resolve, reject) => {
    stream.pipe(destStream);
    destStream.on('finish', resolve);
    destStream.on('error', reject);
  });

  // Cleanup temp content dir
  await rm(contentDir, { recursive: true, force: true });

  return archivePath;
}
