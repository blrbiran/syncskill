// tests/end2end/framework/fixtures/skill.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Default SKILL.md content template.
 */
function defaultSkillContent(name: string): string {
  return `# ${name}\n\nA test skill for E2E testing.\n`;
}

/**
 * Create a skill directory with SKILL.md.
 */
export async function createSkillDir(
  parentDir: string,
  name: string,
  content?: string
): Promise<string> {
  const skillPath = join(parentDir, name);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, 'SKILL.md'),
    content ?? defaultSkillContent(name),
    'utf8'
  );
  return skillPath;
}

/**
 * Create multiple skill directories.
 */
export async function createMultipleSkills(
  parentDir: string,
  names: string[],
  contents?: Record<string, string>
): Promise<string[]> {
  const paths: string[] = [];
  for (const name of names) {
    const path = await createSkillDir(parentDir, name, contents?.[name]);
    paths.push(path);
  }
  return paths;
}
