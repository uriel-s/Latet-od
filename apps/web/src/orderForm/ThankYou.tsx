// The thank-you screen (spec §3.2). OrderFormPage shows it in place of the form once the order is
// in, at the same URL `/`; its one button leads to the customer's own page `/o/<token>` (§3.3).
import { useEffect, useRef } from 'react';
import { Link } from '../router.tsx';

/**
 * Thanks the customer and links to their order page, where they can see or cancel the order.
 * Renders the page's only `<h1>` (Layout's heading rule), which receives focus when the screen
 * appears.
 *
 * @param token The order's secret from the 201 answer: the only way to reach `/o/<token>`.
 */
export function ThankYou({ token }: { token: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The form the customer just sent is gone, and with it the button that had focus. Focus moves
  // to the new heading, so a screen reader announces the thanks and the phone scrolls up to it
  // (focus scrolls by itself; no window.scrollTo, which jsdom does not implement).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
      <h1 ref={headingRef} tabIndex={-1}>
        תודה!
      </h1>
      <p>קיבלנו את ההזמנה. לפני הסבב באזור שלך נשלח לך הודעת WhatsApp לאישור.</p>
      <Link to={`/o/${token}`} className="button button-primary button-block">
        לצפייה בהזמנה או לביטול
      </Link>
    </>
  );
}
