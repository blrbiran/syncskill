import { configDefaults, defineConfig } from 'vitest/config';

// Without a config, `vitest run tests/unit tests/integration` treats its arguments as substring filters and also ran
// every copy under .claude/worktrees/ (155 files instead of 78; Orca test-time analysis 2026-11-24 §1.3).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.worktrees/**'],
  },
});
