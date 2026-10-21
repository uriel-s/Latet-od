// /api/collector/rounds: the api of Yoel's round screens (spec §3.5 "תכנון סבב", §3.6 step 1
// "אישורים"): planning a round and sending its confirmation requests (ADR-0003), the open rounds
// of the "סבבים" tab, one round, "אישר בטלפון", "סגור אישורים ובנה מסלול" (spec §3.6: whoever
// did not confirm leaves the round, and the confirmed orders are ordered into the stored route),
// moving one stop of that route up or down by hand (spec §3.6 step 2), and "סגור סבב" (the close
// itself is closeRound.ts). The stop actions on that route ("אספתי", "לא נמצא") are in
// collectorStopActionsRoutes.ts, mounted on the same path.
// createApp mounts the router built here AFTER requireCollector, so every route needs the login
// (ADR-0004). The shapes are the shared contract (packages/shared/src/roundsApi.ts); rounds and
// orders are read and written through RoundsRepo and OrdersRepo, each confirmation request goes
// through messages/sendAndLog.ts, and the route's order (and each manual move) comes from
// buildRoute.ts (planRoute, moveStop). The answers both routers send are in roundResponses.ts.
import { Router, type Response } from 'express';
import {
  ROUND_MESSAGES,
  buildRoundView,
  canTransition,
  formFieldErrors,
  moveStopRequestSchema,
  planRoundRequestSchema,
  type ConfirmationsClosedErrorBody,
  type InvalidMoveErrorBody,
  type InvalidRoundErrorBody,
  type NewRound,
  type Order,
  type OrdersNotWaitingErrorBody,
  type PlanRound,
  type Round,
  type RoundView,
  type RoundsResponse,
  type StopAtEdgeErrorBody,
} from '@bottlerun/shared';
import { DROP_OFF } from '../config.ts';
import type { AppDeps } from '../deps.ts';
import { orderMessage, sendAndLog, type OrderMessageOptions } from '../messages/sendAndLog.ts';
import { buildRouteStops, moveStop } from './buildRoute.ts';
import { closeRound } from './closeRound.ts';
import { leaveRoundPatch } from './leaveRound.ts';
import {
  sendInvalidTransition,
  sendOrderNotFound,
  sendRoundNotFound,
  sendRouteNotOpen,
  sendView,
} from './roundResponses.ts';

/**
 * The router of /api/collector/rounds. Mount it with
 * `app.use('/api/collector/rounds', createCollectorRoundsRouter(deps))`, after the Origin check,
 * the JSON body parser and `requireCollector` (which answers 401 without a session and sets
 * `Cache-Control: no-store` on every answer).
 *
 * POST / — "תכנון סבב" + "שלח בקשות אישור"; body `planRoundRequestSchema`:
 * - 201 {@link RoundView}: the new round (open, phase `confirming`), its orders now `pending` in
 *   it, and the "שלח" list: one wa.me link per order (ADR-0003).
 * - 400 {@link InvalidRoundErrorBody}: the plan did not validate (also: more than 25 orders, an
 *   unknown key, no body).
 * - 409 {@link OrdersNotWaitingErrorBody}: some id is unknown, malformed, not `waiting`, or already
 *   in a round. Nothing is written then: no round, no order change, no message.
 *
 * GET / — the "סבבים" tab:
 * - 200 {@link RoundsResponse}: every OPEN round's view, by date, then by when it was created; and
 *   `previousPickupBy`, the `pickupBy` of the round created last (any status), when it had one.
 *
 * GET /:id — one round, whatever its status:
 * - 200 {@link RoundView}.
 * - 404 {@link RoundNotFoundErrorBody}: no round has this id, or the id is not one at all.
 *
 * POST /:id/orders/:orderId/confirm-by-phone — "אישר בטלפון" (spec §3.6); no body:
 * - 200 {@link RoundView}: the round after the order moved to `confirmed`, or as it was when the
 *   order was already confirmed (a second tap is a success, and nothing is written again).
 * - 404 {@link RoundNotFoundErrorBody}.
 * - 404 {@link OrderNotFoundErrorBody}: no such order, or it is not in this round now.
 * - 409 {@link ConfirmationsClosedErrorBody}: the round is closed, or its confirmations are
 *   (phase `routed`).
 * - 409 {@link InvalidTransitionErrorBody}: the order cannot be confirmed (cancelled, collected),
 *   or it changed status while the request was on its way.
 *
 * POST /:id/route — "סגור אישורים ובנה מסלול" (spec §3.6, ADR-0005); no body (any body is ignored):
 * - 200 {@link RoundView}: the round now in phase `routed`, its `stops` the stored route in driving
 *   order (home → stops → DROP_OFF), each with its order, `hasLocation` and state. Every order that
 *   had not confirmed (`pending`) left the round: it is `waiting` again, with `lastMiss` reason
 *   `notConfirmed`, so it is in none of the view's groups. A round where nobody confirmed still
 *   becomes routed, with no stops: Yoel then closes it ("סגור סבב", POST /:id/close).
 * - 404 {@link RoundNotFoundErrorBody}: no round has this id, or the id is not one at all.
 * - 409 {@link ConfirmationsClosedErrorBody}: the round is closed, or already routed. The route is
 *   computed once (spec §3.6: its order must not change in the middle of the drive), so a second
 *   build is refused and recomputes nothing; Yoel moves a stop by hand instead.
 *
 * POST /:id/stops/:orderId/move — move one stop up or down by hand (spec §3.6 step 2: "אפשר להזיז
 * עצירה למעלה או למטה ידנית"); body `moveStopRequestSchema` (`{ direction: 'up' | 'down' }`):
 * - 200 {@link RoundView}: the stop swapped with the one before it (`up`) or after it (`down`) in
 *   the stored `stops`; every other stop keeps its place. The route is never recomputed. Any stop
 *   may be moved, whatever its state (collected, not found, left): the route screen sorts the
 *   handled cards itself (section 6).
 * - 400 {@link InvalidMoveErrorBody}: no body, an unknown key, or another direction. Checked first.
 * - 404 {@link RoundNotFoundErrorBody}: no round has this id, or the id is not one at all.
 * - 409 {@link RouteNotOpenErrorBody}: the round is closed, or its route is not built yet (phase
 *   `confirming`); also when it was closed while the move was on its way.
 * - 404 {@link OrderNotFoundErrorBody}: the order is not one of the route's stops (another round's,
 *   or one that left at the build as `notConfirmed`).
 * - 409 {@link StopAtEdgeErrorBody}: the first stop moved up, or the last one down. Nothing is
 *   written.
 * Two moves racing on one round: the later write wins (each is one swap of the stops it read).
 *
 * POST /:id/close — "סגור סבב" (spec §3.6, §4); no body (any body is ignored); see closeRound.ts:
 * - 200 {@link RoundView}: the round is now `closed`, with `closedAt`, in the phase it was closed
 *   in (`confirming` or `routed`, unchanged), so it leaves GET / (the "סבבים" tab) while GET /:id
 *   still answers it. Every order still in it and `pending` or `confirmed` is `waiting` again, out
 *   of the round: `lastMiss` reason `notReached` for a confirmed stop of a routed round,
 *   `notConfirmed` otherwise. Collected, cancelled and not-found stops, and orders that already
 *   left the round, stay as they are. No message is sent.
 * - 200 {@link RoundView} again for a round already closed: it keeps its first `closedAt`, and the
 *   sweep runs again, so an order a first close left behind (it failed half way) is sent back now.
 * - 404 {@link RoundNotFoundErrorBody}: no round has this id, or the id is not one at all.
 * The round is closed BEFORE its orders are swept, so a stop action, a move, "אישר בטלפון" or the
 * customer's confirm arriving meanwhile is refused with 409 instead of acting on a closing round.
 *
 * Every order status change goes through `canTransition` and is conditional on the status it was
 * decided on (`ifStatus`), so two screens (or the customer's own page) racing on one order cannot
 * both win.
 *
 * Logs nothing: bodies hold phones and addresses (CLAUDE.md, privacy). An unexpected error goes to
 * the app's error handler, which logs it without the request and answers 500. Times are the real
 * clock (`new Date()`), like the orders routes; tests check them against a window around the call.
 */
export function createCollectorRoundsRouter(
  deps: Pick<AppDeps, 'orders' | 'rounds' | 'messaging' | 'route'>,
): Router {
  const { orders, rounds, messaging, route } = deps;
  const router = Router();

  /** The round's view, with its orders as they are stored now. */
  async function loadRoundView(round: Round): Promise<RoundView> {
    return buildRoundView(round, await orders.list({ ids: round.orderIds }));
  }

  router.post('/', async (req, res) => {
    // Express 5 leaves `req.body` undefined when no JSON body was sent; safeParse turns that into
    // a 400 too. More than 25 orders is a 400 here as well (spec §1).
    const parsed = planRoundRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendInvalidRound(res, formFieldErrors(parsed.error));
      return;
    }
    const plan = parsed.data;

    // Every id must be an order that can be planned, or nothing is planned at all: Yoel's screen
    // was out of date, so he refreshes it and plans again, rather than getting half a round.
    //
    // The orders' region is NOT compared with the round's: the planning screen offers only the
    // region's waiting orders, and Yoel may add a neighbour from the other half by hand.
    const found = new Map((await orders.list({ ids: plan.orderIds })).map((o) => [o.id, o]));
    const notPlannable = plan.orderIds.filter((id) => !isPlannable(found.get(id)));
    if (notPlannable.length > 0) {
      sendOrdersNotWaiting(res, notPlannable);
      return;
    }

    const now = new Date();
    let round = await rounds.create(newRoundFromPlan(plan, now));

    // Move each order into the round, in plan order. The write is conditional on the status read
    // above: an order that changed meanwhile (the customer cancelled it at this very moment, or
    // another screen planned it) gets null and is left out of the round, without a message.
    const moved: Order[] = [];
    for (const orderId of plan.orderIds) {
      const stored = found.get(orderId);
      if (stored === undefined) continue; // Checked above; keeps the types honest.
      const updated = await orders.update(
        orderId,
        { status: 'pending', roundId: round.id, updatedAt: new Date(now) },
        { ifStatus: [stored.status] },
      );
      if (updated !== null) moved.push(updated);
    }

    if (moved.length === 0) {
      // Every order slipped away: an empty round must not stay open in the "סבבים" tab. There is
      // no delete in RoundsRepo, so it is closed, with no orders (none was put in it), and Yoel
      // gets the same 409 as above, listing every id he sent.
      await rounds.update(round.id, { status: 'closed', closedAt: new Date(now), orderIds: [] });
      sendOrdersNotWaiting(res, plan.orderIds);
      return;
    }
    if (moved.length < plan.orderIds.length) {
      // `orderIds` lists the orders that were put into the round, and those left out never were.
      round = await updateOrFail(rounds.update(round.id, { orderIds: moved.map((o) => o.id) }));
    }

    // One confirmation request per order, one at a time (each appends to that order's log).
    // sendAndLog never throws for a send that failed: it logs it, and the order then simply has no
    // "שלח" row; Yoel can still mark it "אישר בטלפון".
    const messageOptions = confirmRequestOptions(round, messaging.publicBaseUrl);
    const finalOrders: Order[] = [];
    for (const order of moved) {
      const { order: logged } = await sendAndLog(
        { orders, sender: messaging.sender },
        order,
        orderMessage(order, 'confirmRequest', messageOptions),
      );
      finalOrders.push(logged);
    }

    sendView(res, buildRoundView(round, finalOrders), 201);
  });

  router.get('/', async (_req, res) => {
    // The repo's order: by date, then by when each round was created.
    const openRounds = await rounds.list({ statuses: ['open'] });
    const views = await Promise.all(openRounds.map(loadRoundView));
    // Pre-fills "עד איזו שעה להוציא את הבקבוקים" on the planning screen (ADR-0003).
    const latest = await rounds.findLatest();
    const body: RoundsResponse = {
      rounds: views,
      ...(latest?.pickupBy === undefined ? {} : { previousPickupBy: latest.pickupBy }),
    };
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const round = await rounds.findById(req.params.id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    sendView(res, await loadRoundView(round));
  });

  router.post('/:id/orders/:orderId/confirm-by-phone', async (req, res) => {
    const { id, orderId } = req.params;
    const round = await rounds.findById(id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    // Only an order that is in this round now: one that left it (or a guessed id of another
    // round's order) is not this round's to confirm.
    const order = await orders.findById(orderId);
    if (order?.roundId !== round.id) {
      sendOrderNotFound(res);
      return;
    }
    // Confirmations end with "סגור אישורים ובנה מסלול" (phase `routed`) or with the round's close.
    if (round.status !== 'open' || round.phase !== 'confirming') {
      sendConfirmationsClosed(res);
      return;
    }
    // Already confirmed (by the customer's page, or a first tap): a success, and nothing is
    // written, so `updatedAt` keeps the first moment. canTransition says staying in a status is
    // not a transition; answering it is the api's (orderStatus.ts).
    if (order.status === 'confirmed') {
      sendView(res, await loadRoundView(round));
      return;
    }
    // Only `pending` can move to `confirmed`; a cancelled or collected order cannot.
    if (!canTransition(order.status, 'confirmed')) {
      sendInvalidTransition(res);
      return;
    }

    const confirmed = await orders.update(
      orderId,
      { status: 'confirmed', updatedAt: new Date() },
      { ifStatus: [order.status] },
    );
    if (confirmed === null) {
      sendInvalidTransition(res);
      return;
    }
    sendView(res, await loadRoundView(round));
  });

  router.post('/:id/route', async (req, res) => {
    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const round = await rounds.findById(req.params.id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    // Only once, and only while confirmations are open: a routed round keeps its stored route.
    if (round.status !== 'open' || round.phase !== 'confirming') {
      sendConfirmationsClosed(res);
      return;
    }

    // Who is a stop, in plan order (which also breaks planRoute's ties). An order that left the
    // round already (asked for another date, cancelled and so on) has another `roundId`, or none,
    // or is not confirmed, and is no stop.
    const now = new Date();
    const found = new Map((await orders.list({ ids: round.orderIds })).map((o) => [o.id, o]));
    const stopOrders: Order[] = [];
    for (const orderId of round.orderIds) {
      const order = found.get(orderId);
      if (order?.roundId !== round.id) continue;
      const settled =
        order.status === 'pending' ? await sendBackUnconfirmed(order, round, now) : order;
      if (settled?.roundId === round.id && settled.status === 'confirmed') stopOrders.push(settled);
    }

    const stops = buildRouteStops(stopOrders, route.start, DROP_OFF.point, route.distance);
    // Conditional on the round still being open and confirming: of two racing builds (or a build
    // and a close), only one writes. The loser already sent the same unconfirmed orders back,
    // which the winner did too, so it changed nothing the winner did not.
    const routed = await rounds.update(
      round.id,
      { phase: 'routed', stops },
      { ifStatus: ['open'], ifPhase: ['confirming'] },
    );
    if (routed === null) {
      sendConfirmationsClosed(res);
      return;
    }
    // Re-read after the writes, so the view shows the stops' orders as stored now.
    sendView(res, await loadRoundView(routed));
  });

  router.post('/:id/stops/:orderId/move', async (req, res) => {
    // The body first, like POST /: a broken request is a 400 whatever the round. Express 5 leaves
    // `req.body` undefined when no JSON body was sent, which fails the parse too.
    const parsed = moveStopRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendInvalidMove(res);
      return;
    }
    const { id, orderId } = req.params;
    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const round = await rounds.findById(id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    // Only a built route of an open round is Yoel's to rearrange. Checked before the stop: a
    // confirming round has no stops yet, and "refresh the screen" is the useful answer then.
    if (round.status !== 'open' || round.phase !== 'routed') {
      sendRouteNotOpen(res);
      return;
    }

    const moved = moveStop(round.stops, orderId, parsed.data.direction);
    if (moved === 'notFound') {
      // Not in the route: another round's order, one sent back as notConfirmed, or a guess.
      sendOrderNotFound(res);
      return;
    }
    if (moved === 'atEdge') {
      sendStopAtEdge(res);
      return;
    }
    // Conditional on the route still being open: a move from a screen left open after "סגור
    // סבב" gets null. Two moves racing on one round both read the same stops, so the later write
    // wins and the earlier one is lost; Yoel sees the stored order in the answer and taps again.
    const updated = await rounds.update(
      round.id,
      { stops: moved },
      { ifStatus: ['open'], ifPhase: ['routed'] },
    );
    if (updated === null) {
      sendRouteNotOpen(res);
      return;
    }
    sendView(res, await loadRoundView(updated));
  });

  router.post('/:id/close', async (req, res) => {
    // No body: whatever was sent is ignored, like POST /:id/route. Never validated here: the repo
    // answers null for a malformed id, so it is a 404 too.
    const view = await closeRound({ orders, rounds }, req.params.id);
    if (view === null) {
      sendRoundNotFound(res);
      return;
    }
    sendView(res, view);
  });

  /**
   * Takes a `pending` order of `round` out of it with reason `notConfirmed` (spec §3.6: "מי שלא
   * אישר יוצא מהסבב וחוזר לחכות"), and resolves to the order as it is now. The write is
   * conditional on `pending`: when it misses, the order changed in that instant (the customer
   * confirmed, or cancelled), so it is read again and the caller decides by what it is now. A
   * confirmed one is then still a stop; null only if the order is gone.
   */
  async function sendBackUnconfirmed(order: Order, round: Round, now: Date): Promise<Order | null> {
    if (!canTransition(order.status, 'waiting')) return order;
    const left = await orders.update(order.id, leaveRoundPatch(order, round, 'notConfirmed', now), {
      ifStatus: [order.status],
    });
    return left ?? (await orders.findById(order.id));
  }

  return router;
}

/**
 * Whether `order` may be put into a new round: it exists, it is in a status that may move to
 * `pending` (only `waiting`, spec §4), and it is in no round. A waiting order is in no round,
 * because leaving a round unsets `roundId`; checking `roundId` too is what keeps "an order is in at
 * most one open round" (spec §4) true even if that ever slipped.
 */
function isPlannable(order: Order | undefined): order is Order {
  return (
    order !== undefined && canTransition(order.status, 'pending') && order.roundId === undefined
  );
}

/** The new round of `plan`: open, confirming, no route yet. Absent optionals are left out. */
function newRoundFromPlan(plan: PlanRound, now: Date): NewRound {
  return {
    date: plan.date,
    region: plan.region,
    status: 'open',
    phase: 'confirming',
    ...(plan.personalText === undefined ? {} : { personalText: plan.personalText }),
    ...(plan.pickupBy === undefined ? {} : { pickupBy: plan.pickupBy }),
    orderIds: [...plan.orderIds],
    stops: [],
    createdAt: now,
  };
}

/**
 * What every confirmation request of `round` says besides the customer's name and link: the date,
 * and the pickup time and personal text when Yoel gave them.
 */
function confirmRequestOptions(round: Round, publicBaseUrl: string): OrderMessageOptions {
  return {
    publicBaseUrl,
    date: round.date,
    ...(round.pickupBy === undefined ? {} : { pickupBy: round.pickupBy }),
    ...(round.personalText === undefined ? {} : { personalText: round.personalText }),
  };
}

/**
 * The round a `RoundsRepo.update` resolved to. Null means the round just created is gone, which
 * nothing in the app does: a bug or a broken database, answered 500 by the error handler.
 */
async function updateOrFail(update: Promise<Round | null>): Promise<Round> {
  const round = await update;
  if (round === null) throw new Error('the round just planned is no longer stored');
  return round;
}

/**
 * 400 with `formFieldErrors`: the first plain-Hebrew message of each invalid field, never the
 * values sent. A body that is not an object, or has an unknown key, has no field to show it on,
 * so its `fieldErrors` is empty.
 */
function sendInvalidRound(res: Response, fieldErrors: Record<string, string>): void {
  const body: InvalidRoundErrorBody = { error: 'invalid_round', fieldErrors };
  res.status(400).json(body);
}

/** 409: these ids (in the order they were sent) cannot be planned, so nothing was. */
function sendOrdersNotWaiting(res: Response, orderIds: string[]): void {
  const body: OrdersNotWaitingErrorBody = {
    error: 'orders_not_waiting',
    message: ROUND_MESSAGES.ordersNotWaiting,
    orderIds,
  };
  res.status(409).json(body);
}

/**
 * 409: "אישר בטלפון", or building the route, after the round's confirmations were closed (routed
 * or closed).
 */
function sendConfirmationsClosed(res: Response): void {
  const body: ConfirmationsClosedErrorBody = {
    error: 'confirmations_closed',
    message: ROUND_MESSAGES.confirmationsClosed,
  };
  res.status(409).json(body);
}

/**
 * 400: a move's body is not `{ direction: 'up' | 'down' }`. No message: Yoel's screen never sends
 * one, only a broken client does.
 */
function sendInvalidMove(res: Response): void {
  const body: InvalidMoveErrorBody = { error: 'invalid_move' };
  res.status(400).json(body);
}

/** 409: the first stop moved up, or the last one down; nothing was written. */
function sendStopAtEdge(res: Response): void {
  const body: StopAtEdgeErrorBody = { error: 'stop_at_edge', message: ROUND_MESSAGES.stopAtEdge };
  res.status(409).json(body);
}
