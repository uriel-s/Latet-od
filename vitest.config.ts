// One `vitest run` for the whole repo. Each workspace owns its environment (node / jsdom).
// Always invoke through `bash .claude/checks.sh test [files]`, never bare `vitest` (watch mode).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/api', 'apps/web'],
  },
});
