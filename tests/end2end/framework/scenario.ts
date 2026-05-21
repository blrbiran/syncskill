// tests/end2end/framework/scenario.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManagedTempDir } from './cleanup.js';
import { E2EContext } from './context.js';
import {
  type ArchiveConfig,
  type GitSourceConfig,
  type MockServerConfig,
  createArchive,
  createGitSourceFixture,
  createMockServer,
  createSkillDir,
} from './fixtures/index.js';
import { getProjectRoot, runSyncskill } from './runner.js';

/**
 * Agent name to skills directory path mapping.
 * Paths are relative to homeDir.
 */
const AGENT_SKILLS_PATHS: Record<string, string> = {
  claude: '.claude/skills',
  agents: '.agents/skills',
  cursor: '.cursor/skills',
  windsurf: '.windsurf/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  kiro: '.kiro/skills',
  augment: '.augment/skills',
  amp: '.config/agents/skills',
  cline: '.cline/skills',
  opencode: '.config/opencode/skills',
  qwen: '.qwen/skills',
  openclaw: '.openclaw/skills',
  hermes: '.hermes/skills',
  qoder: '.qoder/skills',
  aone_copilot: '.aone_copilot/skills',
};

interface SkillConfig {
  name: string;
  content?: string;
}

interface GitSourceEntry {
  name: string;
  config: GitSourceConfig;
}

interface ArchiveEntry {
  name: string;
  config: ArchiveConfig;
}

interface InitOptions {
  skipScan?: boolean;
  skipSkill?: boolean;
}

/**
 * Builder for setting up E2E test environments.
 * Provides a fluent API for declaring test fixtures.
 */
export class E2EScenario {
  private agents: string[] = [];
  private skills: SkillConfig[] = [];
  private gitSources: GitSourceEntry[] = [];
  private archives: ArchiveEntry[] = [];
  private mockServers: MockServerConfig[] = [];
  private configOverrides: Record<string, unknown> = {};
  private linksConfig: Record<string, string[]> = {};
  private initOptions: InitOptions | null = null;
  private envVars: Record<string, string> = {};
  private needsNetwork = false;

  /**
   * Add a single agent.
   */
  withAgent(name: string): this {
    if (!this.agents.includes(name)) {
      this.agents.push(name);
    }
    return this;
  }

  /**
   * Add multiple agents.
   */
  withAgents(...names: string[]): this {
    for (const name of names) {
      this.withAgent(name);
    }
    return this;
  }

  /**
   * Add a skill to .syncskill/skills/.
   */
  withSkill(name: string, content?: string): this {
    this.skills.push({ name, content });
    return this;
  }

  /**
   * Add multiple skills.
   */
  withSkills(names: string[]): this {
    for (const name of names) {
      this.withSkill(name);
    }
    return this;
  }

  /**
   * Create a git repository as a source.
   */
  withGitSource(name: string, config: GitSourceConfig): this {
    this.gitSources.push({ name, config });
    return this;
  }

  /**
   * Create an archive file.
   */
  withArchive(name: string, config: ArchiveConfig): this {
    this.archives.push({ name, config });
    return this;
  }

  /**
   * Create a mock server.
   */
  withMockServer(config: MockServerConfig): this {
    this.mockServers.push(config);
    return this;
  }

  /**
   * Create multiple mock servers.
   */
  withMockServers(configs: MockServerConfig[]): this {
    for (const config of configs) {
      this.withMockServer(config);
    }
    return this;
  }

  /**
   * Override config.json values.
   */
  withConfig(partial: Record<string, unknown>): this {
    Object.assign(this.configOverrides, partial);
    return this;
  }

  /**
   * Set links configuration.
   */
  withLinks(links: Record<string, string[]>): this {
    Object.assign(this.linksConfig, links);
    return this;
  }

  /**
   * Run syncskill init after setup.
   */
  withInit(options?: InitOptions): this {
    this.initOptions = options ?? {};
    return this;
  }

  /**
   * Mark test as requiring network access.
   */
  requiresNetwork(): this {
    this.needsNetwork = true;
    return this;
  }

  /**
   * Set environment variables for the test.
   */
  withEnv(env: Record<string, string>): this {
    Object.assign(this.envVars, env);
    return this;
  }

  /**
   * Execute setup and return context.
   */
  async setup(): Promise<E2EContext> {
    const projectRoot = getProjectRoot();

    // Step 1: Create temp directory
    const homeDir = await createManagedTempDir();

    // Step 2: Create E2EContext
    const ctx = new E2EContext(homeDir, projectRoot);

    // Step 3: Create agent directories
    for (const agent of this.agents) {
      const agentPath = this.getAgentPath(homeDir, agent);
      await mkdir(agentPath, { recursive: true });
    }

    // Step 4: Create .syncskill/skills/ directory
    const skillsDir = join(homeDir, '.syncskill', 'skills');
    await mkdir(skillsDir, { recursive: true });

    // Step 5: Create skills
    for (const skill of this.skills) {
      await createSkillDir(skillsDir, skill.name, skill.content);
    }

    // Step 6: Create git sources
    const fixturesDir = join(homeDir, '.e2e-fixtures');
    if (this.gitSources.length > 0 || this.archives.length > 0 || this.mockServers.length > 0) {
      await mkdir(fixturesDir, { recursive: true });
    }

    for (const entry of this.gitSources) {
      const fixture = await createGitSourceFixture(fixturesDir, entry.name, entry.config);
      ctx.registerGitSource(entry.name, fixture);
    }

    // Step 7: Create archives
    for (const entry of this.archives) {
      const archivePath = await createArchive(fixturesDir, entry.name, entry.config);
      ctx.registerArchive(entry.name, archivePath);
    }

    // Step 8: Create mock servers
    for (const config of this.mockServers) {
      const server = await createMockServer(fixturesDir, config);
      ctx.registerMockServer(config.name, server);
    }

    // Step 9: Run syncskill init if requested
    if (this.initOptions !== null) {
      const initArgs = ['init', '-y'];
      if (this.initOptions.skipScan) {
        initArgs.push('--skip-scan');
      }
      if (this.initOptions.skipSkill) {
        initArgs.push('--skip-skill');
      }
      await runSyncskill(homeDir, projectRoot, initArgs, { env: this.envVars });
    }

    // Step 10: Apply config overrides and links
    if (Object.keys(this.configOverrides).length > 0 || Object.keys(this.linksConfig).length > 0) {
      const configPath = join(homeDir, '.syncskill', 'config.json');
      let config: Record<string, unknown> = {};

      // Try to read existing config if init was run
      if (this.initOptions !== null) {
        try {
          const existingContent = await ctx.readFile('.syncskill/config.json');
          config = JSON.parse(existingContent) as Record<string, unknown>;
        } catch {
          // Config doesn't exist yet, start fresh
        }
      }

      // Apply overrides
      Object.assign(config, this.configOverrides);

      // Apply links
      if (Object.keys(this.linksConfig).length > 0) {
        config.links = { ...(config.links as Record<string, string[]> | undefined), ...this.linksConfig };
      }

      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    return ctx;
  }

  /**
   * Get the skills directory path for an agent.
   */
  private getAgentPath(homeDir: string, agent: string): string {
    const relativePath = AGENT_SKILLS_PATHS[agent];
    if (!relativePath) {
      throw new Error(`Unknown agent: ${agent}`);
    }
    return join(homeDir, relativePath);
  }
}
