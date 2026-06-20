// tests/end2end/framework/runner.ts
import { execFile, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Result of running a command.
 */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Options for running a command.
 */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  expectedExitCode?: number | null;
  stdin?: string;
}

/**
 * Check if verbose mode is enabled.
 */
export function isVerbose(): boolean {
  return (
    process.env.E2E_VERBOSE === '1' ||
    process.env.E2E_VERBOSE === 'true'
  );
}

/**
 * Execute a command and return the result.
 */
export async function execCommand(
  cmd: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const {
    cwd = process.cwd(),
    env = {},
    timeout = 30000,
    expectedExitCode = 0,
    stdin,
  } = options;

  const verbose = isVerbose();

  if (verbose) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`▶ ${cmd} ${args.join(' ')}`);
    console.log(`  cwd: ${cwd}`);
    console.log(`${'─'.repeat(60)}`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    if (stdin === undefined) {
      const result = await execFileAsync(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: 'pipe',
        });
        let spawnedStdout = '';
        let spawnedStderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
        }, timeout);

        child.stdout.on('data', (chunk) => {
          spawnedStdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          spawnedStderr += chunk.toString();
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({
            stdout: spawnedStdout,
            stderr: spawnedStderr,
            exitCode: code ?? 1,
          });
        });

        child.stdin.end(stdin);
      });

      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    }
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
    exitCode = execError.code ?? 1;
  }

  if (verbose) {
    if (stdout) console.log(`stdout:\n${indent(stdout)}`);
    if (stderr) console.log(`stderr:\n${indent(stderr)}`);
    console.log(`exit: ${exitCode}`);
  }

  const success = exitCode === 0;

  if (expectedExitCode !== null && exitCode !== expectedExitCode) {
    throw new Error(
      `Command failed with exit code ${exitCode}, expected ${expectedExitCode}\n` +
        `Command: ${cmd} ${args.join(' ')}\n` +
        `stdout: ${stdout}\n` +
        `stderr: ${stderr}`
    );
  }

  return { stdout, stderr, exitCode, success };
}

/**
 * Run syncskill CLI with HOME environment override.
 */
export async function runSyncskill(
  homeDir: string,
  projectRoot: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {}
): Promise<RunResult> {
  const distPath = join(projectRoot, 'dist', 'index.js');

  return execCommand('node', [distPath, ...args], {
    ...options,
    cwd: homeDir,
    env: {
      ...options.env,
      HOME: homeDir,
      USERPROFILE: homeDir, // Windows
    },
  });
}

/**
 * Get the project root directory.
 */
export function getProjectRoot(): string {
  return join(__dirname, '..', '..', '..');
}

function indent(text: string, spaces = 4): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
