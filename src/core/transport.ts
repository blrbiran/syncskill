import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { type ConfiguredServer } from '../config/config.js';
import { createEmptyManifest, rebuildRemoteManifestFromHashes, type ServerManifest } from './manifest.js';
import { execFileAsync } from '../utils/utils.js';

export interface ServerProbeResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface RemoteAgentScanEntry {
  name: string;
  path: string;
  symlinked_skills: string[];
  directory_skills: string[];
}

export interface RemoteAgentScanResult {
  discovered_agents: RemoteAgentScanEntry[];
  remote_only_skills: string[];
}

export interface ReceiverConfigPayload {
  remote_agents: Record<string, string>;
  links?: Record<string, string[]>;
}

const REMOTE_ROOT = '~/.syncskill';
const REMOTE_RECEIVER = `${REMOTE_ROOT}/sync_receiver.mjs`;
const REMOTE_SKILLS_DIR = `${REMOTE_ROOT}/skills`;

const SAFE_SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface TransportRuntime {
  calls?: Array<{ file: string; args: string[]; stdin?: string }>;
  exec(file: string, args: string[], options?: { stdin?: string }): Promise<{ stdout: string; stderr: string }>;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Timeout: ${message} exceeded ${timeoutMs / 1000}s\n` +
        `  Note: Background transfer may still be running. CLI has released, but the subprocess continues until completion or OS-level SSH timeout.`
      ));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').sort()
    : [];
}

function normalizeRemoteAgentScanEntry(value: unknown): RemoteAgentScanEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;

  if (typeof record.name !== 'string' || typeof record.path !== 'string') {
    return [];
  }

  return [{
    name: record.name,
    path: record.path,
    symlinked_skills: normalizeStringArray(record.symlinked_skills),
    directory_skills: normalizeStringArray(record.directory_skills)
  }];
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

export async function scanRemoteAgents(
  server: ConfiguredServer,
  runtime: TransportRuntime,
  options: { deploy?: boolean } = {}
): Promise<RemoteAgentScanResult> {
  if (options.deploy !== false) {
    await deployReceiver(server, runtime);
  }

  const result = await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'scan-agents']));
  const parsed = JSON.parse(result.stdout || '{}') as {
    discovered_agents?: unknown[];
    remote_only_skills?: unknown;
  };

  return {
    discovered_agents: Array.isArray(parsed.discovered_agents)
      ? parsed.discovered_agents.flatMap(normalizeRemoteAgentScanEntry).sort((left, right) => left.name.localeCompare(right.name))
      : [],
    remote_only_skills: normalizeStringArray(parsed.remote_only_skills)
  };
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

export async function deployReceiver(
  server: ConfiguredServer,
  runtime: TransportRuntime,
  receiverConfig: ReceiverConfigPayload = { remote_agents: server.remote_agents }
): Promise<void> {
  const needsUpdate = await receiverNeedsUpdate(server, runtime);

  if (needsUpdate) {
    const bootstrap = await readFile(new URL('../receiver/bootstrap_remote.sh', import.meta.url), 'utf8');
    const receiver = await readFile(new URL('../receiver/sync_receiver.mjs', import.meta.url), 'utf8');

    await runtime.exec('ssh', buildSshArgs(server, ['sh', '-s']), { stdin: bootstrap });
    await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_RECEIVER}`]), { stdin: receiver });
  }

  await runtime.exec('ssh', buildSshArgs(server, ['sh', '-lc', `cat > ${REMOTE_ROOT}/receiver_config.json`]), {
    stdin: `${JSON.stringify(receiverConfig, null, 2)}\n`
  });
}

export async function applyRemoteLinks(
  server: ConfiguredServer,
  runtime: TransportRuntime,
  receiverConfig: ReceiverConfigPayload = { remote_agents: server.remote_agents }
): Promise<void> {
  await deployReceiver(server, runtime, receiverConfig);
  await runtime.exec('ssh', buildSshArgs(server, ['node', REMOTE_RECEIVER, 'apply']));
}

export async function listRemoteSkills(server: ConfiguredServer, runtime: TransportRuntime): Promise<string[]> {
  try {
    const result = await runtime.exec('ssh', buildSshArgs(server, ['ls', REMOTE_SKILLS_DIR]));
    return result.stdout
      .trim()
      .split('\n')
      .filter(name => name.length > 0)
      .sort();
  } catch {
    // Directory doesn't exist or is empty
    return [];
  }
}

export async function deleteRemoteSkills(
  server: ConfiguredServer,
  skills: string[],
  runtime: TransportRuntime
): Promise<void> {
  if (skills.length === 0) {
    return;
  }

  for (const skill of skills) {
    if (!SAFE_SKILL_NAME.test(skill)) {
      throw new Error(`Invalid skill name: ${skill}`);
    }
  }

  const paths = skills.map(skill => `${REMOTE_SKILLS_DIR}/${skill}`);
  await runtime.exec('ssh', buildSshArgs(server, ['rm', '-rf', ...paths]));
}

export interface RemoteTakeoverAction {
  agent: string;
  path: string;
  action: 'takeover';
  remote_type: 'directory' | 'file' | 'other';
}

export interface RemoteTakeoverSkip {
  agent: string;
  path: string;
  reason: 'not present' | 'already symlink';
}

export interface RemoteTakeoverResult {
  server: string;
  skill: string;
  takeovers: RemoteTakeoverAction[];
  skipped: RemoteTakeoverSkip[];
}

export interface RemoteTakeoverOptions {
  agent?: string;
  dryRun?: boolean;
  runtime?: TransportRuntime;
}

function createTransportError(code: 'E_USAGE' | 'E_AGENT_NOT_CONFIGURED' | 'E_TAKEOVER_FAILED', message: string): Error {
  return new Error(`${code}: ${message}`);
}

function joinRemotePath(basePath: string, skill: string): string {
  return `${basePath.replace(/\/+$/, '')}/${skill}`;
}

function quoteRemotePath(path: string): string {
  const normalized = path === '~'
    ? '$HOME'
    : path.startsWith('~/')
      ? `$HOME/${path.slice(2)}`
      : path;

  return `"${normalized.replace(/[\\"`]/g, '\\$&')}"`;
}

async function inspectRemotePath(
  server: ConfiguredServer,
  remotePath: string,
  runtime: TransportRuntime
): Promise<'missing' | 'symlink' | 'directory' | 'file' | 'other'> {
  const quotedPath = quoteRemotePath(remotePath);
  const result = await runtime.exec('ssh', buildSshArgs(server, [
    'sh',
    '-lc',
    `if [ -L ${quotedPath} ]; then printf symlink; elif [ -d ${quotedPath} ]; then printf directory; elif [ -f ${quotedPath} ]; then printf file; elif [ -e ${quotedPath} ]; then printf other; else printf missing; fi`
  ]));

  const type = result.stdout.trim();
  if (type === 'missing' || type === 'symlink' || type === 'directory' || type === 'file' || type === 'other') {
    return type;
  }

  return 'other';
}

export async function takeOverRemoteSkill(
  server: ConfiguredServer,
  skill: string,
  options: RemoteTakeoverOptions = {}
): Promise<RemoteTakeoverResult> {
  if (!SAFE_SKILL_NAME.test(skill)) {
    throw createTransportError('E_USAGE', `Invalid skill name: ${skill}`);
  }

  const runtime = options.runtime ?? createTransportRuntime();
  const remoteAgents = server.remote_agents ?? {};
  if (options.agent && !(options.agent in remoteAgents)) {
    throw createTransportError('E_AGENT_NOT_CONFIGURED', `Remote agent not configured: ${options.agent}`);
  }

  const selectedAgents = options.agent
    ? [[options.agent, remoteAgents[options.agent]]]
    : Object.entries(remoteAgents).sort(([left], [right]) => left.localeCompare(right));

  if (selectedAgents.length === 0) {
    throw createTransportError('E_USAGE', `No remote agents configured for ${server.name}`);
  }

  try {
    const remoteSkillType = await inspectRemotePath(server, `${REMOTE_SKILLS_DIR}/${skill}`, runtime);
    if (remoteSkillType === 'missing') {
      throw createTransportError('E_USAGE', `Remote skill not found: ${skill}. Push it first: \`syncskill push ${server.name}\``);
    }

    const result: RemoteTakeoverResult = {
      server: server.name,
      skill,
      takeovers: [],
      skipped: []
    };

    for (const [agent, agentPath] of selectedAgents) {
      const remotePath = joinRemotePath(agentPath, skill);
      const remoteType = await inspectRemotePath(server, remotePath, runtime);

      if (remoteType === 'missing') {
        result.skipped.push({ agent, path: remotePath, reason: 'not present' });
        continue;
      }

      if (remoteType === 'symlink') {
        result.skipped.push({ agent, path: remotePath, reason: 'already symlink' });
        continue;
      }

      result.takeovers.push({
        agent,
        path: remotePath,
        action: 'takeover',
        remote_type: remoteType
      });

      if (options.dryRun) {
        continue;
      }

      await runtime.exec('ssh', buildSshArgs(server, [
        'sh',
        '-lc',
        `rm -rf ${quoteRemotePath(remotePath)} && ln -s ${quoteRemotePath(`${REMOTE_SKILLS_DIR}/${skill}`)} ${quoteRemotePath(remotePath)}`
      ]));
    }

    return result;
  } catch (error) {
    if (error instanceof Error && /^E_[A-Z_]+:/.test(error.message)) {
      throw error;
    }

    throw createTransportError(
      'E_TAKEOVER_FAILED',
      `Failed to take over ${skill} on ${server.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
