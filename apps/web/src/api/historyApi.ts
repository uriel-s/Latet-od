// The collector's history endpoint: GET /api/collector/history?month=YYYY-MM (spec §3.7,
// "היסטוריה"). Sent through `request()` (request.ts), which handles what every endpoint shares.
//
// Behind the login like the other collector routes, with the same rules: a 401 is `loggedOut`,
// nothing is retried, and the success body is parsed with the shared schema.
import { historyResponseSchema, type HistoryResponse } from '@bottlerun/shared';
import { FRESH_GET, globalFetch, parsed, request, type FetchFn } from './request.ts';

/** How GET /api/collector/history ended, as the "היסטוריה" tab shows it. */
export type HistoryOutcome =
  /** 200: the month's totals and its closed orders, newest first (`closedAt` a Date). */
  | { kind: 'loaded'; history: HistoryResponse }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /**
   * No usable answer: a network error, a 5xx, or a 200 the app cannot read. A 400
   * (`invalid_month`) is `failed` too: the screen's picker only builds valid months, so it is a
   * client bug, and Yoel can do nothing about it but try again.
   */
  | { kind: 'failed' };

/**
 * Loads one calendar month's history (`YYYY-MM`, a month in Israel) from
 * `GET /api/collector/history?month=`, past the browser cache: the current month changes with
 * every "אספתי". The month is encoded, so whatever the caller passes stays one query value.
 */
export async function fetchHistory(
  month: string,
  fetchFn: FetchFn = globalFetch,
): Promise<HistoryOutcome> {
  return request<HistoryOutcome>(fetchFn, {
    path: `/api/collector/history?month=${encodeURIComponent(month)}`,
    init: FRESH_GET,
    behindLogin: true,
    on: { 200: parsed(historyResponseSchema, (history) => ({ kind: 'loaded', history })) },
  });
}
