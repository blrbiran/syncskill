import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../helpers/temp-dir.js';

import { computeDefaultLinkTargets } from '../../src/core/private-agents.js';

describe('computeDefaultLinkTargets', () => {
  const tempDirs = useTempDirs();

  it('returns only agents when no private agents are detected', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const result = await computeDefaultLinkTargets(homeDir, {
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        cursor: join(homeDir, '.cursor', 'skills')
      }
    });

    expect(result).toEqual({
      targets: ['agents'],
      created: false
    });
  });

  it('includes detected private agents when their directories exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const cursorDir = join(homeDir, '.cursor', 'skills');
    await mkdir(cursorDir, { recursive: true });

    const result = await computeDefaultLinkTargets(homeDir, {
      agents: {
        claude: join(homeDir, '.claude', 'skills'),
        cursor: '~/.cursor/skills',
        kiro: '~/.kiro/skills'
      },
      private_agents: ['cursor', 'kiro']
    });

    expect(result).toEqual({
      targets: ['agents', 'cursor'],
      created: false
    });
  });

  it('creates the shared agents directory when requested', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'syncskill-private-agents-'));
    tempDirs.push(homeDir);

    const sharedDir = join(homeDir, '.agents', 'skills');

    const result = await computeDefaultLinkTargets(
      homeDir,
      {
        agents: {}
      },
      { createSharedDir: true }
    );

    expect(result).toEqual({
      targets: ['agents'],
      created: true
    });
    await expect(access(sharedDir)).resolves.toBeUndefined();
  });
});
