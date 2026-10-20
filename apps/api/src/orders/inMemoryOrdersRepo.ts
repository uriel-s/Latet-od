// In-memory OrdersRepo: the fake the api tests run against (ADR-0001), so no test touches Atlas.
// It behaves like the Mongo repo where tests can see it: ObjectId-shaped ids, the
// one-open-order-per-phone rule and the unique token (the Mongo indexes), `$set`/`$unset`
// patches, undefined fields left out, and a copy for every order handed out.
import { randomBytes } from 'node:crypto';
import { isOpenStatus, type NewOrder, type Order } from '@bottlerun/shared';
import { withoutUndefined } from '../db/patchUpdate.ts';
import {
  DuplicateOpenOrderError,
  type OrderListFilter,
  type OrderPatch,
  type OrderUpdateOptions,
  type OrdersRepo,
} from './ordersRepo.ts';

/**
 * A fake {@link OrdersRepo} that keeps orders in a Map. Each instance has its own Map and
 * nothing is shared between instances, so every test makes a fresh, empty one. Not for
 * production: the api is serverless and keeps no state between requests.
 *
 * Methods are not `async`: each runs its work inside a `new Promise` executor, which turns a
 * throw into a rejected promise, the way a real database call reports an error.
 */
export class InMemoryOrdersRepo implements OrdersRepo {
  // Insertion order of the Map is creation order: `list()` relies on it to break createdAt ties.
  private readonly orders = new Map<string, Order>();

  create(order: NewOrder): Promise<Order> {
    return new Promise((resolve) => resolve(this.insert(order)));
  }

  findById(id: string): Promise<Order | null> {
    return Promise.resolve(copyOrNull(this.orders.get(id)));
  }

  findByToken(token: string): Promise<Order | null> {
    return Promise.resolve(copyOrNull(this.find((order) => order.token === token)));
  }

  findOpenByPhone(phone: string): Promise<Order | null> {
    const open = this.find((order) => order.contact.phone === phone && isOpenStatus(order.status));
    return Promise.resolve(copyOrNull(open));
  }

  list(filter: OrderListFilter = {}): Promise<Order[]> {
    const { statuses, roundId, ids } = filter;
    const matching = [...this.orders.values()].filter(
      (order) =>
        (statuses === undefined || statuses.includes(order.status)) &&
        (roundId === undefined || order.roundId === roundId) &&
        // An unknown or malformed id is simply not any order's id, so it matches nothing.
        (ids === undefined || ids.includes(order.id)),
    );
    // Array sort is stable, so orders created at the same moment keep their creation order.
    matching.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return Promise.resolve(matching.map((order) => structuredClone(order)));
  }

  update(id: string, patch: OrderPatch, options: OrderUpdateOptions = {}): Promise<Order | null> {
    return new Promise((resolve) => resolve(this.applyPatch(id, patch, options)));
  }

  /** Stores a copy of `order` under a new id, after the checks the Mongo indexes would make. */
  private insert(order: NewOrder): Order {
    const stored: Order = { ...(withoutUndefined(order) as NewOrder), id: this.newId() };
    // The message leaves the token out: it is the secret of the customer's link.
    if (this.find((other) => other.token === stored.token) !== undefined) {
      throw new Error('An order with this token already exists');
    }
    this.assertNoOtherOpenOrder(stored);
    const copy = structuredClone(stored);
    this.orders.set(copy.id, copy);
    return structuredClone(copy);
  }

  /** The update itself; null when the order is missing or `ifStatus` does not match. */
  private applyPatch(id: string, patch: OrderPatch, options: OrderUpdateOptions): Order | null {
    const stored = this.orders.get(id);
    if (stored === undefined) return null;
    if (options.ifStatus !== undefined && !options.ifStatus.includes(stored.status)) return null;

    // Like Mongo's `$set` / `$unset`: a top-level key replaces the field as a whole, and
    // `undefined` removes it.
    const next: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = withoutUndefined(value);
    }
    const updated = next as Order;
    // Checked before writing, so a refused update leaves the stored order as it was.
    this.assertNoOtherOpenOrder(updated);
    const copy = structuredClone(updated);
    this.orders.set(id, copy);
    return structuredClone(copy);
  }

  /** Throws if `order` is open and another order of its phone is open too (spec §3.1). */
  private assertNoOtherOpenOrder(order: Order): void {
    if (!isOpenStatus(order.status)) return;
    const otherOpen = this.find(
      (other) =>
        other.id !== order.id &&
        other.contact.phone === order.contact.phone &&
        isOpenStatus(other.status),
    );
    if (otherOpen !== undefined) throw new DuplicateOpenOrderError();
  }

  /** The first stored order (in creation order) that matches, not copied. */
  private find(predicate: (order: Order) => boolean): Order | undefined {
    for (const order of this.orders.values()) {
      if (predicate(order)) return order;
    }
    return undefined;
  }

  /**
   * A new id in the shape of a Mongo ObjectId's hex string (24 lowercase hex characters), so code
   * that passes ids around, or parses them, behaves the same against the fake.
   */
  private newId(): string {
    let id: string;
    do {
      id = randomBytes(12).toString('hex');
    } while (this.orders.has(id));
    return id;
  }
}

/** The caller's own copy of a stored order, or null. */
function copyOrNull(order: Order | undefined): Order | null {
  return order === undefined ? null : structuredClone(order);
}
