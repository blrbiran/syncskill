import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageJson {
  private?: boolean;
  description?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  devDependencies?: Record<string, string>;
}

describe('package metadata', () => {
  it('exposes a public-facing description, bin, and tiered scripts', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as PackageJson;

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.description).toBe('Multi-device AI Agent Skill sync tool');
    expect(packageJson.bin?.syncskill).toBe('dist/index.js');
    expect(packageJson.scripts?.test).toBe('vitest run tests/unit tests/integration');
    expect(packageJson.scripts?.['test:unit']).toBe('vitest run tests/unit');
    expect(packageJson.scripts?.['test:integration']).toBe('vitest run tests/integration');
    expect(packageJson.scripts?.['test:e2e']).toBe("vitest run tests/end2end/cases --exclude '**/network/**'");
    expect(packageJson.scripts?.['test:watch']).toBe('vitest');
  });

  it('has shx in devDependencies for cross-platform build', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as PackageJson;
    expect(packageJson.devDependencies?.shx).toBeDefined();
  });

  it('has files field including dist and skills', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as PackageJson;
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).toContain('skills');
  });

  it('copies skills in build script', async () => {
    const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as PackageJson;
    expect(packageJson.scripts?.build).toContain('shx cp -r skills dist/');
  });
});
