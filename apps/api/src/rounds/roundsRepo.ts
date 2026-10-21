// The only door to stored rounds (ADR-0001: the database is reached through repositories, with an
// in-memory fake for tests). Like OrdersRepo it is dumb storage: the round service decides status,
// phase, timestamps and which orders go in. Nothing about rounds needs a unique index (the rule
// "an order is in at most one open round", spec §4, lives on the order's `roundId`), so unlike
// OrdersRepo it throws no domain error. The same contract suite (roundsRepo.contract.ts) runs
// against every implementation.
import type { NewRound, Round, RoundPhase, RoundStatus } from '@bottlerun/shared';

/** Fields an update may change. `id` and `createdAt` are fixed once the round exists. */
type PatchableRound = Omit<Round, 'id' | 'createdAt'>;

/**
 * A change to a round, with the same meaning as `OrderPatch`: each key present replaces that field
 * as a whole (`orderIds` or `stops` too, like Mongo's `$set`). A key present with the value
 * `undefined` removes the field (Mongo `$unset`), e.g. `{ personalText: undefined }`. Only
 * optional fields may be removed: removing a required one leaves a round that no longer parses.
 *
 * The repo sets nothing on its own, not even `closedAt`: the service puts it in the patch.
 */
export type RoundPatch = Partial<PatchableRound>;

/** Which rounds `list()` returns. Every given filter must match (AND); none means every round. */
export interface RoundListFilter {
  /** Rounds in one of these statuses. An empty list matches no round (like Mongo `$in: []`). */
  statuses?: readonly RoundStatus[];
}

/** Conditions on `update()`. Every given condition must match (AND); none means no condition. */
export interface RoundUpdateOptions {
  /**
   * Apply the patch only if the stored status is one of these. The check and the write are one
   * atomic step, so two taps racing on the same round (or a request from an old screen after the
   * round was closed) cannot both change it: the loser gets null. An empty list matches no round
   * (like Mongo `$in: []`).
   */
  ifStatus?: readonly RoundStatus[];

  /**
   * Apply the patch only if the stored phase is one of these. Like `ifStatus`, the check and the
   * write are one atomic step: of two racing "סגור אישורים ובנה מסלול" taps (`ifPhase:
   * ['confirming']`, patch `{ phase: 'routed', stops }`), only the first wins and the second gets
   * null. Given with `ifStatus`, both must match. An empty list matches no round (like `$in: []`).
   */
  ifPhase?: readonly RoundPhase[];
}

/** Stored rounds (collection `rounds`). Every round returned is the caller's own copy. */
export interface RoundsRepo {
  /**
   * Stores a new round and returns it with its id (an ObjectId's 24-character hex string). Fields
   * whose value is `undefined` are left out, at any depth.
   */
  create(round: NewRound): Promise<Round>;

  /** The round with this id, or null. An unknown or malformed id gives null, never an error. */
  findById(id: string): Promise<Round | null>;

  /**
   * Rounds matching `filter`, by day: `date` ascending, then `createdAt` ascending, then creation
   * order. `date` is `YYYY-MM-DD`, so comparing it as text is comparing it as a day.
   */
  list(filter?: RoundListFilter): Promise<Round[]>;

  /**
   * The round created last (`createdAt` descending; ties go to the one created last), whatever
   * its status or date; null when there is none. The planning screen pre-fills "עד איזו שעה"
   * from it (ADR-0003).
   */
  findLatest(): Promise<Round | null>;

  /**
   * Applies `patch` (see {@link RoundPatch}) and returns the updated round. Returns null, and
   * changes nothing, when the id is unknown or malformed, or when `options.ifStatus` or
   * `options.ifPhase` does not match the stored round. An empty patch returns the round as it is
   * (still null on such a mismatch).
   */
  update(id: string, patch: RoundPatch, options?: RoundUpdateOptions): Promise<Round | null>;
}
