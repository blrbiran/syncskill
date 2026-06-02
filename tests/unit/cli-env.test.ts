// tests/unit/cli-env.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvConfig, mergeWithFlags } from '../../src/cli/env.js';

describe('cli/env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadEnvConfig', () => {
    it('returns defaults when no env vars set', () => {
      delete process.env.SYNCSKILL_DIR;
      delete process.env.SYNCSKILL_CONFIG;
      delete process.env.SYNCSKILL_NO_INTERACTIVE;
      delete process.env.SYNCSKILL_JSON;
      delete process.env.SYNCSKILL_STRICT;
      delete process.env.SYNCSKILL_TIMEOUT;
      delete process.env.SYNCSKILL_LOG_LEVEL;
      delete process.env.NO_COLOR;

      const config = loadEnvConfig();

      expect(config.syncDir).toBeUndefined();
      expect(config.configPath).toBeUndefined();
      expect(config.noInteractive).toBe(false);
      expect(config.json).toBe(false);
      expect(config.strict).toBe(false);
      expect(config.timeout).toBeUndefined();
      expect(config.logLevel).toBe('info');
      expect(config.noColor).toBe(false);
    });

    it('reads SYNCSKILL_DIR', () => {
      process.env.SYNCSKILL_DIR = '/custom/path';
      const config = loadEnvConfig();
      expect(config.syncDir).toBe('/custom/path');
    });

    it('reads SYNCSKILL_CONFIG', () => {
      process.env.SYNCSKILL_CONFIG = '/custom/config.json';
      const config = loadEnvConfig();
      expect(config.configPath).toBe('/custom/config.json');
    });

    it('reads SYNCSKILL_NO_INTERACTIVE', () => {
      process.env.SYNCSKILL_NO_INTERACTIVE = '1';
      const config = loadEnvConfig();
      expect(config.noInteractive).toBe(true);
    });

    it('reads SYNCSKILL_JSON', () => {
      process.env.SYNCSKILL_JSON = '1';
      const config = loadEnvConfig();
      expect(config.json).toBe(true);
    });

    it('reads SYNCSKILL_STRICT', () => {
      process.env.SYNCSKILL_STRICT = '1';
      const config = loadEnvConfig();
      expect(config.strict).toBe(true);
    });

    it('reads NO_COLOR', () => {
      process.env.NO_COLOR = '1';
      const config = loadEnvConfig();
      expect(config.noColor).toBe(true);
    });

    it('parses SYNCSKILL_TIMEOUT as number', () => {
      process.env.SYNCSKILL_TIMEOUT = '60';
      const config = loadEnvConfig();
      expect(config.timeout).toBe(60);
    });

    it('returns undefined for invalid SYNCSKILL_TIMEOUT', () => {
      process.env.SYNCSKILL_TIMEOUT = 'invalid';
      const config = loadEnvConfig();
      expect(config.timeout).toBeUndefined();
    });

    it('returns undefined for negative SYNCSKILL_TIMEOUT', () => {
      process.env.SYNCSKILL_TIMEOUT = '-5';
      const config = loadEnvConfig();
      expect(config.timeout).toBeUndefined();
    });

    it('parses valid SYNCSKILL_LOG_LEVEL', () => {
      process.env.SYNCSKILL_LOG_LEVEL = 'debug';
      const config = loadEnvConfig();
      expect(config.logLevel).toBe('debug');
    });

    it('defaults invalid SYNCSKILL_LOG_LEVEL to info', () => {
      process.env.SYNCSKILL_LOG_LEVEL = 'invalid';
      const config = loadEnvConfig();
      expect(config.logLevel).toBe('info');
    });
  });

  describe('mergeWithFlags', () => {
    it('flags override env config', () => {
      process.env.SYNCSKILL_DIR = '/env/path';
      const envConfig = loadEnvConfig();
      const merged = mergeWithFlags(envConfig, {
        syncDir: '/flag/path',
        json: true,
        strict: true,
      });

      expect(merged.syncDir).toBe('/flag/path');
      expect(merged.json).toBe(true);
      expect(merged.strict).toBe(true);
    });

    it('preserves env values when flags not provided', () => {
      process.env.SYNCSKILL_DIR = '/env/path';
      process.env.SYNCSKILL_JSON = '1';
      process.env.SYNCSKILL_STRICT = '1';
      const envConfig = loadEnvConfig();
      const merged = mergeWithFlags(envConfig, {});

      expect(merged.syncDir).toBe('/env/path');
      expect(merged.json).toBe(true);
      expect(merged.strict).toBe(true);
    });

    it('preserves defaults when neither flag nor env provided', () => {
      delete process.env.SYNCSKILL_DIR;
      const envConfig = loadEnvConfig();
      const merged = mergeWithFlags(envConfig, {});

      expect(merged.syncDir).toBeUndefined();
      expect(merged.strict).toBe(false);
      expect(merged.logLevel).toBe('info');
    });
  });
});
