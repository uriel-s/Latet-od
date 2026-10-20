// The one-time message under a list's heading ("ההזמנה נוספה."), drawn by the orders and rounds
// tabs. The hook that reads it from the history state is in flashNotice.ts.
import { useEffect, useRef } from 'react';
import { useFlashNotice } from './flashNotice.ts';

/**
 * The notice the previous screen sent along, or nothing. Framed like the customer page's notices
 * (`order-notice`). A live region that appears with its text already inside is often not read, so
 * the message also takes focus (tabIndex -1: from code only), like the customer page's notices;
 * App leaves focus on it rather than moving it to the heading (pageChange.ts).
 */
export function FlashNotice() {
  const notice = useFlashNotice();
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus({ preventScroll: true });
  }, [notice]);

  if (notice === null) return null;
  return (
    <p ref={noticeRef} className="order-notice" role="status" tabIndex={-1}>
      {notice}
    </p>
  );
}
