// Runs before every web test file (vite.config.ts, `test.setupFiles`). Vitest runs here without
// globals, so Testing Library cannot register its automatic cleanup; this file does it, and resets
// what tests share through the one jsdom window: saved form details, the URL, and the page's
// visibility (overridden by collector/visibilityTestHelper.ts).
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom has no scrolling: window.scrollTo only logs "not implemented". A spy keeps the log quiet
// and lets a test check that a page change scrolled to the top.
beforeEach(() => {
  // mockClear: spying again returns the same spy, and its calls from an earlier test must not
  // count in this one.
  vi.spyOn(window, 'scrollTo')
    .mockClear()
    .mockImplementation(() => undefined);
});

afterEach(() => {
  // Unmount first, so no rendered component reacts to the reset below.
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  // Drop a visibilityState override, so jsdom's own getter on Document.prototype answers again.
  Reflect.deleteProperty(document, 'visibilityState');
});
