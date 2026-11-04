// Cheap guards on styles.css, which jsdom does not lay out, so this reads the file as text.
// 1. Safe areas: index.html sets viewport-fit=cover, so the page reaches under the notch, the
//    status bar and the home bar, and only the env(safe-area-inset-*) padding keeps text and
//    buttons out from under them. This catches an inset deleted by mistake, not how it looks.
// 2. Colour contrast: the "dawn" palette of ADR-0011 is read from the :root block and every
//    text/background pair the screens use must reach WCAG AA (4.5:1), so a colour changed to a
//    weaker shade fails here instead of on Yoel's phone in the sun.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// From import.meta.dirname, not new URL(…, import.meta.url): see indexHtml.test.ts.
const stylesCss = fs.readFileSync(path.join(import.meta.dirname, 'styles.css'), 'utf8');

describe('styles.css safe areas', () => {
  it.each(['top', 'right', 'bottom', 'left'])('pads by env(safe-area-inset-%s)', (side) => {
    expect(stylesCss).toContain(`env(safe-area-inset-${side})`);
  });
});

/**
 * The body of the top-level `:root { … }` block: the one starting at the beginning of a line, so
 * a `:root` indented inside an `@media` block (a dark palette, say) is not mistaken for it.
 */
function rootBlock(css: string): string {
  const match = /^:root\s*\{([\s\S]*?)^\}/m.exec(css);
  if (!match?.[1]) throw new Error('styles.css has no top-level :root block');
  return match[1];
}

/** Every `--name: #rrggbb` custom property of a block, keyed by name without the dashes. */
function hexTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, hex] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (name && hex) tokens.set(name, hex.toLowerCase());
  }
  return tokens;
}

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, from 1 (same) to 21 (black on white). */
function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal-size text. */
const AA_TEXT = 4.5;

const rootTokens = hexTokens(rootBlock(stylesCss));

/** Text colour on background colour, as token names, for every pair the screens use. */
const TEXT_PAIRS: [foreground: string, background: string][] = [
  ['ink', 'bg'],
  ['ink', 'card'],
  ['muted', 'bg'],
  ['muted', 'card'],
  ['brand', 'brand-soft'],
  ['white', 'brand'],
  ['white', 'brand-2'],
  ['green', 'green-soft'],
  ['amber', 'amber-soft'],
  ['error', 'card'],
];

describe('styles.css colour contrast', () => {
  it('computes WCAG contrast correctly, and a weak shade falls below AA', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // The old brand gray (spec §7) as text on white: the kind of colour this test must refuse.
    expect(contrastRatio('#9aa3ad', '#ffffff')).toBeLessThan(AA_TEXT);
  });

  it.each(TEXT_PAIRS)('--%s on --%s reaches WCAG AA (4.5:1)', (foreground, background) => {
    const foregroundHex = rootTokens.get(foreground);
    const backgroundHex = rootTokens.get(background);
    expect(foregroundHex, `--${foreground} is a #rrggbb colour in :root`).toBeDefined();
    expect(backgroundHex, `--${background} is a #rrggbb colour in :root`).toBeDefined();
    expect(contrastRatio(foregroundHex ?? '', backgroundHex ?? '')).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the old colour names as aliases of the dawn tokens', () => {
    // Screens still use the pre-ADR-0011 names until each one moves to the new ones.
    const root = rootBlock(stylesCss);
    for (const [oldName, newName] of [
      ['color-background', 'bg'],
      ['color-text', 'ink'],
      ['color-accent', 'brand-soft'],
      ['color-white', 'white'],
      ['color-gray', 'line'],
      ['color-muted', 'muted'],
      ['color-error', 'error'],
      ['color-handled', 'done'],
    ]) {
      expect(root).toContain(`--${oldName}: var(--${newName});`);
      expect(rootTokens.has(newName ?? ''), `--${newName ?? ''} is defined`).toBe(true);
    }
  });
});
