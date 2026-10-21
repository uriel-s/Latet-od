// Runs before every web test file (vite.config.ts, `test.setupFiles`). Vitest runs here without
// globals, so Testing Library cannot register its automatic cleanup; this file does it, and resets
// what tests share through the one jsdom window: saved form details, the URL, and the page's
// visibility (overridden by collector/visibilityTestHelper.ts).
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  // Unmount first, so no rendered component reacts to the reset below.
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  // Drop a visibilityState override, so jsdom's own getter on Document.prototype answers again.
  Reflect.deleteProperty(document, 'visibilityState');
});
