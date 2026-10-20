// The stop actions of Yoel's route screen (spec §3.6 step 2): "אספתי" on one stop of a routed
// round, which moves its order to `collected` and sends the customer a thank-you (ADR-0003).
// createApp mounts the router built here on /api/collector/rounds, next to the round routes
// (collectorRoundsRoutes.ts) and like them AFTER requireCollector, so every route needs the login
// (ADR-0004). The shapes are the shared contract (packages/shared/src/roundsApi.ts); a stop's state
// is derived from its order (roundStopStateOf), so an action changes only the order, never the
// round, and the thank-you goes through messages/sendAndLog.ts.
import { Router } from 'express';
import {
  buildRoundView,
  canTransition,
  collectStopRequestSchema,
  formFieldErrors,
  roundStopStateOf,
  type CollectStopRequest,
  type Round,
  type RoundView,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { orderMessage, sendAndLog } from '../messages/sendAndLog.ts';
import {
  sendInvalidCollect,
  sendInvalidTransition,
  sendOrderNotFound,
  sendRoundNotFound,
  sendRouteNotOpen,
  sendStopHandled,
  sendView,
} from './roundResponses.ts';

/**
 * The stop actions under /api/collector/rounds. Mount it with
 * `app.use('/api/collector/rounds', createCollectorStopActionsRouter(deps))`, after the Origin
 * check, the JSON body parser and `requireCollector` (which answers 401 without a session and sets
 * `Cache-Control: no-store` on every answer).
 *
 * POST /:id/stops/:orderId/collected — "אספתי" (spec §3.6 step 2); body
 * `collectStopRequestSchema` (`{ bottlesCollected?: number }`; no body counts as `{}`):
 * - 200 {@link RoundView}: the order is now `collected` (it keeps its `roundId`), with
 *   `bottlesCollected` (the count sent, or its `bottlesEstimated` when none was) and `collectedAt`,
 *   and a `thankYou` was sent and logged. The collected stop's `thankYou` is the "שלח תודה" row:
 *   the wa.me link, or no key when the send failed (the order is collected all the same).
 * - 200 {@link RoundView} again for a stop already collected: a second tap is a success, and
 *   nothing is written or sent. The FIRST count stands, even if this tap sent another one.
 * - 400 {@link InvalidCollectErrorBody}: the body did not validate (0, a fraction, a string, an
 *   unknown key). Checked first, whatever the round.
 * - 404 {@link RoundNotFoundErrorBody}: no round has this id, or the id is not one at all.
 * - 409 {@link RouteNotOpenErrorBody}: the round is closed, or its route is not built yet (phase
 *   `confirming`).
 * - 404 {@link OrderNotFoundErrorBody}: the order is not one of the route's stops (another
 *   round's, one sent back at the build as `notConfirmed`, or a guess).
 * - 409 {@link StopHandledErrorBody}: the stop was handled another way: not found, cancelled, or
 *   it left the round.
 * - 409 {@link InvalidTransitionErrorBody}: the order is in the round but cannot be collected
 *   (still `pending`, which a routed round does not normally have), or it changed status while the
 *   request was on its way (the customer cancelled at that very moment).
 *
 * The status change goes through `canTransition` and is conditional on `confirmed` (`ifStatus`),
 * so a double tap, or a tap racing the customer's cancel, cannot both win.
 *
 * Known limits:
 * - Nothing is written to the round, so a collect racing "סגור סבב" on another screen is not
 *   atomic with it: the order may end up collected in a round that was just closed. With one
 *   collector on one screen that does not happen.
 * - If writing the thank-you's log entry fails after the status was written (a repo error, so a
 *   500), a retry finds the stop collected and answers 200 without a thank-you. It does not try to
 *   "heal" by sending one then on purpose: two racing taps would then both send.
 *
 * Logs nothing: bodies hold phones and addresses (CLAUDE.md, privacy). An unexpected error goes to
 * the app's error handler, which logs it without the request and answers 500. Times are the real
 * clock (`new Date()`), like the other routes; tests check them against a window around the call.
 */
export function createCollectorStopActionsRouter(
  deps: Pick<AppDeps, 'orders' | 'rounds' | 'messaging'>,
): Router {
  const { orders, rounds, messaging } = deps;
  const router = Router();

  /** The round's view, with its orders as they are stored now. */
  async function loadRoundView(round: Round): Promise<RoundView> {
    return buildRoundView(round, await orders.list({ ids: round.orderIds }));
  }

  router.post('/:id/stops/:orderId/collected', async (req, res) => {
    // The body first, like a move: a broken request is a 400 whatever the round. Express 5 leaves
    // `req.body` undefined when no JSON body was sent, which means "the estimate" here (`{}`).
    const parsed = collectStopRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendInvalidCollect(res, formFieldErrors(parsed.error));
      return;
    }
    const request: CollectStopRequest = parsed.data;
    const { id, orderId } = req.params;

    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const round = await rounds.findById(id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    // Only a built route of an open round has stops to collect. Checked before the stop: a
    // confirming round has no stops yet, and "refresh the screen" is the useful answer then.
    if (round.status !== 'open' || round.phase !== 'routed') {
      sendRouteNotOpen(res);
      return;
    }
    // Only a stop of this route: an order of the round that is no stop (sent back at the build),
    // another round's order, or a guessed id is not this route's to collect.
    const order = round.stops.some((stop) => stop.orderId === orderId)
      ? await orders.findById(orderId)
      : null;
    if (order === null) {
      sendOrderNotFound(res);
      return;
    }

    const state = roundStopStateOf(round, order);
    if (state === 'collected') {
      // A second tap (or a retry): a success, and nothing is written or sent again, so the first
      // count, `collectedAt` and thank-you stand.
      sendView(res, await loadRoundView(round));
      return;
    }
    if (state !== 'toCollect') {
      // Not found, cancelled, or it left the round: the screen is stale.
      sendStopHandled(res);
      return;
    }
    // A stop to collect is `confirmed`, or `pending` (which a routed round does not normally
    // have): only confirmed → collected is allowed (spec §4).
    if (!canTransition(order.status, 'collected')) {
      sendInvalidTransition(res);
      return;
    }

    const now = new Date();
    const collected = await orders.update(
      orderId,
      {
        status: 'collected',
        // Below the 30-bottle minimum is fine: that is a booking rule, not a count.
        bottlesCollected: request.bottlesCollected ?? order.bottlesEstimated,
        collectedAt: now,
        updatedAt: new Date(now),
      },
      { ifStatus: [order.status] },
    );
    if (collected === null) {
      // The order changed between the read and the write. If it is now collected in this round,
      // this was the double tap that lost the race: the winner sent the thank-you, so this one
      // answers like a second tap. Anything else (the customer cancelled) is a refused change.
      const current = await orders.findById(orderId);
      if (current !== null && roundStopStateOf(round, current) === 'collected') {
        sendView(res, await loadRoundView(round));
        return;
      }
      sendInvalidTransition(res);
      return;
    }

    // sendAndLog never throws for a send that failed: it logs it as failed, the stop then has no
    // "שלח תודה" row, and the order is collected all the same.
    await sendAndLog(
      { orders, sender: messaging.sender },
      collected,
      orderMessage(collected, 'thankYou', { publicBaseUrl: messaging.publicBaseUrl }),
    );
    // Re-read after the writes, so the collected stop carries the thank-you just logged.
    sendView(res, await loadRoundView(round));
  });

  return router;
}
