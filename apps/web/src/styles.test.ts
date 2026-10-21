// A cheap guard on styles.css: index.html sets viewport-fit=cover, so the page reaches under the
// notch, the status bar and the home bar, and only the env(safe-area-inset-*) padding keeps text
// and buttons out from under them. jsdom does not lay out or know about safe areas, so this reads
// the file as text: it catches an inset deleted by mistake, not how the page looks on a phone.
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
