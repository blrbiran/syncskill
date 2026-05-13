// tests/end2end/framework/e2e-test.ts
import { it } from 'vitest';

export interface E2ETestOptions {
  timeout?: number;
  network?: boolean;
  tags?: string[];
  skip?: boolean | (() => boolean);
  only?: boolean;
}

/**
 * E2E test entry point.
 */
export function e2eTest(
  name: string,
  fn: () => Promise<void>,
  options: E2ETestOptions = {}
): void {
  const {
    timeout = 60000,
    network = false,
    skip = false,
    only = false,
  } = options;

  const shouldSkip = typeof skip === 'function' ? skip() : skip;

  // Skip network tests if E2E_SKIP_NETWORK is set
  const skipNetwork = network && process.env.E2E_SKIP_NETWORK === '1';

  if (shouldSkip || skipNetwork) {
    it.skip(name, fn);
  } else if (only) {
    it.only(name, fn, timeout);
  } else {
    it(name, fn, timeout);
  }
}

// Convenience variants
e2eTest.network = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'network'> = {}) =>
  e2eTest(name, fn, { ...options, network: true });

e2eTest.skip = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'skip'> = {}) =>
  e2eTest(name, fn, { ...options, skip: true });

e2eTest.only = (name: string, fn: () => Promise<void>, options: Omit<E2ETestOptions, 'only'> = {}) =>
  e2eTest(name, fn, { ...options, only: true });
