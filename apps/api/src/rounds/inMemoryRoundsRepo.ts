// In-memory RoundsRepo: the fake the api tests run against (ADR-0001), so no test touches Atlas.
// It behaves like the Mongo repo where tests can see it: ObjectId-shaped ids, the same sort
// orders, `$set`/`$unset` patches, undefined fields left out, and a copy for every round handed out.
import { randomBytes } from 'node:crypto';
import type { NewRound, Round } from '@bottlerun/shared';
import { withoutUndefined } from '../db/patchUpdate.ts';
import type { RoundListFilter, RoundPatch, RoundUpdateOptions, RoundsRepo } from './roundsRepo.ts';

/**
 * A fake {@link RoundsRepo} that keeps rounds in a Map. Each instance has its own Map and nothing
 * is shared between instances, so every test makes a fresh, empty one. Not for production: the
 * api is serverless and keeps no state between requests.
 *
 * Methods are not `async`: each runs its work inside a `new Promise` executor, which turns a throw
 * into a rejected promise, the way a real database call reports an error.
 */
export class InMemoryRoundsRepo implements RoundsRepo {
  // Insertion order of the Map is creation order: `list()` and `findLatest()` break ties with it.
  private readonly rounds = new Map<string, Round>();

  create(round: NewRound): Promise<Round> {
    return new Promise((resolve) => resolve(this.insert(round)));
  }

  findById(id: string): Promise<Round | null> {
    return new Promise((resolve) => resolve(copyOrNull(this.rounds.get(id))));
  }

  list(filter: RoundListFilter = {}): Promise<Round[]> {
    return new Promise((resolve) => {
      const { statuses } = filter;
      const matching = [...this.rounds.values()].filter(
        (round) => statuses === undefined || statuses.includes(round.status),
      );
      // Array sort is stable, so rounds equal on both keys keep their creation order.
      matching.sort(
        (a, b) => compareText(a.date, b.date) || compareDates(a.createdAt, b.createdAt),
      );
      resolve(matching.map((round) => structuredClone(round)));
    });
  }

  findLatest(): Promise<Round | null> {
    return new Promise((resolve) => {
      let latest: Round | undefined;
      // In creation order, `>=` lets a later round with the same createdAt win the tie.
      for (const round of this.rounds.values()) {
        if (latest === undefined || compareDates(round.createdAt, latest.createdAt) >= 0) {
          latest = round;
        }
      }
      resolve(copyOrNull(latest));
    });
  }

  update(id: string, patch: RoundPatch, options: RoundUpdateOptions = {}): Promise<Round | null> {
    return new Promise((resolve) => resolve(this.applyPatch(id, patch, options)));
  }

  /** Stores a copy of `round` under a new id. */
  private insert(round: NewRound): Round {
    const stored: Round = { ...(withoutUndefined(round) as NewRound), id: this.newId() };
    this.rounds.set(stored.id, stored);
    return structuredClone(stored);
  }

  /** The update itself; null when the round is missing or `ifStatus` does not match. */
  private applyPatch(id: string, patch: RoundPatch, options: RoundUpdateOptions): Round | null {
    const stored = this.rounds.get(id);
    if (stored === undefined) return null;
    if (options.ifStatus !== undefined && !options.ifStatus.includes(stored.status)) return null;

    // Like Mongo's `$set` / `$unset`: a top-level key replaces the field as a whole, and
    // `undefined` removes it. `withoutUndefined` copies the value, so the caller keeps no handle
    // on what is stored.
    const next: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = withoutUndefined(value);
    }
    const updated = next as Round;
    this.rounds.set(id, updated);
    return structuredClone(updated);
  }

  /**
   * A new id in the shape of a Mongo ObjectId's hex string (24 lowercase hex characters), so code
   * that passes ids around, or parses them, behaves the same against the fake.
   */
  private newId(): string {
    let id: string;
    do {
      id = randomBytes(12).toString('hex');
    } while (this.rounds.has(id));
    return id;
  }
}

/** The caller's own copy of a stored round, or null. */
function copyOrNull(round: Round | undefined): Round | null {
  return round === undefined ? null : structuredClone(round);
}

/**
 * Sort comparator for text: a plain comparison, not by locale, like Mongo's sort without a
 * collation. For `YYYY-MM-DD` dates that is by day.
 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Sort comparator for dates, earliest first. */
function compareDates(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}
