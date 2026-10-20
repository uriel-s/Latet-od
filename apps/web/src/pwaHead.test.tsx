// Tests for CollectorPwaHead: it adds the collector app's install tags to document.head while
// mounted, and takes away exactly what it added. Which routes render it is covered in App.test.tsx.
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_PWA_HEAD_TAGS, CollectorPwaHead } from './pwaHead.tsx';

/** How many elements in document.head match `selector`. */
function headCount(selector: string): number {
  return document.head.querySelectorAll(selector).length;
}

describe('CollectorPwaHead', () => {
  it('adds the manifest link, the iOS icon and the iOS app metas to document.head', () => {
    render(<CollectorPwaHead />);

    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(
      '/manifest.webmanifest',
    );
    const icon = document.head.querySelector('link[rel="apple-touch-icon"]');
    expect(icon?.getAttribute('href')).toBe('/icon-180.png');
    expect(icon?.getAttribute('sizes')).toBe('180x180');
    expect(metaContent('apple-mobile-web-app-capable')).toBe('yes');
    expect(metaContent('mobile-web-app-capable')).toBe('yes');
    expect(metaContent('apple-mobile-web-app-title')).toBe('לתת עוד');
    // Dark status-bar text over the light header.
    expect(metaContent('apple-mobile-web-app-status-bar-style')).toBe('default');
  });

  it('removes every tag it added on unmount', () => {
    const headBefore = document.head.innerHTML;
    const { unmount } = render(<CollectorPwaHead />);

    unmount();

    expect(document.head.innerHTML).toBe(headBefore);
  });

  it('adds each tag exactly once under StrictMode, whose effects run twice', () => {
    const { unmount } = render(
      <StrictMode>
        <CollectorPwaHead />
      </StrictMode>,
    );

    expect(headCount('link[rel="manifest"]')).toBe(1);
    expect(headCount('link[rel="apple-touch-icon"]')).toBe(1);
    expect(headCount('meta[name="apple-mobile-web-app-capable"]')).toBe(1);

    unmount();
    expect(headCount('link[rel="manifest"], link[rel="apple-touch-icon"]')).toBe(0);
  });

  it('adds every listed tag', () => {
    const headBefore = document.head.children.length;

    render(<CollectorPwaHead />);

    expect(document.head.children.length - headBefore).toBe(COLLECTOR_PWA_HEAD_TAGS.length);
  });
});

/** The `content` of `<meta name="…">` in document.head, or `undefined` when it is missing. */
function metaContent(name: string): string | undefined {
  return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined;
}
