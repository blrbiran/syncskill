export type SourceInputType = 'git' | 'http' | 'local' | 'archive';

const GIT_URL_PATTERNS = [
  /^git@/,
  /^https?:\/\/.*\.git$/,
  /^https?:\/\/github\.com\//,
  /^https?:\/\/gitlab\.com\//,
  /^https?:\/\/bitbucket\.org\//
];

const ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.tar', '.zip'];

export function detectSourceInput(input: string): SourceInputType {
  for (const pattern of GIT_URL_PATTERNS) {
    if (pattern.test(input)) {
      return 'git';
    }
  }

  if (/^https?:\/\//.test(input)) {
    return 'http';
  }

  const lowerInput = input.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lowerInput.endsWith(ext)) {
      return 'archive';
    }
  }

  return 'local';
}

export function isGitUrl(input: string): boolean {
  return detectSourceInput(input) === 'git';
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//.test(input) && !isGitUrl(input);
}

export function isLocalArchive(input: string): boolean {
  return detectSourceInput(input) === 'archive';
}
