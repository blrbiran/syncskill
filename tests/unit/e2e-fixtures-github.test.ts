// tests/unit/e2e-fixtures-github.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

describe('E2E GitHub Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.E2E_TEST_REPO_URL;
    delete process.env.E2E_TEST_REPO_SSH;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it('TEST_REPO has default URLs', async () => {
    // Re-import to get fresh module with cleared env
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.baseUrl).toBe('https://github.com/blrbiran/syncskill_test');
    expect(TEST_REPO.sshUrl).toBe('git@github.com:blrbiran/syncskill_test.git');
  });

  it('TEST_REPO URLs can be overridden via env', async () => {
    process.env.E2E_TEST_REPO_URL = 'https://custom.example.com/repo';
    process.env.E2E_TEST_REPO_SSH = 'git@custom.example.com:repo.git';

    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.baseUrl).toBe('https://custom.example.com/repo');
    expect(TEST_REPO.sshUrl).toBe('git@custom.example.com:repo.git');
  });

  it('TEST_REPO.urls derives from baseUrl', async () => {
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.urls.root).toBe(TEST_REPO.baseUrl);
    expect(TEST_REPO.urls.skills).toContain('/tree/main/skills');
    expect(TEST_REPO.urls.singleSkill).toContain('/tree/main/skills/skill-alpha');
  });

  it('TEST_REPO.expectedSkills has predefined values', async () => {
    const { TEST_REPO } = await import(
      '../end2end/framework/fixtures/github.js'
    );

    expect(TEST_REPO.expectedSkills.root).toContain('syncskill_test');
    expect(TEST_REPO.expectedSkills.skills).toEqual(['skill-alpha', 'skill-beta']);
  });
});
