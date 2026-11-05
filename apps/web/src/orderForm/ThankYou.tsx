// The thank-you screen (spec §3.2). OrderFormPage shows it in place of the form once the order is
// in, at the same URL `/`; its one button leads to the customer's own page `/o/<token>` (§3.3).
import { useEffect, useRef } from 'react';
import { BOTTLE_VALUE_AGOROT, DEFAULT_LANG, formatShekels, t, type Lang } from '@bottlerun/shared';
import { Link } from '../router.tsx';

/**
 * Thanks the customer and links to their order page, where they can see or cancel the order.
 * Renders the page's only `<h1>` (Layout's heading rule), which receives focus when the screen
 * appears.
 *
 * @param token The order's secret from the 201 answer: the only way to reach `/o/<token>`.
 * @param bottlesEstimated The customer's estimate from the form; the donation line shows its worth.
 * @param lang The language of the texts (the English form passes 'en'). The link leads to the
 *   customer's page, which is Hebrew.
 */
export function ThankYou({
  token,
  bottlesEstimated,
  lang = DEFAULT_LANG,
}: {
  token: string;
  bottlesEstimated: number;
  lang?: Lang;
}) {
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
        {t(lang, 'thankYou.title')}
      </h1>
      <p>{t(lang, 'thankYou.body')}</p>
      {/* An estimate, so "about"; the value per bottle is the shared constant, never a literal. */}
      <p className="card thank-you-donation">
        {t(lang, 'thankYou.donation', {
          bottles: bottlesEstimated,
          amount: formatShekels(bottlesEstimated * BOTTLE_VALUE_AGOROT),
        })}
      </p>
      <Link to={`/o/${token}`} className="button button-primary button-block">
        {t(lang, 'thankYou.viewOrder')}
      </Link>
    </>
  );
}
