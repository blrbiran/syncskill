#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const syncRoot = join(homedir(), '.syncskill');
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

async function importSkill(name) {
  const files = JSON.parse(await readStdin());
  const targetDir = join(skillsDir, name);

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const [relativePath, base64] of Object.entries(files)) {
    if (isAbsolute(relativePath)) {
      throw new Error(`Invalid skill entry: ${relativePath}`);
    }

    const destination = resolve(targetDir, relativePath);
    const relativeDestination = relative(targetDir, destination);

    if (relativeDestination === '..' || relativeDestination.startsWith('../') || relativeDestination.startsWith('..\\')) {
      throw new Error(`Invalid skill entry: ${relativePath}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(base64, 'base64'));
  }
}

async function exportSkill(name) {
  const targetDir = join(skillsDir, name);
  const files = {};

  for (const entry of await collectFileEntries(targetDir)) {
    files[entry.relativePath] = entry.contents.toString('base64');
  }

  process.stdout.write(`${JSON.stringify(files)}\n`);
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
  const expectedSkills = new Set(skillNames);

  for (const agentDir of Object.values(config.remote_agents ?? {})) {
    if (typeof agentDir !== 'string') {
      continue;
    }

    const resolvedAgentDir = resolve(agentDir.replace(/^~(?=\/|$)/, homedir()));
    await mkdir(resolvedAgentDir, { recursive: true });

    for (const entry of await readdir(resolvedAgentDir, { withFileTypes: true })) {
      if (!expectedSkills.has(entry.name)) {
        await rm(join(resolvedAgentDir, entry.name), { recursive: true, force: true });
      }
    }

    for (const skill of skillNames) {
      const sourceDir = join(skillsDir, skill);
      const targetDir = join(resolvedAgentDir, skill);

      try {
        const stats = await lstat(targetDir);

        if (stats.isSymbolicLink() || stats.isDirectory()) {
          await rm(targetDir, { recursive: true, force: true });
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
  process.stdout.write(`${JSON.stringify(finalizedManifest)}\n`);
}

const [command, arg] = process.argv.slice(2);

if (command === 'manifest') {
  process.stdout.write(`${JSON.stringify(await readManifest())}\n`);
} else if (command === 'write-manifest') {
  await writeManifestFromStdin();
} else if (command === 'import-skill' && typeof arg === 'string') {
  await importSkill(arg);
} else if (command === 'export-skill' && typeof arg === 'string') {
  await exportSkill(arg);
} else if (command === 'scan-skills') {
  await scanSkills();
} else if (command === 'probe-access') {
  await probeAccess();
} else if (command === 'apply') {
  await applyLinks();
} else {
  throw new Error(`Unsupported receiver command: ${command ?? ''}`.trim());
}
