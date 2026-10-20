// What a screen reader and the eye need after a client-side navigation, which the browser does not
// do for a pushState: start at the top, tell the new page's name, and put focus on its heading.
// Called by App on every path change except the first load (the browser handles that one).

/** The tab title: the page's heading and the app's name, or the app's name alone. */
export function pageTitle(heading: string | null, appName: string): string {
  const name = heading?.trim() ?? '';
  return name === '' ? appName : `${name} | ${appName}`;
}

/**
 * Sets the tab title from the page's `<h1>` and focuses the `<h1>` (tabIndex -1: focusable from
 * code, never a Tab stop) so a screen reader reads where it landed. Focus is left alone when the
 * page already put it on a form field or a message, which is a better place than the heading.
 * Returns the `<h1>` it announced, or null when the page has none yet.
 */
function announceHeading(appName: string): HTMLElement | null {
  const heading = document.querySelector('main h1');
  document.title = pageTitle(heading?.textContent ?? null, appName);

  const focused = document.activeElement;
  const pageMovedFocus =
    focused instanceof HTMLElement &&
    focused !== document.body &&
    focused.closest('main') !== null &&
    (focused.matches('input, textarea, select') || focused.tabIndex === -1);
  if (!(heading instanceof HTMLElement)) return null;
  if (!pageMovedFocus) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  return heading;
}

/**
 * Brings the new page into view: scrolls to the top, then titles the tab and focuses the heading
 * ({@link announceHeading}).
 *
 * A screen that loads in stages (the collector app shows "אפליקציית האוסף" while it checks the
 * session, then the screen's own heading) replaces its `<h1>` after this ran: the focused heading
 * is gone and the title is stale. So this watches `<main>` and announces once more when the
 * heading changes. Returns the function that stops watching; App calls it before the next change.
 */
export function announcePageChange(appName: string): () => void {
  window.scrollTo(0, 0);
  const announced = announceHeading(appName);
  const announcedText = announced?.textContent ?? null;

  const main = document.querySelector('main');
  if (main === null) return () => undefined;

  const observer = new MutationObserver(() => {
    const current = document.querySelector('main h1');
    // The same heading with the same words: some other part of the page changed.
    if (current === announced && (current?.textContent ?? null) === announcedText) return;
    observer.disconnect();
    announceHeading(appName);
  });
  observer.observe(main, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
