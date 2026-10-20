// Tests for the static <head> of apps/web/index.html: the Open Graph tags WhatsApp reads to build
// a link preview (ADR-0002), and the image they point at in apps/web/public/. Link previews do not
// run JavaScript, so these tags must be in the file itself; this reads the file, not the rendered app.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Paths from import.meta.dirname, not `new URL('../x', import.meta.url)`: Vite rewrites that pattern
// as an asset URL, which under jsdom becomes http://localhost:3000/x instead of a file path.
/** apps/web, the folder of index.html and public/. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..');

/** The public origin of the deployed app (also PUBLIC_BASE_URL, docs/deploy.md). */
const PUBLIC_ORIGIN = 'https://latet-od.vercel.app';
/** WhatsApp and the other apps want a big preview image of this size (1.91:1). */
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
/** WhatsApp is known to drop preview images over about 300 KB; small also loads fast on a phone. */
const OG_IMAGE_MAX_BYTES = 300 * 1024;

const indexHtml = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
const head = new DOMParser().parseFromString(indexHtml, 'text/html').head;

/** The `content` of `<meta property="…">` (Open Graph), or `undefined` when the tag is missing. */
function ogContent(property: string): string | undefined {
  return head.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? undefined;
}

/** Like ogContent, but fails the test when the tag is missing or empty. */
function requiredOgContent(property: string): string {
  const content = ogContent(property);
  if (!content?.trim())
    throw new Error(`index.html has no non-empty <meta property="${property}">`);
  return content;
}

/** The file in apps/web/public/ that a URL path on the public origin is served from. */
function publicFile(urlPath: string): string {
  return path.join(WEB_ROOT, 'public', urlPath);
}

/**
 * Width and height from a JPEG's frame header (SOF0 baseline, SOF1, or SOF2 progressive). Walks
 * the marker segments after SOI: each is FF <marker> <2-byte length> <data>, and the frame header
 * holds precision (1 byte), then height and width (2 bytes each, big-endian).
 */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2; // just after SOI (FF D8)
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`no JPEG marker at byte ${offset}`);
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('no JPEG frame header (SOF0/SOF1/SOF2) found');
}

describe('index.html link preview (Open Graph)', () => {
  it('has a non-empty og:type, og:title, og:description, og:url and og:image', () => {
    for (const property of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image']) {
      expect(ogContent(property)?.trim(), property).toBeTruthy();
    }
  });

  it('gives og:url and og:image as absolute https URLs on the public origin', () => {
    // WhatsApp needs absolute URLs: it does not resolve a relative path against the page.
    for (const property of ['og:url', 'og:image']) {
      const url = new URL(requiredOgContent(property));
      expect(url.origin, property).toBe(PUBLIC_ORIGIN);
      expect(url.protocol, property).toBe('https:');
    }
    expect(requiredOgContent('og:url')).toBe(`${PUBLIC_ORIGIN}/`);
  });

  it('points og:image at a JPEG in apps/web/public no larger than 300 KB', () => {
    const imagePath = new URL(requiredOgContent('og:image')).pathname;
    const file = publicFile(imagePath);

    expect(fs.existsSync(file), `apps/web/public${imagePath} exists`).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(OG_IMAGE_MAX_BYTES);
    const bytes = fs.readFileSync(file);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // JPEG SOI marker
    expect(requiredOgContent('og:image:type')).toBe('image/jpeg');
  });

  it('declares the image as 1200×630, and the JPEG really is 1200×630', () => {
    expect(requiredOgContent('og:image:width')).toBe(String(OG_IMAGE_WIDTH));
    expect(requiredOgContent('og:image:height')).toBe(String(OG_IMAGE_HEIGHT));

    const bytes = fs.readFileSync(publicFile(new URL(requiredOgContent('og:image')).pathname));
    expect(jpegSize(bytes)).toEqual({ width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT });
  });

  it('has no robots meta tag, so the public form stays indexable', () => {
    // index.html is served for every page, so a robots tag here would hide the public form too.
    // The private customer pages (/o/<token>) get `X-Robots-Tag: noindex` from vercel.json.
    expect(head.querySelector('meta[name="robots"]')).toBeNull();
  });
});
