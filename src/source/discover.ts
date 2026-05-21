import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiscoveredSkill {
  name: string;
  path: string;
}

export async function discoverSourceSkills(sourcePath: string): Promise<DiscoveredSkill[]> {
  const skills: DiscoveredSkill[] = [];

  try {
    const entries = await readdir(sourcePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(sourcePath, entry.name);
      const skillMdPath = join(skillPath, 'SKILL.md');

      try {
        await access(skillMdPath);
        skills.push({ name: entry.name, path: skillPath });
      } catch {
        // No SKILL.md, skip
      }
    }
  } catch {
    // Path doesn't exist
  }

  return skills;
}
