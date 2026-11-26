import { describe, expect, it } from 'vitest';

import { enforceNodeVersion } from '../../src/receiver/sync_receiver.mjs';

describe('receiver Node runtime', () => {
  it('fails with a stable error and exit code for Node below 18', () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    expect(enforceNodeVersion('v16.20.0', {
      write: (message) => errors.push(message),
      exit: (code) => exitCodes.push(code)
    })).toBe(false);
    expect(errors).toEqual(['E_RECEIVER_NODE_TOO_OLD: receiver requires Node.js 18 or newer; found v16.20.0\n']);
    expect(exitCodes).toEqual([8]);
  });

  it('accepts Node 18 or newer without exiting', () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    expect(enforceNodeVersion('v18.0.0', {
      write: (message) => errors.push(message),
      exit: (code) => exitCodes.push(code)
    })).toBe(true);
    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});
