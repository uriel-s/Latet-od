// Cheap guards on styles.css, which jsdom does not lay out, so this reads the file as text.
// 1. Safe areas: index.html sets viewport-fit=cover, so the page reaches under the notch, the
//    status bar and the home bar, and only the env(safe-area-inset-*) padding keeps text and
//    buttons out from under them. This catches an inset deleted by mistake, not how it looks.
// 2. Colour contrast: the "dawn" palette of ADR-0011 is read from the :root block and every
//    text/background pair the screens use must reach WCAG AA (4.5:1), so a colour changed to a
//    weaker shade fails here instead of on Yoel's phone in the sun.
// 3. Tap targets: buttons stay at least --tap-target (48px+) tall, the big button at least 66px,
//    and the press animation respects prefers-reduced-motion.
// 4. Cards and badges: a .card keeps the dawn radius and shadow, every coloured badge sets both
//    its text and its background, and badge text is never shrunk below 1rem.
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
  ['white', 'error'], // .button-danger
  ['ink', 'done'], // a disabled or busy .button, a handled stop card
  ['brand', 'card'], // .button-secondary in the site header
  ['muted', 'done'], // .badge-gray
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

/**
 * The body of the top-level rule whose whole selector list is `selectors`, written at the start
 * of a line right after a blank line, a closing brace or a comment. So `.button` finds
 * `.button { … }` and not `.button:active`, a `.button` indented inside `@media`, or the `button`
 * that ends `input, select, textarea, button { … }`. A list is passed as `a, b` and matches any
 * whitespace or line break after each comma in the file.
 */
function ruleBody(css: string, selectors: string): string {
  const pattern = selectors
    .split(/,\s*/)
    .map((selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(',\\s*');
  const ruleStart = String.raw`(?<=(?:^|\}|\*/|\n)[ \t]*\n)`;
  const match = new RegExp(String.raw`${ruleStart}${pattern}\s*\{([^}]*)\}`).exec(css);
  if (!match?.[1]) throw new Error(`styles.css has no top-level rule for ${selectors}`);
  return match[1];
}

describe('styles.css tap targets', () => {
  it('keeps every <button> at least --tap-target tall', () => {
    expect(ruleBody(stylesCss, 'button')).toContain('min-height: var(--tap-target);');
  });

  it('keeps a .button (also a link styled as one) at least --tap-target tall', () => {
    expect(ruleBody(stylesCss, '.button')).toContain('min-height: var(--tap-target);');
  });

  it('makes the big button at least 66px tall', () => {
    expect(ruleBody(stylesCss, '.button-big, .button-large')).toMatch(/min-height:[^;]*66px/);
  });

  it('turns the press animation off for prefers-reduced-motion', () => {
    expect(stylesCss).toContain('prefers-reduced-motion: reduce');
  });
});

describe('styles.css cards and badges', () => {
  it('rounds a .card with --r-lg and lifts it with --shadow-1', () => {
    const card = ruleBody(stylesCss, '.card');
    expect(card).toContain('border-radius: var(--r-lg);');
    expect(card).toContain('box-shadow: var(--shadow-1);');
  });

  it.each(['.badge-green', '.badge-amber', '.badge-gray'])(
    'gives %s both a text colour and a background',
    (selector) => {
      const badge = ruleBody(stylesCss, selector);
      expect(badge).toMatch(/(^|[\s;])color:/);
      expect(badge).toMatch(/(^|[\s;])background:/);
    },
  );

  it('keeps .badge text at 1rem or larger (no text under 18px)', () => {
    // A font-size on .badge, if any, must be exactly 1rem: the mockup's .9rem is too small.
    const fontSize = /font-size:\s*([^;]+);/.exec(ruleBody(stylesCss, '.badge'))?.[1];
    expect(fontSize ?? '1rem').toBe('1rem');
  });
});
