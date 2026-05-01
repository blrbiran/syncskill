import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { type ConfiguredServer } from './config.js';
import { createEmptyManifest, type ServerManifest } from './manifest.js';

const execFileAsync = promisify(execFile);
const REMOTE_ROOT = '~/.syncskill';
const REMOTE_RECEIVER = `${REMOTE_ROOT}/sync_receiver.mjs`;
const REMOTE_SKILLS_DIR = `${REMOTE_ROOT}/skills`;

export interface TransportRuntime {
  calls?: Array<{ file: string; args: string[]; stdin?: string }>;
  exec(file: string, args: string[], options?: { stdin?: string }): Promise<{ stdout: string; stderr: string }>;
}

export function createTransportRuntime(): TransportRuntime {
  return {
    async exec(file, args, options = {}) {
      if (options.stdin === undefined) {
        const result = await execFileAsync(file, args, { encoding: 'utf8' });
        return {
          stdout: result.stdout,
          stderr: result.stderr
        };
      }

      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(file, args, {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }

          reject(new Error(`${file} exited with code ${code ?? 'unknown'}${stderr === '' ? '' : `: ${stderr}`}`));
        });

        child.stdin.end(options.stdin);
      });
    }
  };
}

function buildSshTarget(server: ConfiguredServer): string {
  return typeof server.user === 'string' ? `${server.user}@${server.host}` : server.host;
}

function buildSshArgs(server: ConfiguredServer, remoteArgs: string[]): string[] {
  return [
    ...(typeof server.port === 'number' ? ['-p', String(server.port)] : []),
    ...(typeof server.identity_file === 'string' ? ['-i', server.identity_file] : []),
    buildSshTarget(server),
    ...remoteArgs
  ];
}

function buildRsyncArgs(server: ConfiguredServer, source: string, destination: string): string[] {
  const sshParts = [
    'ssh',
    ...(typeof server.port === 'number' ? ['-p', String(server.port)] : []),
    ...(typeof server.identity_file === 'string' ? ['-i', server.identity_file] : [])
  ];

  return ['-az', '--delete', '-e', sshParts.join(' '), source, destination];
}

export async function deployReceiver(server: ConfiguredServer, runtime: TransportRuntime): Promise<void> {
  const bootstrap = await readFile(new URL('./receiver/bootstrap_remote.sh', import.meta.url), 'utf8');
  const receiver = await readFile(new URL('./receiver/sync_receiver.mjs', import.meta.url), 'utf8');

  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-s']), { stdin: bootstrap });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_RECEIVER}`]), { stdin: receiver });
  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_ROOT}/receiver_config.json`]), {
    stdin: `${JSON.stringify({ remote_agents: server.remote_agents }, null, 2)}\n`
  });
}

export async function fetchRemoteManifest(server: ConfiguredServer, runtime: TransportRuntime): Promise<ServerManifest> {
  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'manifest']));
  const parsed = JSON.parse(result.stdout || '{}') as Partial<ServerManifest>;

  return {
    ...createEmptyManifest(server.name),
    ...parsed,
    server: server.name
  };
}

export async function pushManifest(server: ConfiguredServer, manifest: ServerManifest, runtime: TransportRuntime): Promise<void> {
  await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'write-manifest']), {
    stdin: `${JSON.stringify(manifest, null, 2)}\n`
  });
}

export async function pushSkillDirectory(
  server: ConfiguredServer,
  sourceDir: string,
  skill: string,
  runtime: TransportRuntime
): Promise<void> {
  try {
    await runtime.exec(
      'rsync',
      buildRsyncArgs(server, `${sourceDir}/`, `${buildSshTarget(server)}:${REMOTE_SKILLS_DIR}/${skill}/`),
      {}
    );
    return;
  } catch (error) {
    if (!shouldFallbackFromRsync(error)) {
      throw error;
    }

    await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'import-skill', skill]), {
      stdin: JSON.stringify(await collectSkillFiles(sourceDir))
    });
  }
}

function shouldFallbackFromRsync(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const anyError = error as Error & { code?: string; errno?: number; cause?: unknown };
  if (anyError.code === 'ENOENT' || anyError.code === 'EACCES' || anyError.errno === -2 || anyError.errno === 13) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('enoent') || message.includes('eacces') || message.includes('not found');
}

function resolveSkillDestination(targetDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Refusing to write exported file outside target directory: ${relativePath}`);
  }

  const destination = resolve(targetDir, relativePath);
  if (isOutsideDirectory(targetDir, destination)) {
    throw new Error(`Refusing to write exported file outside target directory: ${relativePath}`);
  }

  return destination;
}

function isOutsideDirectory(baseDir: string, targetPath: string): boolean {
  const relativePath = relative(baseDir, targetPath);
  return relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\');
}

export async function pullSkillDirectory(
  server: ConfiguredServer,
  skill: string,
  targetDir: string,
  runtime: TransportRuntime
): Promise<void> {
  try {
    await mkdir(dirname(targetDir), { recursive: true });
    await runtime.exec(
      'rsync',
      buildRsyncArgs(server, `${buildSshTarget(server)}:${REMOTE_SKILLS_DIR}/${skill}/`, `${targetDir}/`),
      {}
    );
    return;
  } catch (error) {
    if (!shouldFallbackFromRsync(error)) {
      throw error;
    }

    const exported = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'export-skill', skill]), {});
    const files = JSON.parse(exported.stdout || '{}') as Record<string, string>;

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    for (const [relativePath, base64] of Object.entries(files)) {
      const destination = resolveSkillDestination(targetDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(base64, 'base64'));
    }
  }
}

async function collectSkillFiles(skillDir: string, currentDir = skillDir): Promise<Record<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, await collectSkillFiles(skillDir, fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files[relative(skillDir, fullPath).replaceAll('\\', '/')] = (await readFile(fullPath)).toString('base64');
  }

  return files;
}
