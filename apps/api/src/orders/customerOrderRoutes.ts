// /api/o/:token: the api of the customer's own page `/o/<token>` (spec §3.3): read the order, the
// page's three buttons: "מאשר/ת איסוף" (confirm), "לא מתאים הפעם" (decline) and "ביטול" (cancel),
// and "שינוי" (PATCH: address, quantity, note; never the phone). Public: no login, and the order is
// reached by its long random token only, never by its id. createApp mounts the router built here
// before the /api 404 and NOT behind requireCollector. The shapes are the shared contract
// (packages/shared/src/customerOrderApi.ts); orders and rounds are read and written through
// OrdersRepo and RoundsRepo, leaving a round is rounds/leaveRound.ts, and the rules of "שינוי" are
// customerOrderPatch.ts.
import { Router, type Response } from 'express';
import {
  CUSTOMER_ORDER_MESSAGES,
  canTransition,
  customerUpdateOrderRequestSchema,
  formFieldErrors,
  isOpenStatus,
  orderTokenSchema,
  toCustomerOrder,
  type ConfirmationsClosedErrorBody,
  type CustomerOrderResponse,
  type CustomerUpdateOrder,
  type InvalidOrderErrorBody,
  type InvalidTransitionErrorBody,
  type Order,
  type OrderNotFoundErrorBody,
  type OrderStatus,
  type Round,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { leaveRoundPatch } from '../rounds/leaveRound.ts';
import { buildCustomerOrderPatch } from './customerOrderPatch.ts';
import type { OrderPatch } from './ordersRepo.ts';

/** An order found by its token, with the round it is in (null when it is in none). */
interface FoundOrder {
  order: Order;
  round: Round | null;
}

/**
 * What a button (or "שינוי") does to the order as it is now, decided by one of the `decide…`
 * functions below:
 * - `noop`: nothing to write, answer 200 with the order as it is (a repeated tap).
 * - `write`: apply `patch` if the stored status is still one of `ifStatus`, then answer 200.
 * - `refuse`: answer 409 with `body`, writing nothing.
 */
type Decision =
  | { kind: 'noop' }
  | { kind: 'write'; patch: OrderPatch; ifStatus: readonly OrderStatus[] }
  | { kind: 'refuse'; body: ConfirmationsClosedErrorBody | InvalidTransitionErrorBody };

/** Decides what a button does to `order` (in `round`), at `now`. Pure. */
type Decide = (order: Order, round: Round | null, now: Date) => Decision;

/**
 * How many times a button reads the order, decides and writes. A write that finds another status
 * (null from the conditional update) means the order changed between the read and the write: a
 * double tap racing itself, or Yoel acting at the same moment. The order is then read once more
 * and the button decided again from its new state, so a racing second "confirm" finds `confirmed`
 * and succeeds, and a "confirm" racing a "cancel" finds `cancelled` and is refused (never bringing
 * the order back). A second lost race is answered 409 rather than retried without end.
 */
const DECIDE_ATTEMPTS = 2;

const NOOP: Decision = { kind: 'noop' };

/** 409 `invalid_transition`: the order is collected or cancelled, so nothing on it changes. */
const ORDER_CLOSED: InvalidTransitionErrorBody = {
  error: 'invalid_transition',
  message: CUSTOMER_ORDER_MESSAGES.orderClosed,
};

/** 409 `confirmations_closed`: the order is not in a round that takes confirmations now. */
const CONFIRMATIONS_CLOSED: ConfirmationsClosedErrorBody = {
  error: 'confirmations_closed',
  message: CUSTOMER_ORDER_MESSAGES.confirmationsClosed,
};

/**
 * The router of /api/o. Mount it with `app.use('/api/o', createCustomerOrderRouter(deps))`, after
 * the Origin check (which refuses every POST and PATCH from another site with 403) and the JSON
 * body parser, before the /api 404, and without `requireCollector`: the customer has no login.
 *
 * Every answer has `Cache-Control: no-store`: the page shows a name, a phone and an address behind
 * a secret link, which must never sit in a shared cache. Every 200 is a
 * {@link CustomerOrderResponse}: the order through the shared allow-list (`toCustomerOrder`), so
 * never its id, roundId, token, message log, lastMiss or Yoel's own fields; with the round's date
 * (and `pickupBy`) while the order is `pending` or `confirmed` in it.
 *
 * Every route answers 404 {@link OrderNotFoundErrorBody} (`order_not_found`) when no order has the
 * token, and the very same status and body when the token is not one at all (malformed, forged):
 * an answer never tells a guess anything. A malformed token never reaches the database. (PATCH
 * checks its body first: an invalid body is a 400 for every token, a valid one then gets the 404.)
 *
 * GET /:token — the page:
 * - 200, the order as it is. Writes NOTHING, whatever the status: WhatsApp's link preview sends a
 *   GET to every link in a message (spec §3.3), so a GET must never confirm or change anything.
 *
 * POST /:token/confirm — "מאשר/ת איסוף"; no body:
 * - 200: `pending` in a round that is open and still `confirming` → now `confirmed`. Already
 *   `confirmed` → as it is, nothing written (a double tap; `updatedAt` keeps the first moment).
 * - 409 {@link ConfirmationsClosedErrorBody}: the order is not in a round that takes
 *   confirmations: `pending` in a round that was routed, closed or is missing, or `waiting` (it
 *   already left its round: declined, changed its address, or did not confirm in time). The
 *   message is the spec's "האישור נסגר. נחזור אליך עם מועד חדש."
 * - 409 {@link InvalidTransitionErrorBody}: collected or cancelled.
 *
 * POST /:token/decline — "לא מתאים הפעם"; no body:
 * - 200: `pending` or `confirmed` → back to `waiting`, out of its round, `lastMiss` reason
 *   `askedOtherDate` (leaveRoundPatch), so Yoel's round screen lists it under "ביקשו מועד אחר" and
 *   the order can be planned into a later round. Already `waiting` → as it is, nothing written (a
 *   second tap: it is in no round). Allowed in any phase of the round, like cancel: the customer
 *   who cannot make it should say so even after the route was built. The page offers the button
 *   for `pending` only (spec §3.3).
 * - 409 {@link InvalidTransitionErrorBody}: collected or cancelled.
 *
 * POST /:token/cancel — "ביטול"; no body:
 * - 200: `waiting`, `pending` or `confirmed` → `cancelled`, with `cancelledAt`. Already
 *   `cancelled` → as it is, nothing written, so `cancelledAt` keeps the first moment.
 * - 409 {@link InvalidTransitionErrorBody}: collected.
 * A cancelled order KEEPS its `roundId`, like the collector's cancel (collectorOrdersRoutes.ts):
 * cancelled is final, so it can never be planned again anyway; the round's view leaves a cancelled
 * order out of every group (buildRoundView); and the roundId records which round it was cancelled
 * in.
 *
 * PATCH /:token — "שינוי"; body `customerUpdateOrderRequestSchema` (address, bottlesEstimated):
 * - 200: the change is stored (rules: buildCustomerOrderPatch, customerOrderPatch.ts) and the
 *   order answered as it is now. A change of the street or the house number of a `pending` or
 *   `confirmed` order takes it out of its round (spec §3.3): back to `waiting`, `lastMiss` reason
 *   `addressChanged`, so the answer has no `round`, and Yoel's round view lists it in no group (it
 *   did not ask for another date). Any other change keeps the order where it is.
 * - 400 {@link InvalidOrderErrorBody}: the body did not validate, with the booking form's plain
 *   messages per field. Also a `contact` key (the phone, or the name, never changes here), a
 *   `status` or any other unknown key, an empty body and no body: then `fieldErrors` is `{}`.
 *   The body is checked BEFORE the token, so an invalid body gets the same 400 whatever the
 *   token, and tells a guess nothing.
 * - 409 {@link InvalidTransitionErrorBody}: collected or cancelled.
 * A closed order is never reopened and the phone never changes, so a PATCH can never give a
 * phone a second open order (no DuplicateOpenOrderError here).
 *
 * Races: every write is a targeted patch (never `messages`, which sendAndLog rewrites as a whole)
 * and is conditional on the status it was decided on (`ifStatus`), so a PATCH racing a cancel never
 * lands on the cancelled order. When that write loses a race, the order is read and decided once
 * more ({@link DECIDE_ATTEMPTS}).
 *
 * Logs nothing: no body, phone, address or token reaches the log (CLAUDE.md, privacy). An
 * unexpected error goes to the app's error handler, which logs the route's pattern, never the URL
 * with its token, and answers 500. Times are the real clock (`new Date()`), like the other routes.
 */
export function createCustomerOrderRouter(deps: Pick<AppDeps, 'orders' | 'rounds'>): Router {
  const { orders, rounds } = deps;
  const router = Router();

  // Before every route, so the 404s and the 409s are never cached either.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /**
   * The order behind `token` and its round, or null when there is no such order. A token that is
   * not 43 base64url characters cannot be one, so the database is not even asked.
   */
  async function findOrder(token: string): Promise<FoundOrder | null> {
    const parsed = orderTokenSchema.safeParse(token);
    if (!parsed.success) return null;
    const order = await orders.findByToken(parsed.data);
    if (order === null) return null;
    const round = order.roundId === undefined ? null : await rounds.findById(order.roundId);
    return { order, round };
  }

  /**
   * One button: read the order, `decide`, and write, conditional on the status it decided on.
   * When the write finds the status changed meanwhile, read and decide again (see
   * {@link DECIDE_ATTEMPTS}); a write that still loses is answered 409 `invalid_transition`.
   */
  async function press(res: Response, token: string, decide: Decide): Promise<void> {
    const now = new Date();
    for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt += 1) {
      const found = await findOrder(token);
      if (found === null) {
        sendNotFound(res);
        return;
      }
      const decision = decide(found.order, found.round, now);
      if (decision.kind === 'noop') {
        sendOrder(res, found.order, found.round);
        return;
      }
      if (decision.kind === 'refuse') {
        sendRefusal(res, decision.body);
        return;
      }
      const updated = await orders.update(found.order.id, decision.patch, {
        ifStatus: decision.ifStatus,
      });
      if (updated !== null) {
        // The round read with the order: toCustomerOrder shows it only while the updated order is
        // still in it and pending or confirmed (so not after a decline or a cancel).
        sendOrder(res, updated, found.round);
        return;
      }
    }
    sendRefusal(res, ORDER_CLOSED);
  }

  router.get('/:token', async (req, res) => {
    const found = await findOrder(req.params.token);
    if (found === null) {
      sendNotFound(res);
      return;
    }
    sendOrder(res, found.order, found.round);
  });

  router.post('/:token/confirm', async (req, res) => {
    await press(res, req.params.token, decideConfirm);
  });

  router.post('/:token/decline', async (req, res) => {
    await press(res, req.params.token, decideDecline);
  });

  router.post('/:token/cancel', async (req, res) => {
    await press(res, req.params.token, decideCancel);
  });

  router.patch('/:token', async (req, res) => {
    // The body first, before the token is even looked at (see the JSDoc above). Express 5 leaves
    // `req.body` undefined when no JSON body was sent; safeParse turns that into a 400 too.
    const parsed = customerUpdateOrderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendInvalidOrder(res, formFieldErrors(parsed.error));
      return;
    }
    const update = parsed.data;
    await press(res, req.params.token, (order, round, now) =>
      decideUpdate(order, round, update, now),
    );
  });

  return router;
}

/**
 * "מאשר/ת איסוף": `pending` → `confirmed` while the order's round takes confirmations.
 * Already confirmed is a success (a double tap, or Yoel's "אישר בטלפון" came first); canTransition
 * says staying in a status is not a transition, so answering it is ours (orderStatus.ts).
 */
function decideConfirm(order: Order, round: Round | null, now: Date): Decision {
  if (order.status === 'confirmed') return NOOP;
  if (!isOpenStatus(order.status)) return { kind: 'refuse', body: ORDER_CLOSED };
  // What is left is `pending` or `waiting`. A waiting order cannot move to confirmed: it already
  // left its round, so for the customer the confirmations of that round are closed.
  if (!canTransition(order.status, 'confirmed') || !takesConfirmations(order, round)) {
    return { kind: 'refuse', body: CONFIRMATIONS_CLOSED };
  }
  return {
    kind: 'write',
    patch: { status: 'confirmed', updatedAt: new Date(now) },
    ifStatus: [order.status],
  };
}

/**
 * "לא מתאים הפעם": `pending` or `confirmed` → `waiting`, out of the round, `lastMiss` reason
 * `askedOtherDate`. Already `waiting` is a success: the order is in no round, which is what the
 * customer asked for (a second tap).
 */
function decideDecline(order: Order, round: Round | null, now: Date): Decision {
  if (order.status === 'waiting') return NOOP;
  if (!canTransition(order.status, 'waiting')) return { kind: 'refuse', body: ORDER_CLOSED };
  return {
    kind: 'write',
    patch: leaveRoundPatch(order, round, 'askedOtherDate', now),
    ifStatus: [order.status],
  };
}

/**
 * "ביטול": `waiting`, `pending` or `confirmed` → `cancelled`. Already cancelled is a success, and
 * nothing is written, so `cancelledAt` keeps the first moment. `roundId` stays (see the router's
 * JSDoc).
 */
function decideCancel(order: Order, _round: Round | null, now: Date): Decision {
  if (order.status === 'cancelled') return NOOP;
  if (!canTransition(order.status, 'cancelled')) return { kind: 'refuse', body: ORDER_CLOSED };
  return {
    kind: 'write',
    patch: { status: 'cancelled', cancelledAt: new Date(now), updatedAt: new Date(now) },
    ifStatus: [order.status],
  };
}

/**
 * "שינוי": `update` applied to an open order (waiting, pending, confirmed), following
 * buildCustomerOrderPatch (which may also take it out of its round). A collected or cancelled
 * order is history: the statistics count it as it was, so nothing on it changes. Every change is
 * written, even one that sends the stored values again, so `updatedAt` says the customer saved.
 */
function decideUpdate(
  order: Order,
  round: Round | null,
  update: CustomerUpdateOrder,
  now: Date,
): Decision {
  if (!isOpenStatus(order.status)) return { kind: 'refuse', body: ORDER_CLOSED };
  return {
    kind: 'write',
    patch: buildCustomerOrderPatch(order, update, round, now).patch,
    ifStatus: [order.status],
  };
}

/**
 * Whether `order` is in a round whose confirmations are open: the round it points at was found,
 * is open, and its phase is still `confirming` (Yoel's "סגור אישורים ובנה מסלול" makes it `routed`).
 */
function takesConfirmations(order: Order, round: Round | null): boolean {
  return (
    round !== null &&
    round.id === order.roundId &&
    round.status === 'open' &&
    round.phase === 'confirming'
  );
}

/** 200 with the order as the customer's page gets it (the shared allow-list). */
function sendOrder(res: Response, order: Order, round: Round | null): void {
  const body: CustomerOrderResponse = { order: toCustomerOrder(order, round) };
  res.json(body);
}

/** 409 with the refusal's body; nothing was written. */
function sendRefusal(
  res: Response,
  body: ConfirmationsClosedErrorBody | InvalidTransitionErrorBody,
): void {
  res.status(409).json(body);
}

/**
 * 400 with `formFieldErrors`: the first plain-Hebrew message of each invalid field, never the
 * values sent. A body refused as a whole (a `contact` or other unknown key, nothing to change, not
 * an object) has no field to show it on, so its `fieldErrors` is `{}`.
 */
function sendInvalidOrder(res: Response, fieldErrors: Record<string, string>): void {
  const body: InvalidOrderErrorBody = { error: 'invalid_order', fieldErrors };
  res.status(400).json(body);
}

/** 404, the same body for an unknown and a malformed token. */
function sendNotFound(res: Response): void {
  const body: OrderNotFoundErrorBody = { error: 'order_not_found' };
  res.status(404).json(body);
}
