import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The mongo tests re-import the whole mongodb driver per test (vi.resetModules); that exceeds the
    // 5s default when the full suite runs every project in parallel (seen once, passes alone).
    testTimeout: 20_000,
  },
});
