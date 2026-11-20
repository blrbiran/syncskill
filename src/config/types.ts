/**
 * TypeScript type definitions for syncskill configuration
 */

export interface SyncPaths {
  syncDir: string;
  configFile: string;
  skillsDir: string;
  manifestsDir: string;
  tempDir: string;
  backupsDir: string;
  historyFile: string;
}

export type ConflictResolution = 'manual' | 'keep-local' | 'keep-remote';

export interface SyncSkillConfig {
  version: number;
  conflict_resolution: ConflictResolution;
  agents: Record<string, string>;
  links: Record<string, string[]>;
  profiles: Record<string, string[]>;
  servers: Record<string, unknown>;
  sources: Record<string, unknown>;
  private_agents: string[];
  pull_backup?: boolean;
}

export interface ConfiguredServer {
  name: string;
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
  remote_repo?: string;
  /** Issue 408: the interpreter that runs the remote receiver (nvm/fnm/volta paths are not on a
   * non-login ssh PATH). */
  node_bin?: string;
  /** Issue 408: ssh ConnectTimeout; the transport calls ssh unattended (BatchMode). */
  connect_timeout_ms?: number;
  remote_agents: Record<string, string>;
}

export interface SourceConfig {
  type: 'git' | 'http' | 'local';
  url?: string;
  path: string;
  branch?: string;
  skill_subdir?: string;
  ignore?: string[];
  archive_path?: string;
}
