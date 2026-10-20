// The answers that more than one /api/collector/rounds router sends: the round's view, and the
// error bodies of the shared contract (packages/shared/src/roundsApi.ts) that both the round
// routes (collectorRoundsRoutes.ts) and the stop actions (collectorStopActionsRoutes.ts) answer.
// One place, so the two routers can never answer the same error with different bodies. Answers
// only one router sends stay in that router's file.
import type { Response } from 'express';
import {
  COLLECTOR_ORDER_MESSAGES,
  ROUND_MESSAGES,
  type InvalidCollectErrorBody,
  type InvalidTransitionErrorBody,
  type OrderNotFoundErrorBody,
  type RoundNotFoundErrorBody,
  type RoundView,
  type RouteNotOpenErrorBody,
  type StopHandledErrorBody,
} from '@bottlerun/shared';

/** 200 (or `status`, e.g. 201 for a new round) with the round's view. */
export function sendView(res: Response, view: RoundView, status = 200): void {
  res.status(status).json(view);
}

/** 404, the same body for an unknown and a malformed round id. */
export function sendRoundNotFound(res: Response): void {
  const body: RoundNotFoundErrorBody = { error: 'round_not_found' };
  res.status(404).json(body);
}

/** 404: no such order, or it is not in the round of the path (or not a stop of its route). */
export function sendOrderNotFound(res: Response): void {
  const body: OrderNotFoundErrorBody = { error: 'order_not_found' };
  res.status(404).json(body);
}

/**
 * 409: a move or a stop action on a round whose route is not built yet (confirming), or that is
 * closed.
 */
export function sendRouteNotOpen(res: Response): void {
  const body: RouteNotOpenErrorBody = {
    error: 'route_not_open',
    message: ROUND_MESSAGES.routeNotOpen,
  };
  res.status(409).json(body);
}

/** 409: the order's status does not allow the change (it is closed, or it changed meanwhile). */
export function sendInvalidTransition(res: Response): void {
  const body: InvalidTransitionErrorBody = {
    error: 'invalid_transition',
    message: COLLECTOR_ORDER_MESSAGES.orderClosed,
  };
  res.status(409).json(body);
}

/**
 * 409: a stop action on a stop already handled another way ("אספתי" on a stop that is not found,
 * cancelled or left). The same action again is not this answer: it is an idempotent 200.
 */
export function sendStopHandled(res: Response): void {
  const body: StopHandledErrorBody = { error: 'stop_handled', message: ROUND_MESSAGES.stopHandled };
  res.status(409).json(body);
}

/**
 * 400: the body of "אספתי" did not validate. `fieldErrors` comes from `formFieldErrors`: the first
 * plain-Hebrew message of each invalid field, never the values sent. A body that is not an object,
 * or has an unknown key, has no field to show it on, so its `fieldErrors` is empty.
 */
export function sendInvalidCollect(res: Response, fieldErrors: Record<string, string>): void {
  const body: InvalidCollectErrorBody = { error: 'invalid_collect', fieldErrors };
  res.status(400).json(body);
}
