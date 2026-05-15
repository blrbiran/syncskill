import { cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { select } from '@inquirer/prompts';

import { getSyncPaths } from './config/config.js';
import {
  clearSourceHistory,
  getSourceHistory,
  type GitUpdateRecord,
  type HttpUpdateRecord
} from './core/update-history.js';

const execFileAsync = promisify(execFile);

export interface RestoreResult {
  success: boolean;
  message: string;
}

export async function restoreSource(homeDir: string, sourceName: string): Promise<RestoreResult> {
  const record = await getSourceHistory(homeDir, sourceName);

  if (!record) {
    return { success: false, message: `No restore history for "${sourceName}".` };
  }

  if (record.type === 'git') {
    return restoreGitSource(homeDir, sourceName, record);
  }

  return restoreHttpSource(homeDir, sourceName, record);
}

async function restoreGitSource(homeDir: string, sourceName: string, record: GitUpdateRecord): Promise<RestoreResult> {
  const checkoutDir = join(getSyncPaths(homeDir).syncDir, '.sources', sourceName, 'checkout');

  console.log(`Last overwrite: ${formatTimestamp(record.timestamp)}`);
  console.log('  Type: git');
  console.log(`  Before: ${shortHash(record.before_commit)} → After: ${shortHash(record.after_commit)}`);
  console.log(`  Stash: ${shortHash(record.stash_commit)}`);
  console.log('');

  const action = await select({
    message: 'Choose restore action:',
    choices: [
      { name: '(R) Restore to dirty state — checkout before + apply stash', value: 'restore-dirty-state' as const },
      { name: '(c) Checkout only — go back to before commit (no stash apply)', value: 'checkout-only' as const },
      { name: '(a) Apply stash only — apply stash on current version', value: 'apply-stash-only' as const },
      { name: '(q) Cancel', value: 'cancel' as const }
    ],
    default: 'restore-dirty-state'
  });

  if (action === 'cancel') {
    return { success: false, message: 'Restore cancelled.' };
  }

  if (action === 'restore-dirty-state' || action === 'checkout-only') {
    await execFileAsync('git', ['-C', checkoutDir, 'checkout', '--detach', record.before_commit]);
  }

  if (action === 'restore-dirty-state' || action === 'apply-stash-only') {
    await execFileAsync('git', ['-C', checkoutDir, 'stash', 'apply', record.stash_commit]);
    await dropMatchingStash(checkoutDir, record.stash_commit);
  }

  await clearSourceHistory(homeDir, sourceName);

  if (action === 'restore-dirty-state') {
    return { success: true, message: `Restored git source "${sourceName}" to dirty state.` };
  }

  if (action === 'checkout-only') {
    return { success: true, message: `Checked out git source "${sourceName}" to pre-update commit.` };
  }

  return { success: true, message: `Applied stash for git source "${sourceName}" on current checkout.` };
}

async function restoreHttpSource(homeDir: string, sourceName: string, record: HttpUpdateRecord): Promise<RestoreResult> {
  const { skillsDir } = getSyncPaths(homeDir);

  console.log(`Last overwrite: ${formatTimestamp(record.timestamp)}`);
  console.log('  Type: http');
  console.log(`  Backup: ${record.backup_path}`);
  console.log(`  Dirty skills: ${record.dirty_skills.join(', ')}`);
  console.log('');

  const action = await select({
    message: 'Choose restore action:',
    choices: [
      { name: '(R) Restore backup — copy files back', value: 'restore-backup' as const },
      { name: '(q) Cancel', value: 'cancel' as const }
    ],
    default: 'restore-backup'
  });

  if (action === 'cancel') {
    return { success: false, message: 'Restore cancelled.' };
  }

  for (const skillName of record.dirty_skills) {
    await cp(join(record.backup_path, skillName), join(skillsDir, skillName), {
      recursive: true,
      force: true
    });
  }

  await clearSourceHistory(homeDir, sourceName);

  return { success: true, message: `Restored HTTP source "${sourceName}" from backup.` };
}

async function dropMatchingStash(checkoutDir: string, stashCommit: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['-C', checkoutDir, 'stash', 'list']);
  const matchingEntry = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(stashCommit));

  if (!matchingEntry) {
    return;
  }

  const stashRef = matchingEntry.split(':', 1)[0];
  await execFileAsync('git', ['-C', checkoutDir, 'stash', 'drop', stashRef]);
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\..+$/, '');
}
