import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same origin in dev as in production (ADR-0002): /api goes to `npm run dev:api`.
      // `changeOrigin: false` keeps the browser's Host (localhost:5173) on the proxied request,
      // so the api's Origin check (apps/api/src/sameOrigin.ts) sees Origin and Host match. The
      // string shorthand (`'/api': 'http://localhost:3000'`) turns changeOrigin on, rewriting Host
      // to localhost:3000, and the api would refuse every POST with 403 forbidden_origin.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Cleanup between tests (no Vitest globals, so Testing Library cannot do it on its own).
    setupFiles: ['./src/testSetup.ts'],
  },
});
