// tests/end2end/framework/context.ts
import { access, lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { removeTempDir } from './cleanup.js';
import type { GitSourceFixture, MockServer } from './fixtures/index.js';
import { assertPathSafe } from './guard.js';
import { type RunOptions, type RunResult, runSyncskill } from './runner.js';

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

/**
 * Runtime context for E2E tests.
 * Provides file operations, command execution, and assertions
 * scoped to the test's temporary HOME directory.
 */
export class E2EContext {
  /**
   * The fake HOME directory for this test.
   */
  public readonly homeDir: string;

  /**
   * Path to .syncskill directory in homeDir.
   */
  public readonly syncskillDir: string;

  /**
   * Path to project root (for CLI execution).
   */
  private readonly projectRoot: string;

  /**
   * Registered git sources for this test.
   */
  private readonly gitSources = new Map<string, GitSourceFixture>();

  /**
   * Registered mock servers for this test.
   */
  private readonly mockServers = new Map<string, MockServer>();

  /**
   * Registered archive paths for this test.
   */
  private readonly archives = new Map<string, string>();

  constructor(homeDir: string, projectRoot: string) {
    this.homeDir = homeDir;
    this.projectRoot = projectRoot;
    this.syncskillDir = join(homeDir, '.syncskill');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Path helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build an absolute path relative to homeDir.
   */
  getPath(...segments: string[]): string {
    return join(this.homeDir, ...segments);
  }

  /**
   * Get the URL for a registered git source.
   */
  getGitSourceUrl(name: string): string {
    const source = this.gitSources.get(name);
    if (!source) {
      throw new Error(`Git source "${name}" not registered`);
    }
    return source.bareRepoUrl;
  }

  /**
   * Get the work directory for a registered git source.
   */
  getGitSourceWorkDir(name: string): string {
    const source = this.gitSources.get(name);
    if (!source) {
      throw new Error(`Git source "${name}" not registered`);
    }
    return source.workDir;
  }

  /**
   * Get the path for a registered archive.
   */
  getArchivePath(name: string): string {
    const archivePath = this.archives.get(name);
    if (!archivePath) {
      throw new Error(`Archive "${name}" not registered`);
    }
    return archivePath;
  }

  /**
   * Get the path for a registered mock server.
   */
  getMockServerPath(name: string): string {
    const server = this.mockServers.get(name);
    if (!server) {
      throw new Error(`Mock server "${name}" not registered`);
    }
    return server.path;
  }

  /**
   * Get the skills directory path for an agent.
   */
  private getAgentSkillsPath(agent: string): string {
    const relativePath = AGENT_SKILLS_PATHS[agent];
    if (!relativePath) {
      throw new Error(`Unknown agent: ${agent}`);
    }
    return join(this.homeDir, relativePath);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Registration (called by E2EScenario)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Register a git source fixture.
   */
  registerGitSource(name: string, fixture: GitSourceFixture): void {
    this.gitSources.set(name, fixture);
  }

  /**
   * Register a mock server.
   */
  registerMockServer(name: string, server: MockServer): void {
    this.mockServers.set(name, server);
  }

  /**
   * Register an archive path.
   */
  registerArchive(name: string, path: string): void {
    this.archives.set(name, path);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Command execution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run syncskill CLI with HOME override.
   * Supports two calling patterns:
   * - Variadic: ctx.run('syncskill', 'init', '-y')
   * - Array with options: ctx.run('syncskill', ['init', '-y'], { timeout: 60000 })
   */
  async run(cmd: 'syncskill', ...args: string[]): Promise<RunResult>;
  async run(cmd: 'syncskill', args: string[], options?: Omit<RunOptions, 'cwd'>): Promise<RunResult>;
  async run(
    cmd: 'syncskill',
    firstArg?: string | string[],
    ...rest: (string | Omit<RunOptions, 'cwd'> | undefined)[]
  ): Promise<RunResult> {
    // Detect which signature is being used
    if (Array.isArray(firstArg)) {
      // Array signature: run('syncskill', ['init', '-y'], { timeout: 60000 })
      const args = firstArg;
      const options = rest[0] as Omit<RunOptions, 'cwd'> | undefined;
      return runSyncskill(this.homeDir, this.projectRoot, args, options);
    } else {
      // Variadic signature: run('syncskill', 'init', '-y')
      const args = firstArg !== undefined ? [firstArg, ...(rest as string[])] : [];
      return runSyncskill(this.homeDir, this.projectRoot, args);
    }
  }

  /**
   * Run any command in the test environment.
   */
  async exec(
    cmd: string,
    args: string[],
    options?: Omit<RunOptions, 'cwd'>
  ): Promise<RunResult> {
    const { execCommand } = await import('./runner.js');
    return execCommand(cmd, args, {
      ...options,
      cwd: this.homeDir,
      env: {
        ...options?.env,
        HOME: this.homeDir,
        USERPROFILE: this.homeDir,
      },
    });
  }

  /**
   * Run syncskill CLI expecting failure.
   */
  async runExpectFail(cmd: 'syncskill', ...args: string[]): Promise<RunResult> {
    return runSyncskill(this.homeDir, this.projectRoot, args, {
      expectedExitCode: null, // Don't throw on non-zero exit
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // File operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Read a file relative to homeDir.
   */
  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    return readFile(fullPath, 'utf8');
  }

  /**
   * Write a file relative to homeDir.
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    await writeFile(fullPath, content, 'utf8');
  }

  /**
   * Check if a path exists relative to homeDir.
   */
  async exists(relativePath: string): Promise<boolean> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    try {
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a symlink target relative to homeDir.
   */
  async readlink(relativePath: string): Promise<string> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    return readlink(fullPath);
  }

  /**
   * Read directory contents relative to homeDir.
   */
  async readdir(relativePath: string): Promise<string[]> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    return readdir(fullPath);
  }

  /**
   * Read and parse config.yaml.
   */
  async readConfig(): Promise<unknown> {
    const content = await this.readFile('.syncskill/config.yaml');
    return parseYaml(content);
  }

  /**
   * Read and parse skills-registry.json.
   */
  async readRegistry(): Promise<unknown> {
    const content = await this.readFile('.syncskill/skills-registry.json');
    return JSON.parse(content);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Assertions
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Assert that a file exists.
   */
  async assertFileExists(relativePath: string): Promise<void> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    try {
      await access(fullPath);
    } catch {
      throw new Error(`Expected file to exist: ${relativePath}`);
    }
  }

  /**
   * Assert that a file does not exist.
   */
  async assertFileNotExists(relativePath: string): Promise<void> {
    const fullPath = this.getPath(relativePath);
    assertPathSafe(fullPath);
    try {
      await access(fullPath);
      throw new Error(`Expected file to not exist: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // File doesn't exist, as expected
      }
      throw error; // Re-throw if it's a different error
    }
  }

  /**
   * Assert that a file contains a substring.
   */
  async assertFileContains(relativePath: string, substring: string): Promise<void> {
    const content = await this.readFile(relativePath);
    if (!content.includes(substring)) {
      throw new Error(
        `Expected file "${relativePath}" to contain "${substring}"\n` +
          `Actual content:\n${content}`
      );
    }
  }

  /**
   * Assert that a skill is linked to the specified agents.
   */
  async assertLinked(skill: string, agents: string[]): Promise<void> {
    for (const agent of agents) {
      const agentSkillsPath = this.getAgentSkillsPath(agent);
      const skillLinkPath = join(agentSkillsPath, skill);

      try {
        const stats = await lstat(skillLinkPath);
        if (!stats.isSymbolicLink() && !stats.isDirectory()) {
          throw new Error(
            `Expected "${skill}" to be linked in agent "${agent}", ` +
              `but it exists as a file, not a symlink or directory`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Expected "${skill}" to be linked in agent "${agent}", ` +
              `but the path does not exist: ${skillLinkPath}`
          );
        }
        throw error;
      }
    }
  }

  /**
   * Assert that a skill is NOT linked to the specified agents.
   */
  async assertNotLinked(skill: string, agents: string[]): Promise<void> {
    for (const agent of agents) {
      const agentSkillsPath = this.getAgentSkillsPath(agent);
      const skillLinkPath = join(agentSkillsPath, skill);

      try {
        await access(skillLinkPath);
        throw new Error(
          `Expected "${skill}" to NOT be linked in agent "${agent}", ` +
            `but it exists at: ${skillLinkPath}`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue; // Doesn't exist, as expected
        }
        throw error;
      }
    }
  }

  /**
   * Assert that a skill link is a symlink.
   */
  async assertIsSymlink(skill: string, agent: string): Promise<void> {
    const agentSkillsPath = this.getAgentSkillsPath(agent);
    const skillLinkPath = join(agentSkillsPath, skill);

    const stats = await lstat(skillLinkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(
        `Expected "${skill}" in agent "${agent}" to be a symlink, ` +
          `but it is not`
      );
    }
  }

  /**
   * Assert that a skill link is a real directory (not a symlink).
   */
  async assertIsRealDir(skill: string, agent: string): Promise<void> {
    const agentSkillsPath = this.getAgentSkillsPath(agent);
    const skillLinkPath = join(agentSkillsPath, skill);

    const stats = await lstat(skillLinkPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Expected "${skill}" in agent "${agent}" to be a real directory, ` +
          `but it is a symlink`
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Expected "${skill}" in agent "${agent}" to be a directory, ` +
          `but it is a file`
      );
    }
  }

  /**
   * Assert that a source exists in the config.
   */
  async assertSourceExists(name: string): Promise<void> {
    const config = (await this.readConfig()) as { sources?: Array<{ name: string }> };
    const source = config.sources?.find((s) => s.name === name);
    if (!source) {
      throw new Error(
        `Expected source "${name}" to exist in config, ` +
          `but it was not found. Sources: ${JSON.stringify(config.sources)}`
      );
    }
  }

  /**
   * Assert that a skill is configured to link to specific agents.
   */
  async assertLinksConfig(skill: string, expectedAgents: string[]): Promise<void> {
    const config = (await this.readConfig()) as {
      links?: Record<string, string[]>;
    };
    const actualAgents = config.links?.[skill];

    if (!actualAgents) {
      throw new Error(
        `Expected skill "${skill}" to have link config for agents ${JSON.stringify(expectedAgents)}, ` +
          `but no link config found for this skill`
      );
    }

    const sortedExpected = [...expectedAgents].sort();
    const sortedActual = [...actualAgents].sort();

    if (JSON.stringify(sortedExpected) !== JSON.stringify(sortedActual)) {
      throw new Error(
        `Expected skill "${skill}" to be linked to ${JSON.stringify(sortedExpected)}, ` +
          `but found ${JSON.stringify(sortedActual)}`
      );
    }
  }

  /**
   * Assert that command output contains a substring.
   */
  assertOutputContains(result: RunResult, substring: string): void {
    const combined = result.stdout + result.stderr;
    if (!combined.includes(substring)) {
      throw new Error(
        `Expected output to contain "${substring}"\n` +
          `stdout: ${result.stdout}\n` +
          `stderr: ${result.stderr}`
      );
    }
  }

  /**
   * Assert that command output matches a pattern.
   */
  assertOutputMatches(result: RunResult, pattern: RegExp): void {
    const combined = result.stdout + result.stderr;
    if (!pattern.test(combined)) {
      throw new Error(
        `Expected output to match ${pattern}\n` +
          `stdout: ${result.stdout}\n` +
          `stderr: ${result.stderr}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Mock server assertions
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Assert that a mock server has a skill.
   */
  async assertServerHasSkill(serverName: string, skillName: string): Promise<void> {
    const server = this.mockServers.get(serverName);
    if (!server) {
      throw new Error(`Mock server "${serverName}" not registered`);
    }

    const skillPath = join(server.skillsDir, skillName);
    try {
      await access(skillPath);
    } catch {
      throw new Error(
        `Expected server "${serverName}" to have skill "${skillName}", ` +
          `but skill directory does not exist: ${skillPath}`
      );
    }
  }

  /**
   * Assert that a skill on a mock server has specific content.
   */
  async assertServerSkillContent(
    serverName: string,
    skillName: string,
    expectedContent: string
  ): Promise<void> {
    const server = this.mockServers.get(serverName);
    if (!server) {
      throw new Error(`Mock server "${serverName}" not registered`);
    }

    const skillMdPath = join(server.skillsDir, skillName, 'SKILL.md');
    const content = await readFile(skillMdPath, 'utf8');

    if (content !== expectedContent) {
      throw new Error(
        `Expected skill "${skillName}" on server "${serverName}" to have content:\n` +
          `${expectedContent}\n\n` +
          `But found:\n${content}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Remove the temp directory and clean up resources.
   */
  async cleanup(): Promise<void> {
    await removeTempDir(this.homeDir);
  }

  /**
   * Print diagnostic information (useful for debugging test failures).
   */
  dumpDiagnostics(): void {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('E2E CONTEXT DIAGNOSTICS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`homeDir: ${this.homeDir}`);
    console.log(`syncskillDir: ${this.syncskillDir}`);
    console.log(`projectRoot: ${this.projectRoot}`);
    console.log(`\nRegistered git sources: ${this.gitSources.size}`);
    for (const [name, fixture] of this.gitSources) {
      console.log(`  - ${name}: ${fixture.bareRepoUrl}`);
    }
    console.log(`\nRegistered mock servers: ${this.mockServers.size}`);
    for (const [name, server] of this.mockServers) {
      console.log(`  - ${name}: ${server.path}`);
    }
    console.log(`\nRegistered archives: ${this.archives.size}`);
    for (const [name, path] of this.archives) {
      console.log(`  - ${name}: ${path}`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');
  }
}
