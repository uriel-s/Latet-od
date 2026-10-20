// The production AttemptStore (ADR-0004, "הגבלת ניסיונות"): one document per attempt in the
// `loginAttempts` collection. The collection keeps the ADR's name although it also counts the
// public form's submissions (keys `order:…`): one mechanism, one collection. A TTL index deletes
// each attempt once its window has passed, so the collection stays tiny and IPs are not kept.
import type { Collection, Db, Filter, IndexDescription } from 'mongodb';
import { indexesOnce } from '../db/indexes.ts';
import type { AttemptStore, AttemptStoreOptions } from './attemptStore.ts';

/** One recorded attempt, as stored in `loginAttempts`. */
export interface AttemptDocument {
  key: string;
  /** When the attempt was made: what the window counts by. */
  at: Date;
  /** `at` plus the window it was recorded with: when the TTL index may delete it. */
  expiresAt: Date;
}

/**
 * The indexes of `loginAttempts`, created by the store before its first operation.
 *
 * - TTL on `expiresAt` with `expireAfterSeconds: 0`: Mongo deletes each attempt once its own
 *   `expiresAt` has passed. Its monitor runs about once a minute, so deletion is late: counts
 *   filter by `at` and never rely on it.
 * - `{ key, at }`: the count of one key in a window reads only that key's recent attempts.
 */
export const ATTEMPT_INDEXES: readonly IndexDescription[] = [
  { key: { expiresAt: 1 }, name: 'expire_at', expireAfterSeconds: 0 },
  { key: { key: 1, at: 1 }, name: 'key_at' },
];

/**
 * {@link AttemptStore} on the `loginAttempts` collection of `db`. Create one per process, like the
 * orders repo: each instance creates the indexes before its first operation.
 *
 * `hit` is an insert and then a count, not one atomic step: two attempts at the same moment may
 * both count each other. For a limit that only errs toward blocking a little early, that is fine.
 *
 * It meets the same contract as the in-memory fake (attemptStore.contract.ts). To run that suite
 * against Atlas by hand, as for MongoOrdersRepo (a scratch test file on a throwaway database,
 * outside green and never committed):
 *
 * @example
 * describeAttemptStoreContract('MongoAttemptStore', async (now) => {
 *   await db.collection('loginAttempts').deleteMany({}); // the suite needs an empty store
 *   return new MongoAttemptStore(db, { now });
 * });
 */
export class MongoAttemptStore implements AttemptStore {
  private readonly attempts: Collection<AttemptDocument>;
  private readonly ensureIndexes: () => Promise<void>;
  private readonly now: () => Date;

  constructor(db: Db, options: AttemptStoreOptions = {}) {
    this.attempts = db.collection<AttemptDocument>('loginAttempts');
    this.ensureIndexes = indexesOnce(this.attempts, ATTEMPT_INDEXES);
    this.now = options.now ?? (() => new Date());
  }

  async hit(key: string, windowMs: number): Promise<number> {
    await this.ensureIndexes();
    const now = this.now();
    await this.attempts.insertOne(attemptDocument(key, now, windowMs));
    return this.attempts.countDocuments(inWindowFilter(key, now, windowMs));
  }

  async count(key: string, windowMs: number): Promise<number> {
    await this.ensureIndexes();
    return this.attempts.countDocuments(inWindowFilter(key, this.now(), windowMs));
  }

  async reset(key: string): Promise<void> {
    await this.ensureIndexes();
    await this.attempts.deleteMany({ key: { $eq: key } });
  }
}

/** The document recording one attempt of `key` made at `now`, expiring after `windowMs`. */
export function attemptDocument(key: string, now: Date, windowMs: number): AttemptDocument {
  return { key, at: new Date(now), expiresAt: new Date(now.getTime() + windowMs) };
}

/**
 * The attempts of `key` inside the window at `now`: made after `now - windowMs`, so one exactly
 * `windowMs` old no longer counts (the window rule on {@link AttemptStore}). `$eq` keeps a key
 * built from request data a plain value, never an operator.
 */
export function inWindowFilter(key: string, now: Date, windowMs: number): Filter<AttemptDocument> {
  return { key: { $eq: key }, at: { $gt: new Date(now.getTime() - windowMs) } };
}
