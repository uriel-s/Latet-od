// What a screen reader and the eye need after a client-side navigation, which the browser does not
// do for a pushState: start at the top, tell the new page's name, and put focus on its heading.
// Called by App on every path change except the first load (the browser handles that one).

/** The tab title: the page's heading and the app's name, or the app's name alone. */
export function pageTitle(heading: string | null, appName: string): string {
  const name = heading?.trim() ?? '';
  return name === '' ? appName : `${name} | ${appName}`;
}

/**
 * Brings the new page into view: scrolls to the top, sets the tab title from the page's `<h1>`,
 * and focuses the `<h1>` (tabIndex -1: focusable from code, never a Tab stop) so a screen reader
 * reads where it landed. Focus is left alone when the page already put it on a form field or a
 * message, which is a better place than the heading.
 */
export function announcePageChange(appName: string): void {
  window.scrollTo(0, 0);
  const heading = document.querySelector('main h1');
  document.title = pageTitle(heading?.textContent ?? null, appName);

  const focused = document.activeElement;
  const pageMovedFocus =
    focused instanceof HTMLElement &&
    focused !== document.body &&
    focused.closest('main') !== null &&
    (focused.matches('input, textarea, select') || focused.tabIndex === -1);
  if (heading instanceof HTMLElement && !pageMovedFocus) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
