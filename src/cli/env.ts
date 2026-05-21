// src/cli/env.ts

/**
 * Environment variable handling for syncskill CLI.
 * See spec §11.8 for variable definitions.
 *
 * Priority: explicit flag > env var > built-in default
 */

export interface EnvConfig {
  syncDir?: string;
  configPath?: string;
  noInteractive: boolean;
  json: boolean;
  timeout?: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  noColor: boolean;
}

export function loadEnvConfig(): EnvConfig {
  return {
    syncDir: process.env.SYNCSKILL_DIR || undefined,
    configPath: process.env.SYNCSKILL_CONFIG || undefined,
    noInteractive: process.env.SYNCSKILL_NO_INTERACTIVE === '1',
    json: process.env.SYNCSKILL_JSON === '1',
    timeout: parseTimeout(process.env.SYNCSKILL_TIMEOUT),
    logLevel: parseLogLevel(process.env.SYNCSKILL_LOG_LEVEL),
    noColor: process.env.NO_COLOR !== undefined,
  };
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseLogLevel(value: string | undefined): EnvConfig['logLevel'] {
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') {
    return value;
  }
  return 'info';
}

/**
 * Merge CLI flags with environment config.
 * CLI flags take precedence.
 */
export function mergeWithFlags(
  envConfig: EnvConfig,
  flags: Partial<EnvConfig>
): EnvConfig {
  return {
    syncDir: flags.syncDir ?? envConfig.syncDir,
    configPath: flags.configPath ?? envConfig.configPath,
    noInteractive: flags.noInteractive ?? envConfig.noInteractive,
    json: flags.json ?? envConfig.json,
    timeout: flags.timeout ?? envConfig.timeout,
    logLevel: flags.logLevel ?? envConfig.logLevel,
    noColor: flags.noColor ?? envConfig.noColor,
  };
}
