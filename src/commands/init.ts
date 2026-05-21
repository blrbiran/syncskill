import { initializeRepo } from '../repo.js';

export interface InitOptions {
  skipScan?: boolean;
  skipSkill?: boolean;
  yes?: boolean;
}

export async function runInit(homeDir: string, options: InitOptions): Promise<void> {
  await initializeRepo(homeDir, {
    skipScan: options.skipScan,
    skipSkill: options.skipSkill,
    yes: options.yes
  });
}
