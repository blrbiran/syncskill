// tests/end2end/framework/fixtures/server.ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSkillDir, createMultipleSkills } from './skill.js';

export interface MockServerConfig {
  name: string;
  skills?: string[];
  agents?: Record<string, string>;
}

export interface MockServer {
  name: string;
  path: string;
  syncskillDir: string;
  skillsDir: string;
  agents: Record<string, string>;
}

/**
 * Create a mock server directory structure.
 */
export async function createMockServer(
  parentDir: string,
  config: MockServerConfig
): Promise<MockServer> {
  const serverPath = join(parentDir, `server-${config.name}`);
  const syncskillDir = join(serverPath, '.syncskill');
  const skillsDir = join(syncskillDir, 'skills');

  await mkdir(skillsDir, { recursive: true });

  // Create pre-installed skills
  if (config.skills && config.skills.length > 0) {
    await createMultipleSkills(skillsDir, config.skills);
  }

  return {
    name: config.name,
    path: serverPath,
    syncskillDir,
    skillsDir,
    agents: config.agents ?? {},
  };
}

/**
 * Modify a skill on a mock server.
 */
export async function modifyServerSkill(
  server: MockServer,
  skillName: string,
  content: string
): Promise<void> {
  const skillPath = join(server.skillsDir, skillName, 'SKILL.md');
  await writeFile(skillPath, content, 'utf8');
}

/**
 * Add a new skill to a mock server.
 */
export async function addServerSkill(
  server: MockServer,
  skillName: string,
  content?: string
): Promise<void> {
  await createSkillDir(server.skillsDir, skillName, content);
}

/**
 * Remove a skill from a mock server.
 */
export async function removeServerSkill(
  server: MockServer,
  skillName: string
): Promise<void> {
  await rm(join(server.skillsDir, skillName), { recursive: true, force: true });
}

/**
 * Read a skill from a mock server.
 */
export async function readServerSkill(
  server: MockServer,
  skillName: string
): Promise<string> {
  return readFile(join(server.skillsDir, skillName, 'SKILL.md'), 'utf8');
}
