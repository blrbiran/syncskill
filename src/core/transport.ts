import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { type ConfiguredServer } from '../config/config.js';
import { createEmptyManifest, rebuildRemoteManifestFromHashes, type ServerManifest } from './manifest.js';

export interface ServerProbeResult {
  check: string;
  ok: boolean;
  detail: string;
}

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

interface RsyncOptions {
  delete?: boolean;
}

function buildRsyncArgs(server: ConfiguredServer, source: string, destination: string, options: RsyncOptions = {}): string[] {
  const sshParts = [
    'ssh',
    ...(typeof server.port === 'number' ? ['-p', String(server.port)] : []),
    ...(typeof server.identity_file === 'string' ? ['-i', server.identity_file] : [])
  ];

  return [
    '-az',
    ...(options.delete ? ['--delete'] : []),
    '-e',
    sshParts.join(' '),
    source,
    destination
  ];
}

export async function refreshRemoteManifestFromServer(
  server: ConfiguredServer,
  runtime: TransportRuntime,
  currentManifest: ServerManifest,
  updatedAt: string
): Promise<ServerManifest> {
  await deployReceiver(server, runtime);
  const remoteManifest = await fetchRemoteManifest(server, runtime);
  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'scan-skills']));
  const parsed = JSON.parse(result.stdout || '{}') as {
    remote_hashes?: Record<string, string>;
  };
  const skillNames = [...new Set([...Object.keys(currentManifest.skills), ...Object.keys(remoteManifest.skills)])].sort();

  const corrected = rebuildRemoteManifestFromHashes(
    {
      ...createEmptyManifest(server.name),
      ...remoteManifest,
      server: server.name,
      skills: Object.fromEntries(
        skillNames.map((skill) => {
          const localState = currentManifest.skills[skill];
          const remoteState = remoteManifest.skills[skill];

          return [
            skill,
            {
              local_hash: localState?.local_hash ?? null,
              remote_hash: remoteState?.remote_hash ?? localState?.remote_hash ?? null,
              recorded_hash: remoteState?.recorded_hash ?? localState?.recorded_hash ?? null,
              direction: remoteState?.direction ?? localState?.direction ?? 'skip',
              status: remoteState?.status ?? localState?.status ?? 'in-sync'
            }
          ];
        })
      )
    },
    parsed.remote_hashes ?? {},
    updatedAt
  );

  await pushManifest(server, corrected, runtime);
  return corrected;
}

export async function probeServerAccess(
  server: ConfiguredServer,
  runtime: TransportRuntime = createTransportRuntime()
): Promise<ServerProbeResult[]> {
  try {
    await runtime.exec('ssh', buildSshArgs(server, ['true']));
  } catch (error) {
    return [
      {
        check: 'transport',
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }

  try {
    await deployReceiver(server, runtime);
  } catch (error) {
    return [
      { check: 'transport', ok: true, detail: 'ssh ok' },
      {
        check: 'receiver',
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }

  try {
    await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'manifest']));
  } catch (error) {
    return [
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      {
        check: 'manifest',
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }

  try {
    const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'probe-access']));
    const parsed = JSON.parse(result.stdout || '{}') as { checks?: ServerProbeResult[] };

    return [
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      ...(parsed.checks ?? [])
    ];
  } catch (error) {
    return [
      { check: 'transport', ok: true, detail: 'ssh ok' },
      { check: 'receiver', ok: true, detail: 'receiver ok' },
      {
        check: 'probe',
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }
}

export async function receiverNeedsUpdate(server: ConfiguredServer, runtime: TransportRuntime): Promise<boolean> {
  const receiverContent = await readFile(new URL('../receiver/sync_receiver.mjs', import.meta.url), 'utf8');
  const localHash = createHash('md5').update(receiverContent).digest('hex');

  try {
    const result = await runtime.exec('ssh', buildSshArgs(server, ['md5sum', REMOTE_RECEIVER]));
    const remoteHash = result.stdout.split(/\s+/)[0];
    return localHash !== remoteHash;
  } catch {
    // Remote file doesn't exist or md5sum failed
    return true;
  }
}

export async function deployReceiver(server: ConfiguredServer, runtime: TransportRuntime): Promise<void> {
  const needsUpdate = await receiverNeedsUpdate(server, runtime);

  if (needsUpdate) {
    const bootstrap = await readFile(new URL('../receiver/bootstrap_remote.sh', import.meta.url), 'utf8');
    const receiver = await readFile(new URL('../receiver/sync_receiver.mjs', import.meta.url), 'utf8');

    await runtime.exec('ssh', buildSshArgs(server, ['sh', '-s']), { stdin: bootstrap });
    await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_RECEIVER}`]), { stdin: receiver });
  }

  // Always push config (remote_agents may change)
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
      buildRsyncArgs(server, `${sourceDir}/`, `${buildSshTarget(server)}:${REMOTE_SKILLS_DIR}/${skill}/`, { delete: true }),
      {}
    );
    return;
  } catch (error) {
    if (!shouldFallbackFromRsync(error)) {
      throw error;
    }

    await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'import-skill', skill]), {
      stdin: JSON.stringify(await collectSkillData(sourceDir))
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

function validateSymlinkTarget(targetDir: string, linkPath: string, target: string): void {
  if (isAbsolute(target)) {
    throw new Error(`Refusing to create symlink with absolute target: ${target}`);
  }
  const linkDir = dirname(resolve(targetDir, linkPath));
  const resolvedTarget = resolve(linkDir, target);
  if (isOutsideDirectory(targetDir, resolvedTarget)) {
    throw new Error(`Refusing to create symlink that escapes skill directory: ${target}`);
  }
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
    const data = JSON.parse(exported.stdout || '{}') as SkillData | Record<string, string>;

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    // Handle both new format (with files/symlinks) and legacy format (just files)
    const files = 'files' in data ? data.files : data;
    const symlinks = 'symlinks' in data ? data.symlinks : {};

    for (const [relativePath, base64] of Object.entries(files)) {
      const destination = resolveSkillDestination(targetDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(base64, 'base64'));
    }

    for (const [relativePath, target] of Object.entries(symlinks)) {
      const destination = resolveSkillDestination(targetDir, relativePath);
      validateSymlinkTarget(targetDir, relativePath, target);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(target, destination);
    }
  }
}

interface SkillData {
  files: Record<string, string>;
  symlinks: Record<string, string>;
}

async function collectSkillData(skillDir: string, currentDir = skillDir): Promise<SkillData> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: Record<string, string> = {};
  const symlinks: Record<string, string> = {};

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = relative(skillDir, fullPath).replaceAll('\\', '/');

    if (entry.isSymbolicLink()) {
      const target = await readlink(fullPath);
      symlinks[relativePath] = target;
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await collectSkillData(skillDir, fullPath);
      Object.assign(files, nested.files);
      Object.assign(symlinks, nested.symlinks);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files[relativePath] = (await readFile(fullPath)).toString('base64');
  }

  return { files, symlinks };
}
