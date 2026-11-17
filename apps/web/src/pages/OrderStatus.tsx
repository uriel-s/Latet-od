import { formatDayMonth, t, type CustomerOrder, type Lang } from '@bottlerun/shared';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TIME_PLACEHOLDERS, tWithDay, timesText } from './bidiText.tsx';

/**
 * The status in plain words, and what it means for the customer now (spec §3.3): one card at the
 * top of the page, the status as a large badge and the sentence that explains it under it, so the
 * customer reads both together.
 */
export function OrderStatus({ order, lang }: { order: CustomerOrder; lang: Lang }) {
  return (
    <div className="order-status-card card">
      <p className="order-status">
        {t(lang, 'orderPage.status')} <StatusBadge status={order.status} lang={lang} />
      </p>
      <StatusText order={order} lang={lang} />
    </div>
  );
}

/**
 * The lines under the status. The round's date and times show for an order in a round
 * (`confirmed`) only, and only when the api sent the round: an order whose
 * round is gone has no date to promise. With both times, the first is when the bottles must be
 * out and the window is when Yoel comes (ADR-0012), so the start time is said twice.
 */
function StatusText({ order, lang }: { order: CustomerOrder; lang: Lang }) {
  const { round } = order;
  switch (order.status) {
    case 'waiting':
      return <p>{t(lang, 'orderPage.waiting')}</p>;
    case 'confirmed':
      if (round === undefined) return null;
      return (
        <>
          <p>
            {/* DD/MM and HH:MM read left to right inside the right-to-left text (CLAUDE.md). */}
            {tWithDay(lang, 'orderPage.roundDate', formatDayMonth(round.date, lang))}
          </p>
          {round.pickupBy !== undefined && (
            <p>
              {round.pickupFrom !== undefined
                ? timesText(t(lang, 'orderPage.pickupWindow', TIME_PLACEHOLDERS), [
                    round.pickupFrom,
                    round.pickupFrom,
                    round.pickupBy,
                  ])
                : timesText(t(lang, 'orderPage.pickupBy', TIME_PLACEHOLDERS), [round.pickupBy])}
            </p>
          )}
        </>
      );
    case 'collected':
      return <p>{t(lang, 'orderPage.collected')}</p>;
    case 'cancelled':
      // Thanks (spec §3.3), not "ההזמנה בוטלה.": the status line already says it, and so does
      // the notice announced right after the customer's own cancel.
      return <p>{t(lang, 'orderPage.cancelled')}</p>;
  }
}
