// /api/collector/rounds, Yoel's round screens (spec §3.5, §3.6): planning a round and its
// messages, the open rounds, one round, "התחל מסלול", moving a stop by hand and "סגור סבב".
// The stop actions ("אספתי", "לא נמצא") are in collectorStopActionsRoutes.ts, on the same path.
// createApp mounts this router AFTER requireCollector, so every route needs the login (ADR-0004).
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
import {
  sendOrderNotFound,
  sendRoundNotFound,
  sendRouteNotOpen,
  sendView,
} from './roundResponses.ts';

/**
 * POST / plans a round: its orders become `confirmed` at once, with no confirmation step
 * (ADR-0012). If some order is unknown, not `waiting` or already in a round, the answer is 409 and
 * nothing is written: no round, no order change, no message.
 *
 * GET / lists only the OPEN rounds; `previousPickupBy` / `previousPickupFrom` come from the round
 * created last, whatever its status.
 *
 * POST /:id/route ("התחל מסלול"): every order still in the round is a stop, nobody is sent back
 * for not answering (ADR-0012); a legacy `pending` order is moved to `confirmed`. A round whose
 * orders all left still becomes routed, with no stops. The route is computed once (spec §3.6: its
 * order must not change in the middle of the drive), so a second build is a 409 that recomputes
 * nothing; Yoel moves a stop by hand instead.
 *
 * POST /:id/stops/:orderId/move swaps one stop with its neighbour in the stored stops; the route
 * is never recomputed. Any stop may move, whatever its state: the screen sorts handled cards
 * itself. 409 when the round is closed or not routed, also when it was closed while the move was
 * on its way. Two moves racing: the later write wins (each is one swap of the stops it read).
 *
 * POST /:id/close (closeRound.ts): the round becomes `closed` with `closedAt`, phase unchanged; it
 * leaves GET / but GET /:id still answers. Its orders still in it and `pending`/`confirmed` go back
 * to `waiting` with `lastMiss` `notReached`; every other order is untouched; no message. Closing
 * it again keeps the first `closedAt` and re-runs the sweep, so an order a half-failed first close
 * left behind is sent back now. The round is closed BEFORE its orders are swept, so a stop action
 * or a move arriving meanwhile is refused with 409 instead of acting on a closing round.
 *
 * Every order status change goes through `canTransition` and is conditional on the status it was
 * decided on (`ifStatus`), so two screens (or the customer's page) racing on one order cannot both
 * win. Logs nothing: bodies hold phones and addresses; an unexpected error goes to the app's error
 * handler, which logs it without the request and answers 500.
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
        // Straight to confirmed: the message announces the pickup, nobody confirms (ADR-0012).
        { status: 'confirmed', roundId: round.id, updatedAt: new Date(now) },
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

    // One message per order, one at a time (each appends to that order's log). sendAndLog never
    // throws for a send that failed: it logs it, and the order then simply has no "שלח" row; it
    // stays in the round all the same (Yoel can still call the customer).
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
      ...(latest?.pickupFrom === undefined ? {} : { previousPickupFrom: latest.pickupFrom }),
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

  router.post('/:id/route', async (req, res) => {
    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const round = await rounds.findById(req.params.id);
    if (round === null) {
      sendRoundNotFound(res);
      return;
    }
    // Only once, and only before the route exists: a routed round keeps its stored route.
    if (round.status !== 'open' || round.phase !== 'confirming') {
      sendConfirmationsClosed(res);
      return;
    }

    // Who is a stop, in plan order (which also breaks planRoute's ties): every order still in the
    // round. An order that left it already (asked for another date, cancelled and so on) has
    // another `roundId`, or none, or is not confirmed, and is no stop.
    const now = new Date();
    const found = new Map((await orders.list({ ids: round.orderIds })).map((o) => [o.id, o]));
    const stopOrders: Order[] = [];
    for (const orderId of round.orderIds) {
      const order = found.get(orderId);
      if (order?.roundId !== round.id) continue;
      const settled = order.status === 'pending' ? await takeInLegacyPending(order, now) : order;
      if (settled?.roundId === round.id && settled.status === 'confirmed') stopOrders.push(settled);
    }

    const stops = buildRouteStops(stopOrders, route.start, DROP_OFF.point, route.distance);
    // Conditional on the round still being open and confirming: of two racing builds (or a build
    // and a close), only one writes. The loser already moved the same legacy pending orders to
    // confirmed, which the winner did too, so it changed nothing the winner did not.
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
      // Not in the route: another round's order, one that left before the build, or a guess.
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
   * Moves a legacy `pending` order (planned before ADR-0012, when the customer still had to
   * confirm) to `confirmed`, so it is a stop like every other order of the round: not answering
   * no longer takes anyone out. Resolves to the order as it is now. The write is conditional on
   * `pending`: when it misses, the order changed in that instant (the customer declined or
   * cancelled), so it is read again and the caller decides by what it is now; null only if the
   * order is gone.
   */
  async function takeInLegacyPending(order: Order, now: Date): Promise<Order | null> {
    if (!canTransition(order.status, 'confirmed')) return order;
    const confirmed = await orders.update(
      order.id,
      { status: 'confirmed', updatedAt: new Date(now) },
      { ifStatus: [order.status] },
    );
    return confirmed ?? (await orders.findById(order.id));
  }

  return router;
}

/**
 * Whether `order` may be put into a new round: it exists, it is `waiting` (the only status that
 * may move into a round, spec §4, ADR-0012), and it is in no round. A waiting order is in no round,
 * because leaving a round unsets `roundId`; checking `roundId` too is what keeps "an order is in at
 * most one open round" (spec §4) true even if that ever slipped.
 */
function isPlannable(order: Order | undefined): order is Order {
  return order !== undefined && order.status === 'waiting' && order.roundId === undefined;
}

/** The new round of `plan`: open, confirming, no route yet. Absent optionals are left out. */
function newRoundFromPlan(plan: PlanRound, now: Date): NewRound {
  return {
    date: plan.date,
    region: plan.region,
    status: 'open',
    phase: 'confirming',
    ...(plan.personalText === undefined ? {} : { personalText: plan.personalText }),
    ...(plan.pickupFrom === undefined ? {} : { pickupFrom: plan.pickupFrom }),
    ...(plan.pickupBy === undefined ? {} : { pickupBy: plan.pickupBy }),
    orderIds: [...plan.orderIds],
    stops: [],
    createdAt: now,
  };
}

/**
 * What every message of `round` says besides the customer's name and link: the date,
 * and the pickup time and personal text when Yoel gave them.
 */
function confirmRequestOptions(round: Round, publicBaseUrl: string): OrderMessageOptions {
  return {
    publicBaseUrl,
    date: round.date,
    ...(round.pickupFrom === undefined ? {} : { pickupFrom: round.pickupFrom }),
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
 * 409: "התחל מסלול" on a round whose route is already built, or that is closed. The code keeps
 * its old name (ADR-0012).
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
