import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // Same origin in dev as in production (ADR-0002): /api goes to `npm run dev:api`.
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
