// Code shared by apps/web and apps/api. Consumed as TypeScript source (no build step):
// package.json "exports" points straight at this file, and Vite / tsx / Vitest compile it.
// Must stay isomorphic: no imports from express, react, or either app (enforced in eslint.config.js).

/** Project name, as shown to customers. */
export const APP_NAME = 'לתת עוד';

// Street list, search and region (ADR-0005).
export * from './streets.ts';

/** Body of GET /api/health. The web app calls it on load to warm up the function (ADR-0002). */
export interface HealthResponse {
  ok: true;
}
