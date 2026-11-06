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
//    its text and its background (so does every round tile), badge text is never shrunk below
//    1rem, and the round .call-button is a full tap target.
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

/** WCAG 1.4.11: the frame of a control against what is next to it. */
const NON_TEXT = 3;

/** The tokens of the dark palette: the :root inside `@media (prefers-color-scheme: dark)`. */
function darkBlock(css: string): string {
  const match = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n {2}\}/.exec(
    css,
  );
  if (!match?.[1]) throw new Error('styles.css has no dark-mode :root block');
  return match[1];
}

/** The `#rrggbb N%` colour stops of a block's `--hdr` linear-gradient, in order. */
function headerGradientStops(block: string): { hex: string; percent: number }[] {
  const gradient = /--hdr:([^;]*);/.exec(block)?.[1] ?? '';
  return [...gradient.matchAll(/(#[0-9a-f]{6})\s+(\d+(?:\.\d+)?)%/gi)].map(([, hex, percent]) => ({
    hex: (hex ?? '').toLowerCase(),
    percent: Number(percent),
  }));
}

/** The `#rrggbb` colour a linear gradient shows at `percent`, mixed in sRGB as browsers do. */
function gradientColourAt(stops: { hex: string; percent: number }[], percent: number): string {
  const after = stops.findIndex((stop) => stop.percent >= percent);
  const to = stops[after === -1 ? stops.length - 1 : after];
  const from = stops[Math.max(0, after - 1)];
  if (!from || !to) throw new Error('a gradient needs colour stops');
  const span = to.percent - from.percent;
  const share = span === 0 ? 0 : (percent - from.percent) / span;
  return `#${[1, 3, 5]
    .map((start) => {
      const [a, b] = [from.hex, to.hex].map((hex) => parseInt(hex.slice(start, start + 2), 16));
      return Math.round((a ?? 0) + ((b ?? 0) - (a ?? 0)) * share)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

const rootTokens = hexTokens(rootBlock(stylesCss));
const darkTokens = hexTokens(darkBlock(stylesCss));

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
  ['error', 'card'], // .button-danger-outline, the opening "ביטול ההזמנה"
  ['error', 'bg'], // .button-danger-quiet: no fill of its own, so the page shows through
  ['white', 'error'], // .button-danger
  ['ink', 'done'], // a disabled or busy .button, a handled stop card
  ['brand', 'card'], // .button-secondary in the site header
  ['brand', 'bg'], // .back-link: a chevron and a word, no fill of its own
  ['muted', 'done'], // .badge-gray
  ['green', 'card'], // "נפתח ✓" as plain text in a grouped send list (.grouped-list .send-row-mark)
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

  it.each(TEXT_PAIRS)('dark: --%s on --%s reaches WCAG AA (4.5:1)', (foreground, background) => {
    const foregroundHex = darkTokens.get(foreground);
    const backgroundHex = darkTokens.get(background);
    expect(foregroundHex, `--${foreground} is a #rrggbb colour in the dark block`).toBeDefined();
    expect(backgroundHex, `--${background} is a #rrggbb colour in the dark block`).toBeDefined();
    expect(contrastRatio(foregroundHex ?? '', backgroundHex ?? '')).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('redefines every light colour token in the dark block, except the always-light ones', () => {
    // A token left out would keep its light value on a dark page. --on-hdr stays light on purpose.
    const missing = [...rootTokens.keys()].filter(
      (name) => name !== 'on-hdr' && !darkTokens.has(name),
    );
    expect(missing).toEqual([]);
  });

  // The header's white text sits anywhere from the top to the lower corner, where the gradient is
  // lightest: the slogan (1.1rem, not bold, so 4.5:1) ends in that corner in RTL. So every colour
  // the header actually shows, from 0% to 100%, must be AA; the warm stop past 100% may be lighter.
  it.each([
    ['light', rootBlock(stylesCss)],
    ['dark', darkBlock(stylesCss)],
  ])('keeps the header text readable over the whole %s header gradient', (_mode, block) => {
    const stops = headerGradientStops(block);
    expect(stops.length).toBeGreaterThan(1);
    const onHeader = rootTokens.get('on-hdr') ?? '';
    for (let percent = 0; percent <= 100; percent += 5) {
      expect(contrastRatio(onHeader, gradientColourAt(stops, percent))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });

  // The history tab's "שווי" hero tile: its text colour must be AA on every token its gradient
  // runs through, in both palettes. Read from the rules, so a changed gradient or text colour is
  // checked too; the colours between the stops are sampled every 5%, as for the header.
  it.each([
    ['light', rootTokens],
    ['dark', darkTokens],
  ])('keeps the history hero tile text AA on its gradient (%s)', (_mode, tokens) => {
    const background = ruleBody(stylesCss, '.history-total-hero');
    const gradientTokens = [
      ...(/background:\s*linear-gradient\(([^;]*)\);/.exec(background)?.[1] ?? '').matchAll(
        /var\(--([a-z0-9-]+)\)/g,
      ),
    ].map(([, name]) => name ?? '');
    expect(gradientTokens.length).toBeGreaterThan(1);
    const textToken = /color:\s*var\(--([a-z0-9-]+)\)/.exec(
      ruleBody(stylesCss, '.history-total-hero dt, .history-total-hero dd'),
    )?.[1];
    expect(textToken).toBeDefined();
    const textHex = tokens.get(textToken ?? '') ?? '';
    const stops = gradientTokens.map((name, index) => ({
      hex: tokens.get(name) ?? '',
      percent: (index / (gradientTokens.length - 1)) * 100,
    }));
    for (const stop of stops) expect(stop.hex, 'a #rrggbb gradient token').toMatch(/^#/);
    for (let percent = 0; percent <= 100; percent += 5) {
      expect(contrastRatio(textHex, gradientColourAt(stops, percent))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });

  // An unchosen choice card ("איפה הבקבוקים", the region, the customer language) has no fill of
  // its own: its frame is the only thing that shows where to tap, so it needs 3:1 (WCAG 1.4.11).
  it.each([
    ['light', rootTokens],
    ['dark', darkTokens],
  ])('frames an unchosen .choice-card at 3:1 or more on --card (%s)', (_mode, tokens) => {
    const borderToken = /border:\s*\S+\s+solid\s+var\(--([a-z0-9-]+)\)/.exec(
      ruleBody(stylesCss, '.choice-card'),
    )?.[1];
    expect(borderToken, 'the .choice-card border is a token').toBeDefined();
    const borderHex = tokens.get(borderToken ?? '') ?? '';
    expect(borderHex).toMatch(/^#/);
    expect(contrastRatio(borderHex, tokens.get('card') ?? '')).toBeGreaterThanOrEqual(NON_TEXT);
  });

  // Text fields keep their dark frame (--color-text), never the decorative --line.
  it('frames the text fields with the text colour, not --line', () => {
    // Read by hand: the comma inside :not(…) would split ruleBody's selector list.
    const fieldRule =
      /input:not\(\[type='radio'\], \[type='checkbox'\]\),\s*select,\s*textarea\s*\{([^}]*)\}/.exec(
        stylesCss,
      )?.[1];
    expect(fieldRule).toBeDefined();
    expect(fieldRule).toContain('border: 2px solid var(--color-text);');
  });

  it('declares color-scheme: light dark', () => {
    expect(rootBlock(stylesCss)).toContain('color-scheme: light dark;');
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

  // The destructive variants only colour a .button; a height of their own could undercut the 48px.
  it.each(['.button-danger-outline', '.button-danger-quiet'])(
    'leaves the height of %s to .button, and gives it --error text',
    (selector) => {
      const variant = ruleBody(stylesCss, selector);
      expect(variant).not.toMatch(/(^|[s;])(min-)?height:/);
      expect(variant).toContain('color: var(--error);');
    },
  );

  it('makes each history month arrow a full --tap-target circle', () => {
    const arrow = ruleBody(stylesCss, '.month-arrow');
    expect(arrow).toContain('width: var(--tap-target);');
    expect(arrow).toContain('height: var(--tap-target);');
  });

  it('greys out a disabled month arrow with no dashed frame', () => {
    const disabled = ruleBody(stylesCss, '.month-arrow:disabled');
    expect(disabled).toContain('color: var(--muted);');
    expect(disabled).not.toContain('dashed');
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

  it.each(['.round-tile-green', '.round-tile-amber', '.round-tile-gray'])(
    'gives %s both a text colour and a background',
    (selector) => {
      const tile = ruleBody(stylesCss, selector);
      expect(tile).toMatch(/(^|[\s;])color:/);
      expect(tile).toMatch(/(^|[\s;])background:/);
    },
  );

  it('makes a .call-button a full --tap-target circle', () => {
    const callButton = ruleBody(stylesCss, '.call-button');
    expect(callButton).toContain('width: var(--tap-target);');
    expect(callButton).toContain('height: var(--tap-target);');
  });

  it('keeps .badge text at 1rem or larger (no text under 18px)', () => {
    // A font-size on .badge, if any, must be exactly 1rem: the mockup's .9rem is too small.
    const fontSize = /font-size:\s*([^;]+);/.exec(ruleBody(stylesCss, '.badge'))?.[1];
    expect(fontSize ?? '1rem').toBe('1rem');
  });
});
