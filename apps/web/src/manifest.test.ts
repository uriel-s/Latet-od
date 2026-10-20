// Tests for the web app manifest (apps/web/public/manifest.webmanifest) and the app icons beside it:
// what makes the collector app (/app) installable from Safari's "Add to Home Screen". There is no
// service worker, so these static files are the whole of the PWA; this reads them from disk.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Paths from import.meta.dirname, not `new URL('../x', import.meta.url)`: Vite rewrites that pattern
// as an asset URL, which under jsdom becomes http://localhost:3000/x instead of a file path.
/** apps/web/public, served at the root of the site. */
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

/** The brand's light blue: the icon background, and index.html's theme-color. */
const BRAND_BACKGROUND = '#DCEBF8';

/** One entry of the manifest's `icons` array. */
interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'),
) as Record<string, unknown> & { icons: ManifestIcon[] };

/** The file in apps/web/public/ that a URL path on the site is served from. */
function publicFile(urlPath: string): string {
  return path.join(PUBLIC_DIR, urlPath);
}

/** The 8 bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width, height and colour type from a PNG's IHDR chunk, which always comes first: after the
 * 8-byte signature, a 4-byte length and the 4-byte type "IHDR", then width and height (4 bytes
 * each, big-endian), bit depth (1 byte) and colour type (1 byte).
 */
function pngHeader(bytes: Buffer): { width: number; height: number; colourType: number } {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG does not start with IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colourType: bytes.readUInt8(25),
  };
}

/** Width and height of the PNG at a URL path, as `"<w>x<h>"` (the manifest's `sizes` format). */
function pngSizes(urlPath: string): string {
  const { width, height } = pngHeader(fs.readFileSync(publicFile(urlPath)));
  return `${width}x${height}`;
}

/** PNG colour types 4 (grey + alpha) and 6 (RGB + alpha) carry an alpha channel. */
const COLOUR_TYPES_WITH_ALPHA = [4, 6];

describe('manifest.webmanifest', () => {
  it('names the app "לתת עוד" and opens /app full-screen, in Hebrew, right to left', () => {
    expect(manifest).toMatchObject({
      name: 'לתת עוד',
      short_name: 'לתת עוד',
      start_url: '/app',
      scope: '/app',
      display: 'standalone',
      lang: 'he',
      dir: 'rtl',
    });
  });

  it('uses the brand light blue for the background and the theme colour', () => {
    expect(manifest.background_color).toBe(BRAND_BACKGROUND);
    expect(manifest.theme_color).toBe(BRAND_BACKGROUND);
  });

  it('declares the 192 and 512 PNG icons that Android and Chrome require', () => {
    const declared = manifest.icons
      .filter((icon) => icon.purpose === undefined || icon.purpose.split(' ').includes('any'))
      .map((icon) => icon.sizes);
    expect(declared).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) expect(icon.type, icon.src).toBe('image/png');
  });

  it('points every icon at a PNG in apps/web/public of exactly the declared size', () => {
    for (const icon of manifest.icons) {
      expect(fs.existsSync(publicFile(icon.src)), `apps/web/public${icon.src} exists`).toBe(true);
      expect(pngSizes(icon.src), icon.src).toBe(icon.sizes);
    }
  });
});

describe('app icons in apps/web/public', () => {
  it('has the 180×180 apple-touch-icon that iPhone uses for the home screen', () => {
    expect(fs.existsSync(publicFile('/icon-180.png'))).toBe(true);
    expect(pngSizes('/icon-180.png')).toBe('180x180');
  });

  it('makes every icon PNG square and without an alpha channel', () => {
    // iOS fills transparent pixels with black, so the icons are opaque RGB.
    for (const name of ['icon-180.png', 'icon-192.png', 'icon-512.png']) {
      const { width, height, colourType } = pngHeader(fs.readFileSync(publicFile(name)));
      expect(width, name).toBe(height);
      expect(COLOUR_TYPES_WITH_ALPHA, name).not.toContain(colourType);
    }
  });

  it('keeps the SVG the PNGs were made from', () => {
    const svg = fs.readFileSync(publicFile('/icon.svg'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain(BRAND_BACKGROUND);
  });
});
