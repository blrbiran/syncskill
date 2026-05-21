import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncSkillConfig } from '../config/config.js';
import { hashSkillDirectory } from './manifest.js';
import type { SkillsRegistryV2, IgnoredSkillEntry } from './skills-registry.js';

export async function rebuildRegistryV2(
  homeDir: string,
  config: SyncSkillConfig,
  preserveIgnored?: Record<string, IgnoredSkillEntry>
): Promise<SkillsRegistryV2> {
  void homeDir;

  const registry: SkillsRegistryV2 = {
    version: 2,
    ignored: preserveIgnored ?? {},
    http_baselines: {}
  };

  for (const [sourceName, sourceRaw] of Object.entries(config.sources)) {
    const source = sourceRaw as Record<string, unknown>;
    const sourceType = source.type as string | undefined;
    const sourcePath = source.path as string | undefined;

    if (sourceType !== 'http' || !sourcePath) {
      continue;
    }

    try {
      const entries = await readdir(sourcePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || registry.ignored[entry.name]) {
          continue;
        }

        const skillPath = join(sourcePath, entry.name);
        const skillMdPath = join(skillPath, 'SKILL.md');

        try {
          await access(skillMdPath);
          const hash = await hashSkillDirectory(skillPath);
          registry.http_baselines[entry.name] = {
            hash,
            source: sourceName
          };
        } catch {
          // Skip directories that are not valid skills.
        }
      }
    } catch {
      // Skip missing or unreadable source directories.
    }
  }

  return registry;
}
