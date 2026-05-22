import { initializeRepo } from '../repo.js';

export interface InitOptions {
  skipScan?: boolean;
  skipSelf?: boolean;
  yes?: boolean;
}

export async function runInit(homeDir: string, options: InitOptions): Promise<void> {
  await initializeRepo(homeDir, {
    skipScan: options.skipScan,
    skipSelf: options.skipSelf,
    yes: options.yes
  });
}
