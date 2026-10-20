// The tags on an order's card in the collector's "הזמנות" tab (spec §3.5): why the order came
// back from its last round ("לא אישר בזמן · 12/11"), and "בלי מיקום" when route planning cannot
// place it (ADR-0005). Plain text, so every badge says what it means in words, never by colour
// alone. Pure, so the words are tested without rendering a screen.
import {
  MISS_REASON_LABELS,
  formatDayMonth,
  type CollectorOrder,
  type LastMiss,
} from '@bottlerun/shared';

/**
 * The tag of an order whose address has no map point, from neither its near street nor its street
 * (ADR-0005). Route planning puts such a stop last, so the tag tells Yoel to pick a near street
 * ("רחוב קרוב") before he plans a round.
 */
export const NO_LOCATION_TAG = 'בלי מיקום';

/**
 * The tag of an order that came back from a round uncollected: the reason in the shared words
 * (the single source of that text), then the round's day as DD/MM, e.g. "לא אישר בזמן · 12/11".
 * `lastMiss.date` is already a day in Israel, so it is reformatted, not converted.
 */
export function lastMissTag(lastMiss: LastMiss): string {
  return `${MISS_REASON_LABELS[lastMiss.reason]} · ${formatDayMonth(lastMiss.date)}`;
}

/**
 * The tags of one order, in the order the card shows them: the last round's miss first (what
 * happened to this order), then "בלי מיקום" (what Yoel should fix). Empty when neither applies.
 */
export function orderTags(order: Pick<CollectorOrder, 'lastMiss' | 'hasLocation'>): string[] {
  const tags: string[] = [];
  if (order.lastMiss !== undefined) tags.push(lastMissTag(order.lastMiss));
  if (!order.hasLocation) tags.push(NO_LOCATION_TAG);
  return tags;
}
