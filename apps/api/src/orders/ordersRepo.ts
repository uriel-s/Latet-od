// The only door to stored orders (ADR-0001: the database is reached through repositories, with
// an in-memory fake for tests). A repository is dumb storage: the services decide status,
// timestamps and token. The repo enforces only what a database index would: one open order per
// phone (spec §3.1) and a unique token. The same contract suite (ordersRepo.contract.ts) runs
// against every implementation, so the fake and the Mongo repo cannot drift apart.
import type { NewOrder, Order, OrderStatus } from '@bottlerun/shared';

/**
 * The phone already has an open order (status in `OPEN_ORDER_STATUSES`), and the write would
 * give it a second one (spec §3.1). The api answers it with 409 and a fixed message only, never
 * the existing order or its token, because anyone can type someone else's number (spec §3.1).
 *
 * The message never contains the phone: errors end up in logs, and phones must not (CLAUDE.md,
 * privacy).
 */
export class DuplicateOpenOrderError extends Error {
  override name = 'DuplicateOpenOrderError';

  constructor() {
    super('This phone already has an open order');
  }
}

/** Fields an update may change. `id`, `token` and `createdAt` are fixed once the order exists. */
type PatchableOrder = Omit<Order, 'id' | 'token' | 'createdAt'>;

/**
 * A change to an order: each key present replaces that field as a whole (a nested object such as
 * `address` too, like Mongo's `$set`). A key present with the value `undefined` removes the field
 * (Mongo `$unset`), e.g. `{ roundId: undefined }` when an order leaves its round. Only optional
 * fields may be removed: removing a required one leaves an order that no longer parses.
 *
 * The repo sets nothing on its own, not even `updatedAt`: the service puts it in the patch.
 */
export type OrderPatch = Partial<PatchableOrder>;

/** Which orders `list()` returns. Every given filter must match (AND); none means every order. */
export interface OrderListFilter {
  /** Orders in one of these statuses. An empty list matches no order (like Mongo `$in: []`). */
  statuses?: readonly OrderStatus[];
  /** Orders in this round. */
  roundId?: string;
  /**
   * Orders whose id is in this list, e.g. a round's `orderIds` for its view. Ids that are unknown
   * or malformed simply match nothing; an empty list matches no order. The result keeps the
   * repo's oldest-first order, not the order of this list.
   */
  ids?: readonly string[];
}

/** Conditions on `update()`. */
export interface OrderUpdateOptions {
  /**
   * Apply the patch only if the stored status is one of these. The check and the write are one
   * atomic step, so two clicks racing on the same order (or a forged request on an old screen)
   * cannot both move it: the loser gets null. Pair it with `canTransition` from shared.
   */
  ifStatus?: readonly OrderStatus[];
}

/** Stored orders (collection `orders`). Every order returned is the caller's own copy. */
export interface OrdersRepo {
  /**
   * Stores a new order and returns it with its id. Fields whose value is `undefined` are left
   * out, at any depth.
   *
   * @throws DuplicateOpenOrderError when the order is open and its phone already has an open
   *   order (spec §3.1). In Mongo a partial unique index enforces this atomically.
   * @throws Error (not DuplicateOpenOrderError) when the token is already taken. With 256 random
   *   bits this does not happen in practice; it is a bug, not a customer's duplicate.
   */
  create(order: NewOrder): Promise<Order>;

  /** The order with this id, or null. An unknown or malformed id gives null, never an error. */
  findById(id: string): Promise<Order | null>;

  /** The order behind the customer's link `/o/<token>`, or null. */
  findByToken(token: string): Promise<Order | null>;

  /** The phone's open order (at most one exists), or null. `phone` is in E.164. */
  findOpenByPhone(phone: string): Promise<Order | null>;

  /** Orders matching `filter`, oldest first (`createdAt` ascending; ties in creation order). */
  list(filter?: OrderListFilter): Promise<Order[]>;

  /**
   * Applies `patch` (see {@link OrderPatch}) and returns the updated order. Returns null, and
   * changes nothing, when the id is unknown or malformed, or when `options.ifStatus` does not
   * match the stored status. An empty patch returns the order as it is.
   *
   * @throws DuplicateOpenOrderError when the change would give a phone a second open order: an
   *   order reopened while its phone has another open one, or a phone changed onto a phone that
   *   has one. Nothing changes then.
   */
  update(id: string, patch: OrderPatch, options?: OrderUpdateOptions): Promise<Order | null>;
}
