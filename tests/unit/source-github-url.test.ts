import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadConfig, saveConfig } from '../../src/config.js';
import { addSourceFromUrl, parseGitHubUrl } from '../../src/source.js';

describe('parseGitHubUrl', () => {
  it('parses tree URL with path', () => {
    const result = parseGitHubUrl('https://github.com/openclaw/openclaw/tree/main/.agents/skills/skill-name');

    expect(result).toEqual({
      org: 'openclaw',
      repo: 'openclaw',
      branch: 'main',
      path: '.agents/skills/skill-name',
      cloneUrl: 'https://github.com/openclaw/openclaw.git',
      skillName: 'skill-name'
    });
  });

  it('parses tree URL without path', () => {
    const result = parseGitHubUrl('https://github.com/user/repo/tree/develop');

    expect(result).toEqual({
      org: 'user',
      repo: 'repo',
      branch: 'develop',
      path: '',
      cloneUrl: 'https://github.com/user/repo.git',
      skillName: 'repo'
    });
  });

  it('parses .git URL', () => {
    const result = parseGitHubUrl('https://github.com/org/my-skill.git');

    expect(result).toEqual({
      org: 'org',
      repo: 'my-skill',
      branch: undefined,
      path: '',
      cloneUrl: 'https://github.com/org/my-skill.git',
      skillName: 'my-skill'
    });
  });

  it('parses plain repo URL', () => {
    const result = parseGitHubUrl('https://github.com/org/repo');

    expect(result).toEqual({
      org: 'org',
      repo: 'repo',
      branch: undefined,
      path: '',
      cloneUrl: 'https://github.com/org/repo.git',
      skillName: 'repo'
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubUrl('https://gitlab.com/org/repo')).toBeNull();
    expect(parseGitHubUrl('not-a-url')).toBeNull();
  });
});

describe('addSourceFromUrl', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('auto-derives name, type, url, store, and ref from GitHub tree URL', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-url-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const { name, source } = await addSourceFromUrl(
      homeDir,
      'https://github.com/openclaw/skills/tree/main/my-skill'
    );

    expect(name).toBe('my-skill');
    expect(source.type).toBe('git');
    expect(source.url).toBe('https://github.com/openclaw/skills.git');
    expect(source.ref).toBe('main');
    expect(source.store).toMatch(/sources\/skills$/);
  });

  it('allows explicit name override via options', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-url-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const { name } = await addSourceFromUrl(
      homeDir,
      'https://github.com/org/repo.git',
      { name: 'custom-name' }
    );

    expect(name).toBe('custom-name');
    const config = await loadConfig(homeDir);
    expect(config.sources['custom-name']).toBeDefined();
    expect(config.sources['repo']).toBeUndefined();
  });

  it('throws helpful error for non-GitHub URLs without explicit options', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-url-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    await expect(
      addSourceFromUrl(homeDir, 'https://gitlab.com/org/repo')
    ).rejects.toThrow('Could not parse URL');
  });

  it('accepts non-GitHub URL with explicit type and store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-source-url-'));
    tempDirs.push(homeDir);
    await mkdir(join(homeDir, '.syncskill'), { recursive: true });
    await saveConfig(createDefaultConfig(homeDir, {}), homeDir);

    const { name, source } = await addSourceFromUrl(
      homeDir,
      'https://example.com/skills.git',
      { type: 'git', store: 'skills', name: 'example-skills' }
    );

    expect(name).toBe('example-skills');
    expect(source.type).toBe('git');
    expect(source.url).toBe('https://example.com/skills.git');
    expect(source.store).toBe('skills');
  });
});
