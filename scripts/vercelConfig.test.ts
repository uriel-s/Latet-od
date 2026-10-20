// Tests for vercel.json, the deploy config at the repo root. JSON holds no comments, so this header
// explains it (docs/deploy.md documents the deploy as a whole):
//
// - buildCommand / outputDirectory / framework restate the Vercel dashboard settings of the project:
//   vercel.json overrides the dashboard, so the repo is the one place they are written. The build is
//   the web workspace's `vite build`, whose output is apps/web/dist (Vite's default outDir; its
//   vite.config.ts sets none).
// - regions ["iad1"]: the function runs in Washington, D.C., next to the Atlas cluster in AWS
//   us-east-1 (ADR-0002), so every database round trip stays short.
// - rewrites, in order. Vercel serves a file that exists in the build output before it looks at any
//   rewrite, so /assets/* and /og-image.jpg are served as files. Then:
//     1. /api/(.*) → /api: every api path goes to the one function, api/index.ts; Express still sees
//        the original path. It must come before the catch-all, or an api call would get index.html.
//     2. /(.*) → /index.html: every other path loads the SPA, which picks the page from the URL
//        (apps/web/src/router.tsx), so a deep link like /o/<token> from WhatsApp works.
// - headers: /o/(.*) gets `X-Robots-Tag: noindex`, keeping a customer's private page out of search
//   engines without hiding the public form at / (a <meta name="robots"> in index.html would apply
//   to every page, since every page is index.html).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const VERCEL_JSON = fileURLToPath(new URL('../vercel.json', import.meta.url));
/** The one Vercel function: rewrites send every /api path here. */
const API_FUNCTION = fileURLToPath(new URL('../api/index.ts', import.meta.url));

/** The part of Vercel's config schema this repo uses; anything else in the file fails the parse. */
const vercelConfigSchema = z.strictObject({
  $schema: z.string(),
  framework: z.string(),
  buildCommand: z.string(),
  outputDirectory: z.string(),
  regions: z.array(z.string()),
  rewrites: z.array(z.strictObject({ source: z.string(), destination: z.string() })),
  headers: z.array(
    z.strictObject({
      source: z.string(),
      headers: z.array(z.strictObject({ key: z.string(), value: z.string() })),
    }),
  ),
});

const config = vercelConfigSchema.parse(JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8')));

describe('vercel.json', () => {
  it('builds the web workspace with Vite and serves apps/web/dist', () => {
    expect(config.framework).toBe('vite');
    expect(config.buildCommand).toBe('npm run build --workspace apps/web');
    // Vite's default outDir, relative to apps/web (apps/web/vite.config.ts sets no build.outDir).
    expect(config.outputDirectory).toBe('apps/web/dist');
  });

  it('runs the function in iad1, next to the Atlas cluster in us-east-1', () => {
    // ADR-0002: the database is in AWS us-east-1; Hobby allows a single region.
    expect(config.regions).toEqual(['iad1']);
  });

  it('rewrites /api paths to the function first, then every other path to the SPA', () => {
    // Order matters: Vercel applies the first matching rewrite, and /(.*) matches /api/... too.
    expect(config.rewrites).toEqual([
      { source: '/api/(.*)', destination: '/api' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });

  it('has the function file the /api rewrite points at', () => {
    expect(fs.existsSync(API_FUNCTION)).toBe(true);
  });

  it('tells search engines not to index the private customer pages /o/<token>', () => {
    const orderPageHeaders = config.headers.filter((rule) => rule.source === '/o/(.*)');
    expect(orderPageHeaders).toEqual([
      { source: '/o/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] },
    ]);
  });

  it('adds no header to the public form, so it stays indexable', () => {
    // Only /o/* is private; a rule matching / (or everything) would hide the booking form.
    expect(config.headers.map((rule) => rule.source)).toEqual(['/o/(.*)']);
  });
});
