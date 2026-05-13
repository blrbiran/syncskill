// tests/end2end/framework/fixtures/github.ts

const DEFAULT_BASE_URL = 'https://github.com/blrbiran/syncskill_test';
const DEFAULT_SSH_URL = 'git@github.com:blrbiran/syncskill_test.git';

/**
 * Official test repository configuration.
 * URLs can be overridden via environment variables.
 */
export const TEST_REPO = {
  get baseUrl(): string {
    return process.env.E2E_TEST_REPO_URL ?? DEFAULT_BASE_URL;
  },

  get sshUrl(): string {
    return process.env.E2E_TEST_REPO_SSH ?? DEFAULT_SSH_URL;
  },

  localPath: 'tests/end2end/fixtures/syncskill_test',

  urls: {
    get root() {
      return TEST_REPO.baseUrl;
    },
    get skills() {
      return `${TEST_REPO.baseUrl}/tree/main/skills`;
    },
    get singleSkill() {
      return `${TEST_REPO.baseUrl}/tree/main/skills/skill-alpha`;
    },
    get examples() {
      return `${TEST_REPO.baseUrl}/tree/main/examples`;
    },
    get singleExample() {
      return `${TEST_REPO.baseUrl}/tree/main/examples/example-one`;
    },
  },

  expectedSkills: {
    root: ['syncskill_test', 'skill-alpha', 'skill-beta', 'example-one', 'example-two'],
    skills: ['skill-alpha', 'skill-beta'],
    singleSkill: ['skill-alpha'],
    examples: ['example-one', 'example-two'],
    singleExample: ['example-one'],
  },
};
