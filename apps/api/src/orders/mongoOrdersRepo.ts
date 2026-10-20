// The production OrdersRepo: collection `orders` in MongoDB Atlas, through the official driver with
// no Mongoose (ADR-0001). Every document read is parsed with `orderSchema` from shared, the single
// source of the data's shape, so a malformed document fails loudly instead of reaching a screen.
// The rules a database must enforce atomically are unique indexes: one open order per phone
// (spec §3.1) and a unique token. Query and update building is pure and unit-tested; the class
// itself only passes them to the driver, and is checked against Atlas outside green (see below).
import {
  MongoServerError,
  ObjectId,
  type Collection,
  type Db,
  type Filter,
  type IndexDescription,
} from 'mongodb';
import { OPEN_ORDER_STATUSES, orderSchema, type NewOrder, type Order } from '@bottlerun/shared';
import { indexesOnce } from '../db/indexes.ts';
import { parseObjectId } from '../db/objectId.ts';
import { buildPatchUpdate, withoutUndefined, type PatchUpdate } from '../db/patchUpdate.ts';
import {
  DuplicateOpenOrderError,
  type OrderListFilter,
  type OrderPatch,
  type OrderUpdateOptions,
  type OrdersRepo,
} from './ordersRepo.ts';

/** An order as stored in `orders`: the {@link NewOrder} fields plus Mongo's `_id`. */
export type OrderDocument = NewOrder & { _id: ObjectId };

/** Name of the index that keeps one open order per phone; also how its E11000 is recognized. */
export const ONE_OPEN_ORDER_PER_PHONE_INDEX = 'one_open_order_per_phone';

/** Name of the unique index on the customer's token. */
export const TOKEN_UNIQUE_INDEX = 'token_unique';

/**
 * The indexes of `orders`, created by the repo before its first operation.
 *
 * - The token is unique, and `findByToken` (every visit to `/o/<token>`) uses the index.
 * - One open order per phone (spec §3.1): a unique index on the phone over open orders only, so a
 *   customer may have any number of collected or cancelled orders but never two open ones, even
 *   when two submissions race. `$in` in a partial filter needs MongoDB 6.0 or later; Atlas Free
 *   runs 8.x. `findOpenByPhone` uses this index too.
 *
 * No index for `list()` (by status, sorted by date): with about 1.5 orders a day the collection
 * holds hundreds of documents a year, and scanning and sorting them costs less than keeping one
 * more index. Add `{ status: 1, createdAt: 1 }` if that ever changes.
 */
export const ORDER_INDEXES: readonly IndexDescription[] = [
  { key: { token: 1 }, name: TOKEN_UNIQUE_INDEX, unique: true },
  {
    key: { 'contact.phone': 1 },
    name: ONE_OPEN_ORDER_PER_PHONE_INDEX,
    unique: true,
    partialFilterExpression: { status: { $in: [...OPEN_ORDER_STATUSES] } },
  },
];

/** Server error code of a write that breaks a unique index (E11000 duplicate key). */
const DUPLICATE_KEY_CODE = 11000;

/**
 * {@link OrdersRepo} on the `orders` collection of `db`.
 *
 * Create one per process, next to the client (`getMongoDb`), not one per request: each instance
 * creates the indexes before its first operation.
 *
 * Its behaviour is the same contract the in-memory fake passes. To run that suite against Atlas
 * by hand (outside green, and never committed: tests must not touch the network), put this in a
 * scratch `*.test.ts`, with `db` from a `MongoClient` (`MONGO_CLIENT_OPTIONS`) on a throwaway
 * database, and drop that database and close the client in `afterAll`:
 *
 * @example
 * describeOrdersRepoContract('MongoOrdersRepo', async () => {
 *   await db.collection('orders').deleteMany({}); // the suite needs an empty repo
 *   return new MongoOrdersRepo(db);
 * });
 */
export class MongoOrdersRepo implements OrdersRepo {
  private readonly orders: Collection<OrderDocument>;
  private readonly ensureIndexes: () => Promise<void>;

  constructor(db: Db) {
    this.orders = db.collection<OrderDocument>('orders');
    this.ensureIndexes = indexesOnce(this.orders, ORDER_INDEXES);
  }

  async create(order: NewOrder): Promise<Order> {
    await this.ensureIndexes();
    // The id is made here, not by the server, so the returned order needs no second read. The
    // driver also orders same-process ObjectIds by creation, which `list()` relies on for ties.
    const doc = toOrderDocument(order, new ObjectId());
    try {
      await this.orders.insertOne(doc);
    } catch (error) {
      throw mapDuplicateKeyError(error) ?? error;
    }
    return toOrder(doc);
  }

  async findById(id: string): Promise<Order | null> {
    const _id = parseOrderId(id);
    if (_id === null) return null;
    return this.findOne({ _id });
  }

  // `$eq` everywhere a value comes from a request: a value that is not a plain string (say a JSON
  // body's `{ "$ne": "" }`) is then compared as a value, never run as an operator (NoSQL injection).
  async findByToken(token: string): Promise<Order | null> {
    return this.findOne({ token: { $eq: token } });
  }

  async findOpenByPhone(phone: string): Promise<Order | null> {
    return this.findOne({
      'contact.phone': { $eq: phone },
      status: { $in: [...OPEN_ORDER_STATUSES] },
    });
  }

  async list(filter: OrderListFilter = {}): Promise<Order[]> {
    await this.ensureIndexes();
    const docs = await this.orders
      .find(buildListFilter(filter))
      // `_id` breaks createdAt ties in creation order (see create()).
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return docs.map(toOrder);
  }

  async update(
    id: string,
    patch: OrderPatch,
    options: OrderUpdateOptions = {},
  ): Promise<Order | null> {
    const _id = parseOrderId(id);
    if (_id === null) return null;
    // The status check is part of the query, so the check and the write are one atomic step:
    // of two racing updates with the same ifStatus, the second finds no match and gets null.
    const filter: Filter<OrderDocument> = { _id };
    if (options.ifStatus !== undefined) filter.status = { $in: [...options.ifStatus] };

    const update = buildUpdate(patch);
    // Nothing to change: Mongo refuses an empty `$set`, and the contract returns the order as is.
    if (update === null) return this.findOne(filter);

    await this.ensureIndexes();
    try {
      const doc = await this.orders.findOneAndUpdate(filter, update, { returnDocument: 'after' });
      return doc === null ? null : toOrder(doc);
    } catch (error) {
      throw mapDuplicateKeyError(error) ?? error;
    }
  }

  /** The first order matching `filter`, parsed, or null. */
  private async findOne(filter: Filter<OrderDocument>): Promise<Order | null> {
    await this.ensureIndexes();
    const doc = await this.orders.findOne(filter);
    return doc === null ? null : toOrder(doc);
  }
}

/**
 * The ObjectId behind an order id, or null when `id` cannot be one the repo handed out (24
 * lowercase hex characters, see {@link parseObjectId}). Methods turn null into "not found": a
 * malformed id from a URL is a miss, never an error.
 */
export function parseOrderId(id: string): ObjectId | null {
  return parseObjectId(id);
}

/**
 * The document to insert for `order`: its own deep copy, with every `undefined` field left out at
 * any depth (the contract: optional fields are absent, never undefined or null), plus `_id`.
 */
export function toOrderDocument(order: NewOrder, _id: ObjectId): OrderDocument {
  return { ...(withoutUndefined(order) as NewOrder), _id };
}

/**
 * A stored document as an {@link Order}: `_id` becomes the hex `id`, and `orderSchema` checks the
 * rest and strips `_id`. Throws (a ZodError, whose message names fields, not their values) when
 * the document does not have the stored order's shape, e.g. `null` in an optional field.
 */
export function toOrder(doc: { _id: ObjectId }): Order {
  return orderSchema.parse({ ...doc, id: doc._id.toHexString() });
}

/** The query of `list(filter)`: every given filter must match. */
export function buildListFilter(filter: OrderListFilter): Filter<OrderDocument> {
  const query: Filter<OrderDocument> = {};
  // An empty list stays `$in: []`, which matches nothing, as the contract says.
  if (filter.statuses !== undefined) query.status = { $in: [...filter.statuses] };
  if (filter.roundId !== undefined) query.roundId = { $eq: filter.roundId };
  if (filter.ids !== undefined) {
    // Malformed ids are dropped: no order can have one. If none is left, `$in: []` matches
    // nothing, which is what the contract says for an empty list or a list of unknown ids.
    query._id = { $in: filter.ids.flatMap((id) => parseOrderId(id) ?? []) };
  }
  return query;
}

/** The update document {@link buildUpdate} makes from a patch. */
export type OrderUpdate = PatchUpdate<OrderPatch>;

/**
 * The Mongo update for `patch` (see {@link OrderPatch}): a key with a value replaces the field as a
 * whole (`$set`), a key whose value is `undefined` removes it (`$unset`). Inside a `$set` value,
 * nested `undefined` fields are left out. Null for an empty patch: Mongo refuses an empty update.
 */
export function buildUpdate(patch: OrderPatch): OrderUpdate | null {
  return buildPatchUpdate(patch);
}

/**
 * The error to throw instead of a duplicate-key (E11000) error, or undefined for any other error.
 *
 * - The phone index: {@link DuplicateOpenOrderError}, which the api answers with 409 and a fixed
 *   message, never the existing order (spec §3.1).
 * - The token or any other unique index: a plain Error. It is a bug, not a customer's duplicate.
 *
 * The raw error is never rethrown, nor kept as `cause`: its message and `keyValue` hold the phone
 * or the token, and errors end up in logs (CLAUDE.md, privacy).
 */
export function mapDuplicateKeyError(error: unknown): Error | undefined {
  if (!(error instanceof MongoServerError) || error.code !== DUPLICATE_KEY_CODE) return undefined;
  if (violatesIndex(error, ONE_OPEN_ORDER_PER_PHONE_INDEX, 'contact.phone')) {
    return new DuplicateOpenOrderError();
  }
  if (violatesIndex(error, TOKEN_UNIQUE_INDEX, 'token')) {
    return new Error('An order with this token already exists');
  }
  return new Error('An order write broke a unique index of the orders collection');
}

/**
 * Whether a duplicate-key error is about this index: by `keyPattern` (servers since 4.2 send it),
 * or else by the index name the server writes in the message ("… index: <name> dup key: …").
 */
function violatesIndex(error: MongoServerError, indexName: string, field: string): boolean {
  const keyPattern: unknown = error.keyPattern;
  if (typeof keyPattern === 'object' && keyPattern !== null) return field in keyPattern;
  return error.message.includes(`index: ${indexName} `);
}
