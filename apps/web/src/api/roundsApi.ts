// The collector's rounds endpoints: /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 "סבב").
// Sent through `request()` (request.ts), which handles what every endpoint shares.
//
// Behind the login like the orders' routes, with the same rules: a 401 is `loggedOut`, nothing is
// retried (a plan that reached the api but lost its answer is stored, and sending it again would
// only answer `ordersNotWaiting`), every message is a shared constant, never the body's text, and
// every success body is parsed with the shared schema.
import {
  ROUND_MESSAGES,
  roundViewSchema,
  roundsResponseSchema,
  type CollectStopRequest,
  type MoveStopRequest,
  type PlanRoundRequest,
  type RoundView,
} from '@bottlerun/shared';
import {
  FAILED,
  FRESH_GET,
  errorCodeOf,
  fieldErrorsOf,
  globalFetch,
  isObject,
  isStringArray,
  jsonInit,
  parsed,
  request,
  type FetchFn,
  type StatusHandler,
} from './request.ts';

const COLLECTOR_ROUNDS_PATH = '/api/collector/rounds';

/** How GET /api/collector/rounds ended, as the "סבבים" tab and the planning screen use it. */
export type RoundsOutcome =
  /**
   * 200: the OPEN rounds, by date, each with its orders in groups and its "שלח" list; and the
   * `pickupBy` (and optional `pickupFrom`) of the round created last, which the planning screen
   * pre-fills (ADR-0003). Each is absent when that round had none, or there was no round yet.
   */
  | { kind: 'loaded'; rounds: RoundView[]; previousPickupBy?: string; previousPickupFrom?: string }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 5xx, or a 200 the app cannot read. */
  | { kind: 'failed' };

/** Loads the open rounds from `GET /api/collector/rounds`, past the browser cache. */
export async function fetchRounds(fetchFn: FetchFn = globalFetch): Promise<RoundsOutcome> {
  return request<RoundsOutcome>(fetchFn, {
    path: COLLECTOR_ROUNDS_PATH,
    init: FRESH_GET,
    behindLogin: true,
    on: {
      200: parsed(roundsResponseSchema, (data) => ({
        kind: 'loaded',
        rounds: data.rounds,
        previousPickupBy: data.previousPickupBy,
        previousPickupFrom: data.previousPickupFrom,
      })),
    },
  });
}

/** How POST /api/collector/rounds ("שלח הודעות") ended, as the planning screen shows it. */
export type PlanRoundOutcome =
  /** 201: the round is planned and its orders are `confirmed` (ADR-0012); `view` is the round as stored. */
  | { kind: 'planned'; view: RoundView }
  /**
   * 400: the plan did not validate (normally caught by the same check before sending).
   * `fieldErrors` maps a field (`date`, `region`, `orderIds`, `pickupFrom`, `pickupBy`, `personalText`) to its
   * plain-Hebrew message; empty when the body had none the app can read.
   */
  | { kind: 'invalid'; fieldErrors: Record<string, string> }
  /**
   * 409 `orders_not_waiting`: some marked order was meanwhile cancelled, edited away or planned
   * into another round, so nothing was planned. `orderIds` lists them (empty when the body did
   * not); the screen reloads its list.
   */
  | { kind: 'ordersNotWaiting'; message: string; orderIds: string[] }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Plans a round (spec §3.5 "תכנון סבב") with `POST /api/collector/rounds`: the api stores it,
 * moves the orders into it (`confirmed`: nobody confirms, ADR-0012) and writes each one's message.
 */
export async function planRound(
  body: PlanRoundRequest,
  fetchFn: FetchFn = globalFetch,
): Promise<PlanRoundOutcome> {
  return request<PlanRoundOutcome>(fetchFn, {
    path: COLLECTOR_ROUNDS_PATH,
    init: jsonInit('POST', body),
    behindLogin: true,
    on: {
      201: parsed(roundViewSchema, (view) => ({ kind: 'planned', view })),
      // `fieldErrors` of an `invalid_round`; any other 400 still tells Yoel to check the form.
      400: (answer) => ({ kind: 'invalid', fieldErrors: fieldErrorsOf(answer) }),
      // Told apart by the body's code, like the orders' 409s: a conflict this screen does not
      // know is `failed` rather than a guess.
      409: (answer) =>
        isObject(answer) && answer.error === 'orders_not_waiting'
          ? {
              kind: 'ordersNotWaiting',
              message: ROUND_MESSAGES.ordersNotWaiting,
              orderIds: isStringArray(answer.orderIds) ? answer.orderIds : [],
            }
          : FAILED,
    },
  });
}

/** The path of round `roundId`, both ids encoded so each stays one path segment. */
function roundPath(roundId: string): string {
  return `${COLLECTOR_ROUNDS_PATH}/${encodeURIComponent(roundId)}`;
}

/** The path of stop `orderId` in round `roundId`'s route, both ids encoded; the action follows. */
function roundStopPath(roundId: string, orderId: string): string {
  return `${roundPath(roundId)}/stops/${encodeURIComponent(orderId)}`;
}

/** How "התחל מסלול" ended, as the round screen shows it. */
export type BuildRouteOutcome =
  /** 200: the route is built (phase `routed`); `view.stops` holds it in driving order. */
  | { kind: 'built'; view: RoundView }
  /**
   * 409 `confirmations_closed`: the round is already routed or closed (a second tap, or another
   * tab), so nothing changed; the screen shows the message and reloads the round.
   */
  | { kind: 'closed'; message: string }
  /** 404: the round is gone. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403 or 5xx, another 409, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Yoel's "התחל מסלול" (spec §3.6 step 2) with `POST /api/collector/rounds/:id/route`
 * (no body): every order still in the round is a stop (ADR-0012), and the api stores the route
 * `planRoute` computes. Not retried: a build whose answer was lost is stored,
 * and a second one would only answer `closed`.
 */
export async function buildRoute(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<BuildRouteOutcome> {
  return request<BuildRouteOutcome>(fetchFn, {
    path: `${roundPath(roundId)}/route`,
    init: { method: 'POST' },
    behindLogin: true,
    on: {
      200: parsed(roundViewSchema, (view) => ({ kind: 'built', view })),
      404: () => ({ kind: 'notFound' }),
      // Told apart by the body's code: a conflict this screen does not know is `failed`.
      409: (body) =>
        errorCodeOf(body) === 'confirmations_closed'
          ? { kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed }
          : FAILED,
    },
  });
}

/** How a stop's move, "אספתי" or "לא נמצא" ended, as the route screen shows it. */
export type StopActionOutcome =
  /**
   * 200: done (also when the same action was already done: a second tap is harmless); `view` is
   * the round as it is now. After "אספתי", the collected stop's `thankYou` is its "שלח תודה" row.
   */
  | { kind: 'saved'; view: RoundView }
  /**
   * 409: the screen is stale, so it shows `message` and reloads the round. `route_not_open` (the
   * route is not built yet, or the round is closed), `stop_handled` (the stop was handled another
   * way), or `invalid_transition` (the order changed status meanwhile, e.g. the customer cancelled
   * at that moment), which is told with the `stop_handled` words: either way the stop is no longer
   * Yoel's to act on, and refreshing shows what happened there.
   */
  | { kind: 'stale'; message: string }
  /** 409 `stop_at_edge` (a move only): the stop is already first or last, so nothing moved. */
  | { kind: 'atEdge'; message: string }
  /**
   * 400 from "אספתי" (`invalid_collect`): the count did not validate (normally caught before
   * sending). `fieldErrors` maps `bottlesCollected` to its plain-Hebrew message; empty when the
   * body had none the app can read.
   */
  | { kind: 'invalid'; fieldErrors: Record<string, string> }
  /** 404: the round is gone, or the order is not a stop of its route. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /**
   * No usable answer: a network error, a 403 or 5xx, another 409, a body it cannot read, or a 400
   * from a move or "לא נמצא" (only a broken client sends one, so there is no field to show).
   */
  | { kind: 'failed' };

/**
 * Moves stop `orderId` of round `roundId` one place `up` (earlier) or `down` (later) in the stored
 * route (spec §3.6 step 2), with `POST /api/collector/rounds/:id/stops/:orderId/move`.
 */
export async function moveStop(
  roundId: string,
  orderId: string,
  direction: MoveStopRequest['direction'],
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  const body: MoveStopRequest = { direction };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/move`, body, false);
}

/**
 * Yoel's "אספתי" (spec §3.6 step 2) on stop `orderId` of round `roundId`, with
 * `POST /api/collector/rounds/:id/stops/:orderId/collected`. `bottlesCollected` is the real
 * count; left out (`{}` is sent), the api uses the order's estimate. The api sends the thank-you,
 * and the `saved` view's collected stop carries its "שלח תודה" row.
 */
export async function collectStop(
  roundId: string,
  orderId: string,
  bottlesCollected?: number,
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  // The key is left out rather than sent as undefined: "no count" means the estimate.
  const body: CollectStopRequest = bottlesCollected === undefined ? {} : { bottlesCollected };
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/collected`, body, true);
}

/**
 * Yoel's "לא נמצא" (spec §3.6 step 2) on stop `orderId` of round `roundId`, with
 * `POST /api/collector/rounds/:id/stops/:orderId/not-found` (no body): the order goes back to
 * `waiting` and its stop stays in the route as not found. No message is sent.
 */
export async function markStopNotFound(
  roundId: string,
  orderId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<StopActionOutcome> {
  return stopAction(fetchFn, `${roundStopPath(roundId, orderId)}/not-found`, undefined, false);
}

/**
 * Sends one stop action (a JSON `body`, or none when undefined) and turns the answer into a
 * {@link StopActionOutcome}. `hasFields`: whether a 400 is `invalid` (the "אספתי" count) rather
 * than `failed`. Never retried: every stop action is idempotent, so Yoel just taps again.
 */
async function stopAction(
  fetchFn: FetchFn,
  path: string,
  body: MoveStopRequest | CollectStopRequest | undefined,
  hasFields: boolean,
): Promise<StopActionOutcome> {
  const handlers: Record<number, StatusHandler<StopActionOutcome>> = {
    200: parsed(roundViewSchema, (view) => ({ kind: 'saved', view })),
    404: () => ({ kind: 'notFound' }),
    409: stopConflictOutcome,
  };
  if (hasFields) {
    handlers[400] = (answer) => ({ kind: 'invalid', fieldErrors: fieldErrorsOf(answer) });
  }
  return request<StopActionOutcome>(fetchFn, {
    path,
    init: body === undefined ? { method: 'POST' } : jsonInit('POST', body),
    behindLogin: true,
    on: handlers,
  });
}

/**
 * A 409 of a stop action, told apart by the body's `error` code (see {@link StopActionOutcome}).
 * A body without a known code is `failed`: guessing could tell Yoel the wrong thing.
 */
function stopConflictOutcome(body: unknown): StopActionOutcome {
  switch (errorCodeOf(body)) {
    case 'route_not_open':
      return { kind: 'stale', message: ROUND_MESSAGES.routeNotOpen };
    case 'stop_handled':
    case 'invalid_transition':
      return { kind: 'stale', message: ROUND_MESSAGES.stopHandled };
    case 'stop_at_edge':
      return { kind: 'atEdge', message: ROUND_MESSAGES.stopAtEdge };
    default:
      return FAILED;
  }
}

/** How closing a round ended, as the round screen shows it. */
export type CloseRoundOutcome =
  /**
   * 200: the round is closed (`view.round.status` is `closed`, `closedAt` set), also when it was
   * already closed. Every order it did not handle is back in `waiting` with its `lastMiss`.
   */
  | { kind: 'closed'; view: RoundView }
  /** 404: the round is gone. */
  | { kind: 'notFound' }
  /** 401: no valid session; the screen goes to /login. */
  | { kind: 'loggedOut' }
  /** No usable answer: a network error, a 403, 409 or 5xx, or a body it cannot read. */
  | { kind: 'failed' };

/**
 * Yoel's close button ("בטל את הסבב" / "סיימתי את הסבב", spec §3.6) with `POST /api/collector/rounds/:id/close` (no body): the api
 * closes the round and sends every order it did not handle back to `waiting`, as "לא הגענו
 * אליו". No message is sent. Not retried: a close whose answer was lost is stored, and a second
 * close is harmless anyway, since it answers `closed` with the round as it is.
 */
export async function closeRound(
  roundId: string,
  fetchFn: FetchFn = globalFetch,
): Promise<CloseRoundOutcome> {
  return request<CloseRoundOutcome>(fetchFn, {
    path: `${roundPath(roundId)}/close`,
    init: { method: 'POST' },
    behindLogin: true,
    // The route has no 409: a conflict here is from something in between, and so `failed`.
    on: {
      200: parsed(roundViewSchema, (view) => ({ kind: 'closed', view })),
      404: () => ({ kind: 'notFound' }),
    },
  });
}
