import { describe, expect, it } from 'vitest';

import { detectSourceInput } from '../../src/source/detect.js';

describe('source/detect', () => {
  it('detects git URL', () => {
    expect(detectSourceInput('https://github.com/user/repo.git')).toBe('git');
    expect(detectSourceInput('git@github.com:user/repo.git')).toBe('git');
    expect(detectSourceInput('https://github.com/user/repo')).toBe('git');
  });

  it('detects HTTP URL', () => {
    expect(detectSourceInput('https://example.com/skills.tar.gz')).toBe('http');
  });

  it('detects local path', () => {
    expect(detectSourceInput('/path/to/skills')).toBe('local');
    expect(detectSourceInput('./relative/path')).toBe('local');
  });

  it('detects local archive', () => {
    expect(detectSourceInput('/path/to/skills.tar.gz')).toBe('archive');
    expect(detectSourceInput('./skills.zip')).toBe('archive');
  });
});
