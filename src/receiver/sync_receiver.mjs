#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The receiver is always deployed at `<remote_repo>/sync_receiver.mjs`, so its own location is the
// root that is actually in use. Issue #422: hardcoding `$HOME/.syncskill` made a non-default
// `remote_repo` write skills to one tree and read a manifest/config from another.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const syncRoot = process.env.SYNCSKILL_ROOT ? resolve(process.env.SYNCSKILL_ROOT) : scriptDir;
const skillsDir = join(syncRoot, 'skills');
const manifestFile = join(syncRoot, 'manifest.json');
const configFile = join(syncRoot, 'receiver_config.json');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function readStdin() {
  let stdin = '';

  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

  return stdin;
}

async function collectFileEntries(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFileEntries(rootDir, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      relativePath: relative(rootDir, fullPath).replaceAll('\\', '/'),
      contents: await readFile(fullPath)
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectSkillData(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  const symlinks = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, fullPath).replaceAll('\\', '/');

    if (entry.isSymbolicLink()) {
      const target = await readlink(fullPath);
      symlinks.push({ relativePath, target });
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await collectSkillData(rootDir, fullPath);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      relativePath,
      contents: await readFile(fullPath)
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  symlinks.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return { files, symlinks };
}

async function hashSkillDirectory(skillDir) {
  const hash = createHash('md5');

  for (const file of await collectFileEntries(skillDir)) {
    hash.update(Buffer.from(file.relativePath, 'utf8'));
    hash.update(file.contents);
  }

  return hash.digest('hex');
}

async function readManifest() {
  return readJson(manifestFile, {
    version: 1,
    server: 'remote',
    updated_at: new Date().toISOString(),
    skills: {}
  });
}

async function writeManifestFromStdin() {
  const manifest = JSON.parse(await readStdin());
  await mkdir(syncRoot, { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function validateRelativePath(basePath, relativePath) {
  if (isAbsolute(relativePath)) {
    throw new Error(`Invalid skill entry: ${relativePath}`);
  }

  const destination = resolve(basePath, relativePath);
  const relativeDestination = relative(basePath, destination);

  if (relativeDestination === '..' || relativeDestination.startsWith('../') || relativeDestination.startsWith('..\\')) {
    throw new Error(`Invalid skill entry: ${relativePath}`);
  }

  return destination;
}

function validateSymlinkTarget(targetDir, linkPath, target) {
  if (isAbsolute(target)) {
    throw new Error(`Invalid symlink target (absolute path): ${target}`);
  }
  const linkDir = dirname(resolve(targetDir, linkPath));
  const resolvedTarget = resolve(linkDir, target);
  const relativeResolved = relative(targetDir, resolvedTarget);
  if (relativeResolved === '..' || relativeResolved.startsWith('../') || relativeResolved.startsWith('..\\')) {
    throw new Error(`Invalid symlink target (escapes skill directory): ${target}`);
  }
}

// Issue #425: a push used to rsync straight into the live skill directory. An interrupted transfer left a half tree,
// and the next status/pull read it as the remote truth. Both write paths now build a sibling staging directory and swap
// it in with rename(2); a rejected or interrupted build leaves the old tree untouched.
function freshSibling(name, kind) {
  return join(skillsDir, `.${name}.${kind}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);
}

async function swapSkillDirectory(name, preparedDir) {
  const targetDir = join(skillsDir, name);
  const backupDir = freshSibling(name, 'backup');
  let hadTarget = false;
  try {
    await rename(targetDir, backupDir);
    hadTarget = true;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  try {
    await rename(preparedDir, targetDir);
  } catch (error) {
    if (hadTarget) await rename(backupDir, targetDir).catch(() => {});
    throw error;
  }

  if (hadTarget) await rm(backupDir, { recursive: true, force: true });
}

async function importSkill(name) {
  const data = JSON.parse(await readStdin());
  const stagingDir = freshSibling(name, 'staging');

  await mkdir(skillsDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  // Handle both new format (with files/symlinks) and legacy format (just files)
  const files = data.files ?? data;
  const symlinks = data.symlinks ?? {};

  try {
    for (const [relativePath, base64] of Object.entries(files)) {
      const destination = validateRelativePath(stagingDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(base64, 'base64'));
    }

    for (const [relativePath, target] of Object.entries(symlinks)) {
      const destination = validateRelativePath(stagingDir, relativePath);
      validateSymlinkTarget(stagingDir, relativePath, target);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(target, destination);
    }

    await swapSkillDirectory(name, stagingDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

// rsync performs the transfer itself, so it stages on the remote and asks the receiver to promote that directory.
async function promoteSkill(name, stagingPath) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
  const stagingDir = resolve(stagingPath);
  const skillsRoot = resolve(skillsDir);
  if (dirname(stagingDir) !== skillsRoot || !stagingDir.startsWith(join(skillsRoot, `.${name}.staging-`))) {
    throw new Error(`Invalid staging directory for ${name}: ${stagingPath}`);
  }
  const info = await lstat(stagingDir);
  if (!info.isDirectory()) throw new Error(`Staging directory is not a directory: ${stagingPath}`);
  await swapSkillDirectory(name, stagingDir);
}

async function exportSkill(name) {
  const targetDir = join(skillsDir, name);
  const data = await collectSkillData(targetDir);

  const files = {};
  for (const entry of data.files) {
    files[entry.relativePath] = entry.contents.toString('base64');
  }

  const symlinks = {};
  for (const entry of data.symlinks) {
    symlinks[entry.relativePath] = entry.target;
  }

  process.stdout.write(`${JSON.stringify({ files, symlinks })}\n`);
}

async function scanSkills() {
  const config = await readJson(configFile, { remote_agents: {} });
  const hashes = {};

  for (const [agent, agentPath] of Object.entries(config.remote_agents ?? {})) {
    if (typeof agentPath !== 'string') {
      continue;
    }

    const resolvedPath = resolve(agentPath.replace(/^~(?=\/|$)/, homedir()));
    const entries = await readdir(resolvedPath, { withFileTypes: true }).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Missing remote skill root for ${agent}: ${agentPath}`);
      }

      throw error;
    });
    const skillEntries = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of skillEntries) {
      const skillDir = join(resolvedPath, entry.name);
      hashes[entry.name] = await hashSkillDirectory(skillDir);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      manifest: await readManifest(),
      remote_hashes: hashes
    })}\n`
  );
}

async function scanAgents() {
  const config = await readJson(configFile, { remote_agents: {} });
  const discoveredAgents = [];
  const attachedSkills = new Set();

  for (const [agent, agentPath] of Object.entries(config.remote_agents ?? {})) {
    if (typeof agentPath !== 'string') {
      continue;
    }

    const resolvedPath = resolve(agentPath.replace(/^~(?=\/|$)/, homedir()));
    const entries = await readdir(resolvedPath, { withFileTypes: true }).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Missing remote skill root for ${agent}: ${agentPath}`);
      }

      throw error;
    });
    const symlinkedSkills = [];
    const directorySkills = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        symlinkedSkills.push(entry.name);
        attachedSkills.add(entry.name);
        continue;
      }

      if (entry.isDirectory()) {
        directorySkills.push(entry.name);
        attachedSkills.add(entry.name);
      }
    }

    discoveredAgents.push({
      name: agent,
      path: agentPath,
      symlinked_skills: symlinkedSkills,
      directory_skills: directorySkills
    });
  }

  const remoteOnlySkills = (await readdir(skillsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !attachedSkills.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  process.stdout.write(`${JSON.stringify({
    discovered_agents: discoveredAgents.sort((left, right) => left.name.localeCompare(right.name)),
    remote_only_skills: remoteOnlySkills
  })}\n`);
}

async function probeAccess() {
  const manifestExists = (await readJson(manifestFile, null)) !== null;
  const config = await readJson(configFile, { remote_agents: {} });
  const remoteAgentResults = [];

  for (const [agent, agentPath] of Object.entries(config.remote_agents ?? {})) {
    if (typeof agentPath !== 'string') {
      continue;
    }

    const resolvedPath = resolve(agentPath.replace(/^~(?=\/|$)/, homedir()));

    try {
      await access(resolvedPath);
      remoteAgentResults.push({ check: `remote_agent:${agent}`, ok: true, detail: agentPath });
    } catch {
      remoteAgentResults.push({ check: `remote_agent:${agent}`, ok: false, detail: `missing: ${agentPath}` });
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      checks: [
        { check: 'manifest', ok: manifestExists, detail: manifestExists ? 'manifest readable' : `missing: ${manifestFile}` },
        ...remoteAgentResults
      ]
    })}\n`
  );
}

async function applyLinks() {
  const manifest = await readManifest();
  const config = await readJson(configFile, { remote_agents: {} });
  const skillNames = Object.keys(manifest.skills).sort();
  const managedSkillNames = skillNames.filter((skill) => manifest.skills[skill]?.remote_hash !== null);
  const expectedSkills = new Set(skillNames);
  const takeoverWarnings = [];
  const hasLinksConfig = typeof config.links === 'object' && config.links !== null && !Array.isArray(config.links);
  const expectedSkillsByAgent = Object.fromEntries(
    Object.keys(config.remote_agents ?? {}).map((agent) => [agent, new Set()])
  );

  if (hasLinksConfig) {
    for (const skill of managedSkillNames) {
      const targets = Array.isArray(config.links[skill])
        ? config.links[skill].filter((item) => typeof item === 'string')
        : [];

      if (targets.includes('*')) {
        for (const agent of Object.keys(expectedSkillsByAgent)) {
          expectedSkillsByAgent[agent].add(skill);
        }
        continue;
      }

      for (const agent of targets) {
        expectedSkillsByAgent[agent]?.add(skill);
      }
    }
  }

  for (const [agent, agentDir] of Object.entries(config.remote_agents ?? {})) {
    if (typeof agentDir !== 'string') {
      continue;
    }

    const expectedAgentSkills = hasLinksConfig
      ? expectedSkillsByAgent[agent] ?? new Set()
      : new Set(managedSkillNames);
    const resolvedAgentDir = resolve(agentDir.replace(/^~(?=\/|$)/, homedir()));
    await mkdir(resolvedAgentDir, { recursive: true });

    for (const entry of await readdir(resolvedAgentDir, { withFileTypes: true })) {
      if (!expectedAgentSkills.has(entry.name) && entry.isSymbolicLink()) {
        await rm(join(resolvedAgentDir, entry.name), { recursive: true, force: true });
      }
    }

    for (const skill of [...expectedAgentSkills].sort()) {
      const sourceDir = join(skillsDir, skill);
      const targetDir = join(resolvedAgentDir, skill);

      try {
        const stats = await lstat(targetDir);

        if (stats.isSymbolicLink()) {
          await rm(targetDir, { recursive: true, force: true });
        } else {
          takeoverWarnings.push(`W_TAKEOVER_NEEDED: ${agent}/${skill} is not a syncskill-managed symlink; use \`remote takeover\` to replace`);
          continue;
        }
      } catch {
        // nothing to clean
      }

      await symlink(sourceDir, targetDir, 'dir');
    }
  }

  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    if (!expectedSkills.has(entry.name)) {
      await rm(join(skillsDir, entry.name), { recursive: true, force: true });
    }
  }

  for (const skill of skillNames) {
    await mkdir(join(skillsDir, skill), { recursive: true });
  }

  await Promise.all(
    skillNames
      .filter((skill) => manifest.skills[skill]?.remote_hash === null)
      .map((skill) => rm(join(skillsDir, skill), { recursive: true, force: true }))
  );

  const existingSkillNames = (await readdir(skillsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const nextSkillNames = skillNames.filter((skill) => existingSkillNames.includes(skill));

  const nextManifestSkills = Object.fromEntries(
    nextSkillNames.map((skill) => [skill, manifest.skills[skill]])
  );

  const nextManifest = {
    ...manifest,
    skills: nextManifestSkills
  };

  const finalizedSkillNames = Object.keys(nextManifest.skills).sort();

  const finalizedManifest = {
    ...nextManifest,
    updated_at: new Date().toISOString(),
    skills: Object.fromEntries(
      await Promise.all(
        finalizedSkillNames.map(async (skill) => {
          const sourceDir = join(skillsDir, skill);
          const remoteHash = await hashSkillDirectory(sourceDir);
          const previous = nextManifest.skills[skill] ?? {};

          return [
            skill,
            {
              local_hash: previous.local_hash ?? null,
              remote_hash: remoteHash,
              recorded_hash: previous.recorded_hash ?? remoteHash,
              direction: 'skip',
              status: 'in-sync'
            }
          ];
        })
      )
    )
  };

  await writeFile(manifestFile, `${JSON.stringify(finalizedManifest, null, 2)}\n`, 'utf8');

  for (const warning of takeoverWarnings) {
    process.stderr.write(`${warning}\n`);
  }

  process.stdout.write(`${JSON.stringify(finalizedManifest)}\n`);
}

const [command, arg, arg2] = process.argv.slice(2);

if (command === 'manifest') {
  process.stdout.write(`${JSON.stringify(await readManifest())}\n`);
} else if (command === 'write-manifest') {
  await writeManifestFromStdin();
} else if (command === 'import-skill' && typeof arg === 'string') {
  await importSkill(arg);
} else if (command === 'promote-skill' && typeof arg === 'string' && typeof arg2 === 'string') {
  await promoteSkill(arg, arg2);
} else if (command === 'export-skill' && typeof arg === 'string') {
  await exportSkill(arg);
} else if (command === 'scan-skills') {
  await scanSkills();
} else if (command === 'scan-agents') {
  await scanAgents();
} else if (command === 'probe-access') {
  await probeAccess();
} else if (command === 'apply') {
  await applyLinks();
} else {
  throw new Error(`Unsupported receiver command: ${command ?? ''}`.trim());
}
