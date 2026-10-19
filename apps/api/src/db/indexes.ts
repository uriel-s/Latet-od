// Creates a collection's indexes lazily, once per repository instance, before its first operation.
// The api has no deploy-time migration step and no background jobs (serverless, ADR-0002), so the
// first request of each instance makes sure the indexes the rules rely on (one open order per
// phone, the TTL of attempts) exist. When they already do, this is a single quick no-op command.
import type { IndexDescription } from 'mongodb';

/** What {@link indexesOnce} needs from a collection: a `Collection` from the driver, or a fake. */
export interface IndexTarget {
  createIndexes(indexSpecs: IndexDescription[]): Promise<unknown>;
}

/**
 * Returns a function that creates `specs` on `collection` the first time it is called and only
 * waits for that same work on later calls. If creating fails (e.g. Atlas unreachable), that call
 * rejects and the next one tries again, so one failed cold start does not break the instance.
 *
 * An index whose name exists with different options makes the server refuse (IndexOptionsConflict),
 * and then every operation of the repo fails loudly: change an index by dropping it in Atlas first.
 */
export function indexesOnce(
  collection: IndexTarget,
  specs: readonly IndexDescription[],
): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= collection.createIndexes([...specs]).then(
      () => undefined,
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };
}
