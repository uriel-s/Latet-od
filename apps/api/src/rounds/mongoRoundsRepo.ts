// The production RoundsRepo: collection `rounds` in MongoDB Atlas, through the official driver with
// no Mongoose (ADR-0001). Every document read is parsed with `roundSchema` from shared, the single
// source of the data's shape, so a malformed document fails loudly instead of reaching a screen.
// Query and update building is pure and unit-tested; the class itself only passes them to the
// driver, and is checked against Atlas outside green (see below).
//
// No indexes: Yoel plans a few rounds a week, so the collection holds a few hundred documents after
// years, and scanning and sorting them costs less than keeping an index. Nothing about rounds must
// be unique either. Add `{ status: 1, date: 1 }` if that ever changes (and `indexesOnce`, as in
// MongoOrdersRepo).
import { ObjectId, type Collection, type Db, type Filter } from 'mongodb';
import { roundSchema, type NewRound, type Round } from '@bottlerun/shared';
import { parseObjectId } from '../db/objectId.ts';
import { buildPatchUpdate, withoutUndefined, type PatchUpdate } from '../db/patchUpdate.ts';
import type { RoundListFilter, RoundPatch, RoundUpdateOptions, RoundsRepo } from './roundsRepo.ts';

/** A round as stored in `rounds`: the {@link NewRound} fields plus Mongo's `_id`. */
export type RoundDocument = NewRound & { _id: ObjectId };

/**
 * {@link RoundsRepo} on the `rounds` collection of `db`. Create one per process, next to the client
 * (`getMongoDb`), like the other repos.
 *
 * Its behaviour is the same contract the in-memory fake passes. To run that suite against Atlas
 * by hand (outside green, and never committed: tests must not touch the network), put this in a
 * scratch `*.test.ts`, with `db` from a `MongoClient` (`MONGO_CLIENT_OPTIONS`) on a throwaway
 * database, and drop that database and close the client in `afterAll`:
 *
 * @example
 * describeRoundsRepoContract('MongoRoundsRepo', async () => {
 *   await db.collection('rounds').deleteMany({}); // the suite needs an empty repo
 *   return new MongoRoundsRepo(db);
 * });
 */
export class MongoRoundsRepo implements RoundsRepo {
  private readonly rounds: Collection<RoundDocument>;

  constructor(db: Db) {
    this.rounds = db.collection<RoundDocument>('rounds');
  }

  async create(round: NewRound): Promise<Round> {
    // The id is made here, not by the server, so the returned round needs no second read. The
    // driver also orders same-process ObjectIds by creation, which the sorts rely on for ties.
    const doc = toRoundDocument(round, new ObjectId());
    await this.rounds.insertOne(doc);
    return toRound(doc);
  }

  async findById(id: string): Promise<Round | null> {
    const _id = parseObjectId(id);
    if (_id === null) return null;
    return this.findOne({ _id });
  }

  async list(filter: RoundListFilter = {}): Promise<Round[]> {
    const docs = await this.rounds
      .find(buildRoundListFilter(filter))
      // `date` is `YYYY-MM-DD`, so text order is day order; `_id` breaks ties in creation order.
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .toArray();
    return docs.map(toRound);
  }

  async findLatest(): Promise<Round | null> {
    const doc = await this.rounds.findOne({}, { sort: { createdAt: -1, _id: -1 } });
    return doc === null ? null : toRound(doc);
  }

  async update(
    id: string,
    patch: RoundPatch,
    options: RoundUpdateOptions = {},
  ): Promise<Round | null> {
    const _id = parseObjectId(id);
    if (_id === null) return null;
    const filter = buildRoundUpdateFilter(_id, options);

    const update = buildRoundUpdate(patch);
    // Nothing to change: Mongo refuses an empty `$set`, and the contract returns the round as is.
    if (update === null) return this.findOne(filter);

    const doc = await this.rounds.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    return doc === null ? null : toRound(doc);
  }

  /** The first round matching `filter`, parsed, or null. */
  private async findOne(filter: Filter<RoundDocument>): Promise<Round | null> {
    const doc = await this.rounds.findOne(filter);
    return doc === null ? null : toRound(doc);
  }
}

/**
 * The document to insert for `round`: its own deep copy, with every `undefined` field left out at
 * any depth (the contract: optional fields are absent, never undefined or null), plus `_id`.
 */
export function toRoundDocument(round: NewRound, _id: ObjectId): RoundDocument {
  return { ...(withoutUndefined(round) as NewRound), _id };
}

/**
 * A stored document as a {@link Round}: `_id` becomes the hex `id`, and `roundSchema` checks the
 * rest and strips `_id`. Throws (a ZodError) when the document does not have the stored round's
 * shape, e.g. `null` in an optional field.
 */
export function toRound(doc: { _id: ObjectId }): Round {
  return roundSchema.parse({ ...doc, id: doc._id.toHexString() });
}

/** The query of `list(filter)`: every given filter must match. */
export function buildRoundListFilter(filter: RoundListFilter): Filter<RoundDocument> {
  const query: Filter<RoundDocument> = {};
  // An empty list stays `$in: []`, which matches nothing, as the contract says.
  if (filter.statuses !== undefined) query.status = { $in: [...filter.statuses] };
  return query;
}

/**
 * The query of `update(id, patch, options)`: the round `_id`, and, when given, its status and phase
 * among `options.ifStatus` / `options.ifPhase`. The conditions are part of the query, so the check
 * and the write are one atomic step: of two racing updates with the same condition, where the first
 * changes the field checked, the second finds no match and gets null. An empty list stays
 * `$in: []`, which matches nothing, as the contract says.
 */
export function buildRoundUpdateFilter(
  _id: ObjectId,
  options: RoundUpdateOptions,
): Filter<RoundDocument> {
  const filter: Filter<RoundDocument> = { _id };
  if (options.ifStatus !== undefined) filter.status = { $in: [...options.ifStatus] };
  if (options.ifPhase !== undefined) filter.phase = { $in: [...options.ifPhase] };
  return filter;
}

/** The update document {@link buildRoundUpdate} makes from a patch. */
export type RoundUpdate = PatchUpdate<RoundPatch>;

/**
 * The Mongo update for `patch` (see {@link RoundPatch}): a key with a value replaces the field as a
 * whole (`$set`), a key whose value is `undefined` removes it (`$unset`). Inside a `$set` value,
 * nested `undefined` fields are left out. Null for an empty patch: Mongo refuses an empty update.
 */
export function buildRoundUpdate(patch: RoundPatch): RoundUpdate | null {
  return buildPatchUpdate(patch);
}
