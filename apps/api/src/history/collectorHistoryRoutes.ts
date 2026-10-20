// /api/collector/history: the api of Yoel's "היסטוריה" screen (spec §3.7): one calendar month in
// Israel, its totals (bottles collected, addresses collected, their value) and the orders closed in
// it, collected and cancelled. createApp mounts the router built here AFTER requireCollector, so it
// needs the login (ADR-0004). The shapes and the totals are the shared contract
// (packages/shared/src/historyApi.ts, `buildHistory`); the month's bounds come from
// `monthRangeInAppZone` (packages/shared/src/dates.ts), and the orders are read through OrdersRepo.
import { Router } from 'express';
import {
  buildHistory,
  historyQuerySchema,
  monthRangeInAppZone,
  type HistoryResponse,
  type InvalidMonthErrorBody,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';

/**
 * The router of /api/collector/history. Mount it with
 * `app.use('/api/collector/history', createCollectorHistoryRouter(deps))`, after `requireCollector`
 * (which answers 401 without a session and sets `Cache-Control: no-store` on every answer).
 *
 * GET /?month=YYYY-MM — the month's history:
 * - 200 {@link HistoryResponse}: the month asked for; its totals, counted from the collected orders
 *   only (a cancelled order is listed but counts in none of them); and every order closed in the
 *   month, newest first, without phone or token. An order is in the month its `collectedAt` (or
 *   `cancelledAt`) falls in, in Israel time, so one collected at 23:30 on the last night of a month
 *   is in that month, though it is already the next day in UTC. A month with nothing closed answers
 *   zeros and an empty list.
 * - 400 {@link InvalidMonthErrorBody}: `month` is missing, repeated (`?month=a&month=b`), or not a
 *   `YYYY-MM` with a month 01-12 (`2026-13`, `2026-1`). Other query keys are ignored.
 *
 * Logs nothing: the orders hold names and addresses (CLAUDE.md, privacy). An unexpected error goes
 * to the app's error handler, which logs it without the request and answers 500.
 */
export function createCollectorHistoryRouter(deps: Pick<AppDeps, 'orders'>): Router {
  const { orders } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const body: InvalidMonthErrorBody = { error: 'invalid_month' };
      res.status(400).json(body);
      return;
    }

    const { month } = parsed.data;
    // The repo picks the orders whose closing instant is in [from, to) of the month in Israel;
    // buildHistory only totals and sorts them.
    const closed = await orders.list({ closedBetween: monthRangeInAppZone(month) });
    const body: HistoryResponse = buildHistory(month, closed);
    res.json(body);
  });

  return router;
}
