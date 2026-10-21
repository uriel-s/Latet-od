// The contract of GET /api/collector/history?month=YYYY-MM (spec §3.7, the collector app's
// "היסטוריה" screen): a month's totals (bottles collected, addresses collected, their value) and
// the list of orders closed in that month, collected and cancelled, with the error body of a bad
// month. The route is behind requireCollector (ADR-0004). apps/api implements it with these
// schemas and `buildHistory`, and apps/web's screen parses the answer with them, so the two sides
// agree on one definition. The month is a calendar month in Israel (dates.ts).
import { z } from 'zod';
import { BOTTLE_VALUE_AGOROT } from './config.ts';
import { calendarMonthSchema } from './dates.ts';
import { addressSchema, orderSchema, timestampSchema, type Order } from './order.ts';

// ---------------------------------------------------------------------------------------------
// Closed orders
// ---------------------------------------------------------------------------------------------

/**
 * The statuses of a "closed" order: the two final ones (spec §4). The history lists exactly these;
 * an order still open (waiting, pending, confirmed) has not closed in any month yet.
 */
export const HISTORY_ORDER_STATUSES = ['collected', 'cancelled'] as const;
export type HistoryOrderStatus = (typeof HISTORY_ORDER_STATUSES)[number];

/**
 * When an order closed: the instant that decides the month it is listed (and, if collected,
 * counted) in.
 *
 * - A collected order closed at `collectedAt`, set on "אספתי".
 * - A cancelled order closed at `cancelledAt`. Both cancel routes set it, the collector's and the
 *   customer's, and a repeated cancel never rewrites it, so the month stays the month it was first
 *   cancelled in.
 *
 * Not `updatedAt`: a later write (such as a message log entry) would move the order to another
 * month. Returns `undefined` for an open order, and for a closed one that lacks its timestamp (a
 * broken document), which the history then leaves out rather than guessing a month for it.
 */
export function closedAtOf(order: Order): Date | undefined {
  if (order.status === 'collected') return order.collectedAt;
  if (order.status === 'cancelled') return order.cancelledAt;
  return undefined;
}

/**
 * One closed order in the history list. An allow-list built from the stored order's own field
 * schemas (like `collectorOrderSchema`): zod strips unknown keys, also inside `contact` and
 * `address`, so parsing a whole stored order keeps only these. Left out on purpose: the phone and
 * the token (the list needs neither, and a customer's private data stays where it is needed), the
 * message log, the region, and the rest of the address (bottles spot, floor, note).
 *
 * `closedAt` is {@link closedAtOf}, required: the screen shows it as DD/MM. It uses the stored
 * order's timestamp schema, so the ISO string the api's JSON carries parses back into a `Date` on
 * the web.
 */
export const historyOrderSchema = z.object({
  id: orderSchema.shape.id,
  status: z.enum(HISTORY_ORDER_STATUSES),
  contact: orderSchema.shape.contact.pick({ name: true }),
  address: addressSchema.pick({ streetName: true, houseNumber: true }),
  bottlesEstimated: orderSchema.shape.bottlesEstimated,
  /** What Yoel recorded on "אספתי"; absent on a cancelled order. */
  bottlesCollected: orderSchema.shape.bottlesCollected,
  closedAt: timestampSchema,
});
export type HistoryOrder = z.infer<typeof historyOrderSchema>;

// ---------------------------------------------------------------------------------------------
// Totals and the response
// ---------------------------------------------------------------------------------------------

/**
 * A month's totals (spec §3.7). Only collected orders count; a cancelled order counts in none of
 * them, though it is listed.
 *
 * - `bottlesCollected`: the sum of the recorded `bottlesCollected` (not the estimates).
 * - `addressesCollected`: the number of collected orders. One order is one address visited, so a
 *   customer collected twice in the month counts twice: those are two pickups.
 * - `valueAgorot`: `bottlesCollected` × `BOTTLE_VALUE_AGOROT`, in whole agorot so the sum never
 *   meets float rounding; {@link formatShekels} turns it into text.
 */
export const historyTotalsSchema = z.object({
  bottlesCollected: z.int().nonnegative(),
  addressesCollected: z.int().nonnegative(),
  valueAgorot: z.int().nonnegative(),
});
export type HistoryTotals = z.infer<typeof historyTotalsSchema>;

/**
 * Body of a 200 from GET /api/collector/history: the month asked for, its totals, and its closed
 * orders newest first. The web parses the api's JSON with it, so `closedAt` arrives as a `Date`.
 * See {@link buildHistory}.
 */
export const historyResponseSchema = z.object({
  month: calendarMonthSchema,
  totals: historyTotalsSchema,
  orders: z.array(historyOrderSchema),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * The query of GET /api/collector/history, what the route validates `req.query` with. `month` is
 * required: a missing one fails, and so does a repeated one (`?month=a&month=b` reaches Express as
 * an array, not a string). The web always sends one; it starts on the current month in Israel.
 */
export const historyQuerySchema = z.object({
  month: calendarMonthSchema,
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/**
 * The history of a month (spec §3.7), from that month's closed orders. Pure, and here rather than
 * in the api, so it is tested once without a database.
 *
 * The caller passes the month's closed orders: the repo already picked those whose
 * {@link closedAtOf} falls in the month (`monthRangeInAppZone`). This function does not filter by
 * month again; it only drops, defensively, an order that is not collected or cancelled, or has no
 * closing timestamp. Totals come from the collected orders only; one missing `bottlesCollected`
 * adds 0, since the spec counts the recorded count. The list is newest `closedAt` first, ties in
 * input order, each item reduced to {@link historyOrderSchema}.
 */
export function buildHistory(month: string, closedOrders: readonly Order[]): HistoryResponse {
  const closed = closedOrders.flatMap((order) => {
    const closedAt = closedAtOf(order);
    return closedAt === undefined ? [] : [{ order, closedAt }];
  });

  const collected = closed.filter(({ order }) => order.status === 'collected');
  const bottlesCollected = collected.reduce(
    (total, { order }) => total + (order.bottlesCollected ?? 0),
    0,
  );

  // Array.prototype.sort is stable, so orders closed at the same instant keep the input order.
  const newestFirst = [...closed].sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());

  return {
    month,
    totals: {
      bottlesCollected,
      addressesCollected: collected.length,
      valueAgorot: bottlesCollected * BOTTLE_VALUE_AGOROT,
    },
    orders: newestFirst.map(({ order, closedAt }) =>
      historyOrderSchema.parse({ ...order, closedAt }),
    ),
  };
}

/**
 * Whole agorot as the text Yoel reads: '0 ₪', '12 ₪' for whole shekels, '9.60 ₪' otherwise
 * (always two decimals then). Integer arithmetic only, so 960 agorot never prints as 9.6000001.
 * The shekel sign follows the number; the web wraps the text in a `dir="ltr"` element so the RTL
 * page does not reorder it.
 *
 * @throws RangeError for a value that is not a whole, non-negative, safe integer.
 */
export function formatShekels(agorot: number): string {
  if (!Number.isSafeInteger(agorot) || agorot < 0) {
    throw new RangeError('formatShekels: expected a whole, non-negative number of agorot');
  }
  const shekels = Math.floor(agorot / 100);
  const remainder = agorot % 100;
  if (remainder === 0) return `${shekels} ₪`;
  return `${shekels}.${String(remainder).padStart(2, '0')} ₪`;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

// The body below follows ApiErrorBody (index.ts): a stable `error` code. Standalone, like the other
// *Api.ts files, because index.ts re-exports this file and importing back from it would be
// circular.

/**
 * 400 from GET /api/collector/history: `month` is missing, repeated, or not a `YYYY-MM` with a
 * month 01-12. Yoel never types the month (the screen's picker sets it), so there is no Hebrew
 * message: it is a client bug.
 */
export interface InvalidMonthErrorBody {
  error: 'invalid_month';
}
