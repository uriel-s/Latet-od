// /api/collector/orders: the api of Yoel's "הזמנות" screen (spec §3.5): the waiting orders by
// region, one order, editing it (and picking a region or a near street, ADR-0005), cancelling it,
// and adding an order for a customer who phoned; plus marking a WhatsApp "שלח" link of an order
// as opened (ADR-0003). createApp mounts the router built here AFTER requireCollector, so every
// route needs the login (ADR-0004). The shapes are the shared contract
// (packages/shared/src/collectorOrdersApi.ts and messages.ts); the edit rules live in
// orderPatch.ts, and the orders are read and written through OrdersRepo.
import { Router, type Response } from 'express';
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  canDeleteOrder,
  canTransition,
  formFieldErrors,
  groupWaitingOrders,
  isOpenStatus,
  orderFormSchema,
  toCollectorOrder,
  updateOrderRequestSchema,
  type CannotDeleteErrorBody,
  type CollectorOrderResponse,
  type CollectorOrdersResponse,
  type DuplicateOpenOrderErrorBody,
  type InvalidOrderErrorBody,
  type InvalidTransitionErrorBody,
  type MessageNotFoundErrorBody,
  type MessageOpenedResponse,
  type Order,
  type OrderNotFoundErrorBody,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { newOrderFromForm } from './newOrderFromForm.ts';
import { buildOrderPatch } from './orderPatch.ts';
import { DuplicateOpenOrderError } from './ordersRepo.ts';

/**
 * The router of /api/collector/orders. Mount it with
 * `app.use('/api/collector/orders', createCollectorOrdersRouter(deps))`, after the Origin check,
 * the JSON body parser and `requireCollector` (which answers 401 without a session and sets
 * `Cache-Control: no-store` on every answer).
 *
 * GET / — the "הזמנות" screen:
 * - 200 {@link CollectorOrdersResponse}: the `waiting` orders, oldest first, in the three groups
 *   ramat / old / none ("בלי אזור"), each with its order count and bottle total.
 *
 * GET /:id — one order, whatever its status:
 * - 200 {@link CollectorOrderResponse}.
 * - 404 {@link OrderNotFoundErrorBody}: no order has this id, or the id is not one at all.
 *
 * PATCH /:id — "עריכה", "שינוי אזור" and the near street; body `updateOrderRequestSchema`:
 * - 200 {@link CollectorOrderResponse}: the order as stored after the change.
 * - 400 {@link InvalidOrderErrorBody}: the body did not validate (also: an unknown key such as
 *   `status`, an empty body, no body).
 * - 404 {@link OrderNotFoundErrorBody}.
 * - 409 {@link InvalidTransitionErrorBody}: the order is no longer open (collected or cancelled),
 *   or it changed status while the edit was on its way.
 * - 409 {@link DuplicateOpenOrderErrorBody}: the new phone already has another open order.
 *
 * POST /:id/cancel — "ביטול"; no body:
 * - 200 {@link CollectorOrderResponse}: cancelled now, or already cancelled (a repeated tap is a
 *   success, and nothing is written again).
 * - 404 {@link OrderNotFoundErrorBody}.
 * - 409 {@link InvalidTransitionErrorBody}: the order cannot be cancelled (it was collected), or it
 *   changed status meanwhile.
 *
 * DELETE /:id — "מחיקת ההזמנה", for good (ADR-0008); no body:
 * - 204: a `waiting` or `cancelled` order that is in no round (`canDeleteOrder`) is gone.
 * - 404 {@link OrderNotFoundErrorBody}: no such order, or it was deleted meanwhile.
 * - 409 {@link CannotDeleteErrorBody}: the order was collected or is in a round, or it changed
 *   status meanwhile. Nothing is removed.
 *
 * POST / — "הוספת הזמנה" for a customer who phoned; body: the booking form (`orderFormSchema`):
 * - 201 {@link CollectorOrderResponse}: a `waiting` order with `source: 'collector'`.
 * - 400 {@link InvalidOrderErrorBody}.
 * - 409 {@link DuplicateOpenOrderErrorBody}: the phone already has an open order.
 * No honeypot and no rate limit: only the logged-in collector gets here.
 *
 * POST /:id/messages/:index/opened — Yoel's "שלח" button, as it opens the wa.me link of the entry
 * at `:index` of the order's message log (ADR-0003); no body:
 * - 200 {@link MessageOpenedResponse}: the entry's `openedAt`, set to now. An entry already
 *   opened answers its FIRST `openedAt` and nothing is written again.
 * - 404 {@link OrderNotFoundErrorBody}.
 * - 404 {@link MessageNotFoundErrorBody}: `:index` is not a whole number (digits only), is past
 *   the end of the log, or the entry there is not a `manual` link.
 * Any status: a thank-you is opened for a `collected` order. It never changes the status, since
 * nobody can know whether Yoel then really tapped "send" in WhatsApp.
 *
 * Every status change goes through `canTransition` (only "cancel" changes one here); a PATCH and
 * "opened" never change the status. Each status-dependent write is conditional on the status it
 * was decided on (`ifStatus`), so two screens racing on one order cannot both win.
 *
 * Logs nothing: bodies hold phones and addresses (CLAUDE.md, privacy). An unexpected error goes to
 * the app's error handler, which logs it without the request and answers 500. Times are the real
 * clock (`new Date()`), like POST /api/orders; tests check them against a window around the call.
 */
export function createCollectorOrdersRouter(deps: Pick<AppDeps, 'orders'>): Router {
  const { orders } = deps;
  const router = Router();

  router.get('/', async (_req, res) => {
    // Oldest first (the repo's order); groupWaitingOrders keeps it inside each group.
    const waiting = await orders.list({ statuses: ['waiting'] });
    const body: CollectorOrdersResponse = {
      groups: groupWaitingOrders(waiting.map(toCollectorOrder)),
    };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    // Express 5 leaves `req.body` undefined when no JSON body was sent; safeParse turns that into
    // a 400 too. A `website` key (the public form's honeypot) is simply stripped by the schema.
    const parsed = orderFormSchema.safeParse(req.body);
    if (!parsed.success) {
      sendInvalidOrder(res, formFieldErrors(parsed.error));
      return;
    }

    // No findOpenByPhone first: the repo enforces one open order per phone atomically.
    let created: Order;
    try {
      created = await orders.create(
        newOrderFromForm(parsed.data, { now: new Date(), source: 'collector' }),
      );
    } catch (error) {
      if (error instanceof DuplicateOpenOrderError) {
        sendDuplicateOpenOrder(res);
        return;
      }
      throw error;
    }

    sendOrder(res, created, 201);
  });

  router.get('/:id', async (req, res) => {
    // Never validated here: the repo answers null for a malformed id, so it is a 404 too.
    const order = await orders.findById(req.params.id);
    if (order === null) {
      sendNotFound(res);
      return;
    }
    sendOrder(res, order);
  });

  router.patch('/:id', async (req, res) => {
    const parsed = updateOrderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendInvalidOrder(res, formFieldErrors(parsed.error));
      return;
    }

    const { id } = req.params;
    const stored = await orders.findById(id);
    if (stored === null) {
      sendNotFound(res);
      return;
    }
    // A collected or cancelled order is history: the statistics count it as it was.
    if (!isOpenStatus(stored.status)) {
      sendInvalidTransition(res);
      return;
    }

    const { patch } = buildOrderPatch(stored, parsed.data, new Date());
    let updated: Order | null;
    try {
      // Only if the status is still the one the patch was built on: if the order was collected or
      // cancelled since the read above, the edit must not land on it.
      updated = await orders.update(id, patch, { ifStatus: [stored.status] });
    } catch (error) {
      // The phone was changed onto a phone that has another open order (spec §3.1).
      if (error instanceof DuplicateOpenOrderError) {
        sendDuplicateOpenOrder(res);
        return;
      }
      throw error;
    }
    if (updated === null) {
      sendInvalidTransition(res);
      return;
    }
    sendOrder(res, updated);
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const stored = await orders.findById(id);
    if (stored === null) {
      sendNotFound(res);
      return;
    }
    // Already cancelled: a repeated tap (or a second screen) is answered as a success, without
    // writing again, so `cancelledAt` keeps the first moment. canTransition says staying in a
    // status is not a transition; answering it is the api's (orderStatus.ts).
    if (stored.status === 'cancelled') {
      sendOrder(res, stored);
      return;
    }
    if (!canTransition(stored.status, 'cancelled')) {
      sendInvalidTransition(res);
      return;
    }

    const now = new Date();
    // A cancelled order KEEPS its `roundId` (the customer's own cancel, customerOrderRoutes.ts,
    // does the same): cancelled is final, so it can never be planned into a round again anyway;
    // the round's view leaves a cancelled order out of every group (buildRoundView); and the
    // roundId records which round it was cancelled in. Only an order that goes back to `waiting`
    // leaves its round (rounds/leaveRound.ts).
    const cancelled = await orders.update(
      id,
      { status: 'cancelled', cancelledAt: now, updatedAt: new Date(now) },
      { ifStatus: [stored.status] },
    );
    if (cancelled === null) {
      sendInvalidTransition(res);
      return;
    }
    sendOrder(res, cancelled);
  });

  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const stored = await orders.findById(id);
    if (stored === null) {
      sendNotFound(res);
      return;
    }
    // One rule for "may this go" (ADR-0008), shared with the screen's button: not a collected
    // order, and not one a round still names.
    if (!canDeleteOrder(stored)) {
      sendCannotDelete(res);
      return;
    }

    // Only if the status is still the one decided on: an order that a round planned, or Yoel
    // collected, between the read and the delete is kept. Not deleted means it changed meanwhile
    // (409), or that a second screen deleted it first (404, like a tap on an order that is gone).
    const deleted = await orders.delete(id, { ifStatus: [stored.status] });
    if (!deleted) {
      if ((await orders.findById(id)) === null) sendNotFound(res);
      else sendCannotDelete(res);
      return;
    }
    res.status(204).end();
  });

  router.post('/:id/messages/:index/opened', async (req, res) => {
    const { id, index } = req.params;
    const stored = await orders.findById(id);
    if (stored === null) {
      sendNotFound(res);
      return;
    }
    const messageIndex = parseMessageIndex(index, stored.messages.length);
    const entry = messageIndex === undefined ? undefined : stored.messages[messageIndex];
    // Only a wa.me link can be opened: a `sent` or `failed` entry has no link.
    if (entry?.mode !== 'manual') {
      sendMessageNotFound(res);
      return;
    }
    // Opened before: a repeated tap (or a second screen) keeps the first moment, and writes nothing.
    if (entry.openedAt !== undefined) {
      sendOpened(res, entry.openedAt);
      return;
    }

    const now = new Date();
    // A read-modify-write of the whole `messages` array, like sendAndLog
    // (messages/sendAndLog.ts), with the same known limit. No status and no `ifStatus`: opening
    // a link is not a status change, and works on an order in any status.
    const updated = await orders.update(id, {
      messages: stored.messages.map((other, position) =>
        position === messageIndex ? { ...entry, openedAt: now } : other,
      ),
      updatedAt: new Date(now),
    });
    if (updated === null) {
      sendNotFound(res);
      return;
    }
    sendOpened(res, now);
  });

  return router;
}

/**
 * The `:index` of the "opened" route as a position in a log of `length` entries, or undefined
 * when it is not one: digits only (no sign, no decimal point, no exponent), and inside the log.
 */
function parseMessageIndex(index: string, length: number): number | undefined {
  if (!/^\d+$/.test(index)) return undefined;
  const position = Number(index);
  return position < length ? position : undefined;
}

/** 200 with the moment the entry's link was (first) opened. */
function sendOpened(res: Response, openedAt: Date): void {
  const body: MessageOpenedResponse = { openedAt };
  res.json(body);
}

/** 404: the order has no `manual` message at this index. */
function sendMessageNotFound(res: Response): void {
  const body: MessageNotFoundErrorBody = { error: 'message_not_found' };
  res.status(404).json(body);
}

/** 200 (or `status`) with the order as Yoel's screens get it: no token, no message log. */
function sendOrder(res: Response, order: Order, status = 200): void {
  const body: CollectorOrderResponse = { order: toCollectorOrder(order) };
  res.status(status).json(body);
}

/**
 * 400 with `formFieldErrors`: the first plain-Hebrew message of each invalid field, never the
 * values sent. A body that is not an object, or a PATCH with an unknown key or nothing to change,
 * has no field to show it on, so its `fieldErrors` is empty.
 */
function sendInvalidOrder(res: Response, fieldErrors: Record<string, string>): void {
  const body: InvalidOrderErrorBody = { error: 'invalid_order', fieldErrors };
  res.status(400).json(body);
}

/** 404, the same body for an unknown and a malformed id. */
function sendNotFound(res: Response): void {
  const body: OrderNotFoundErrorBody = { error: 'order_not_found' };
  res.status(404).json(body);
}

/** 409: the order's status does not allow the change (it is closed, or it changed meanwhile). */
function sendInvalidTransition(res: Response): void {
  const body: InvalidTransitionErrorBody = {
    error: 'invalid_transition',
    message: COLLECTOR_ORDER_MESSAGES.orderClosed,
  };
  res.status(409).json(body);
}

/** 409: the order is collected or in a round (or changed so meanwhile), so it is not deleted. */
function sendCannotDelete(res: Response): void {
  const body: CannotDeleteErrorBody = {
    error: 'cannot_delete',
    message: COLLECTOR_ORDER_MESSAGES.cannotDelete,
  };
  res.status(409).json(body);
}

/**
 * 409: the phone already has an open order. Only the fixed message, never the other order, like
 * the public form (spec §3.1).
 */
function sendDuplicateOpenOrder(res: Response): void {
  const body: DuplicateOpenOrderErrorBody = {
    error: 'duplicate_open_order',
    message: CREATE_ORDER_MESSAGES.duplicateOpenOrder,
  };
  res.status(409).json(body);
}
