import { describe, expect, it } from 'vitest';

import { parseGitHubUrl } from '../../src/source.js';

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
