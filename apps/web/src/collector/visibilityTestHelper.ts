// Test helper for useReloadOnReturn and the screens that use it (or must not): plays the browser
// hiding and showing the page, as when Yoel switches to WhatsApp and back. jsdom's
// document.visibilityState is fixed at 'visible', so this overrides it on the document; testSetup.ts
// drops the override after every test. Imported by tests only, so never part of the app's bundle.
import { act } from '@testing-library/react';

/** Sets `document.visibilityState` to `state` and fires `visibilitychange`, as the browser does. */
export function changeVisibility(state: DocumentVisibilityState): void {
  // In act, so the state updates a listener makes are applied before the test looks.
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Yoel leaves the app and comes back to it: the page is hidden, then visible again. */
export function returnToApp(): void {
  changeVisibility('hidden');
  changeVisibility('visible');
}
