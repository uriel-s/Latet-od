// A one-time message that crosses a navigation: "ההזמנה נשמרה" is told by the list the save sends
// Yoel back to, not by the form that is already gone. It rides in the history state (router.tsx),
// so no module-level state is shared, and the list clears it after reading so a reload or the back
// button does not show it again.
import { useState } from 'react';

/** The history state a screen passes to `navigate` to have the next screen tell `notice`. */
export interface FlashNoticeState {
  notice: string;
}

/** What each write of the collector app announces on the screen it returns to. */
export const FLASH_NOTICES = {
  orderAdded: 'ההזמנה נוספה.',
  orderSaved: 'השינויים נשמרו.',
  orderCancelled: 'ההזמנה בוטלה.',
  roundPlanned: 'הסבב נוצר.',
} as const;

/** The navigation state that asks the next screen to show `notice`. */
export function flashNoticeState(notice: string): FlashNoticeState {
  return { notice };
}

function noticeOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('notice' in state)) return null;
  return typeof state.notice === 'string' ? state.notice : null;
}

/**
 * The notice the screen was navigated to with, or null. Read once, when the screen mounts, and
 * cleared from the history entry right away (without a re-render: the text is already kept).
 */
export function useFlashNotice(): string | null {
  const [notice] = useState<string | null>(() => {
    const found = noticeOf(window.history.state);
    // Only the notice is dropped; the URL stays. replaceState does not notify useLocation, and
    // its snapshot compares `history.state` on every read, so the next render sees the clear.
    if (found !== null) window.history.replaceState(null, '', window.location.href);
    return found;
  });
  return notice;
}
