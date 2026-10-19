// One `vitest run` for the whole repo. Each workspace owns its environment (node / jsdom).
// Always invoke through `bash .claude/checks.sh test [files]`, never bare `vitest` (watch mode).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/api',
      'apps/web',
      // Inline, not packages/shared/vitest.config.ts: shared's tsconfig has `types: []` to stay
      // isomorphic, so it holds no tool config. An inline project's root is this repo root.
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['packages/shared/src/**/*.test.ts'],
        },
      },
      // Root-level one-off scripts (scripts/geocode-streets.ts): not a workspace, so inline too.
      {
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
