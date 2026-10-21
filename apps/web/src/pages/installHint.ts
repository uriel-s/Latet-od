// Decides whether `/login` shows Yoel how to install the collector app on his iPhone (ADR-0006).
// Safari has no install prompt: "Add to Home Screen" is hidden inside the Share menu, so a short
// pointer is the only way he finds it. Pure, so it is tested without stubbing the real navigator.

/** The install line shown on `/login`. The arrow points left, which reads as "then" in RTL. */
export const INSTALL_HINT_TEXT = 'להתקנה: שיתוף ← הוסף למסך הבית';

/**
 * The parts of `navigator` the decision reads. `standalone` is iOS Safari's own, non-standard
 * flag (true when the page runs as the installed home-screen app) and is not in TypeScript's
 * `Navigator` type, so it is declared optional here: everywhere else it is simply absent.
 */
export type InstallHintNavigator = Pick<Navigator, 'userAgent'> & { readonly standalone?: boolean };

/**
 * True only on an iPhone, outside the installed app.
 *
 * - iPhone only: Yoel is on an iPhone. An iPad is out of scope (iPadOS Safari reports itself as a
 *   Mac anyway), and Android and desktop browsers install through their own menu or prompt, so
 *   there the Share-menu instructions would be wrong.
 * - Not standalone: the installed app is already on the home screen and has no Share button, so
 *   the line would be noise there.
 */
export function shouldShowInstallHint(browser: InstallHintNavigator): boolean {
  return /iPhone/.test(browser.userAgent) && browser.standalone !== true;
}
