// Unit tests of indexesOnce with a fake collection: created once, retried after a failure.
import { describe, expect, it } from 'vitest';
import type { IndexDescription } from 'mongodb';
import { indexesOnce, type IndexTarget } from './indexes.ts';

const SPECS: readonly IndexDescription[] = [{ key: { token: 1 }, name: 'token_unique' }];

/** A collection that records each createIndexes call and fails the first `failures` of them. */
function fakeCollection(failures = 0): IndexTarget & { calls: IndexDescription[][] } {
  const calls: IndexDescription[][] = [];
  return {
    calls,
    createIndexes(indexSpecs) {
      calls.push(indexSpecs);
      return calls.length <= failures
        ? Promise.reject(new Error('unreachable'))
        : Promise.resolve(['token_unique']);
    },
  };
}

describe('indexesOnce', () => {
  it('creates the indexes on the first call only', async () => {
    const collection = fakeCollection();
    const ensureIndexes = indexesOnce(collection, SPECS);

    await Promise.all([ensureIndexes(), ensureIndexes()]);
    await ensureIndexes();

    expect(collection.calls).toEqual([SPECS]);
  });

  it('does nothing until it is called', () => {
    const collection = fakeCollection();

    indexesOnce(collection, SPECS);

    expect(collection.calls).toEqual([]);
  });

  it('rejects when creating fails, and tries again on the next call', async () => {
    const collection = fakeCollection(1);
    const ensureIndexes = indexesOnce(collection, SPECS);

    await expect(ensureIndexes()).rejects.toThrow('unreachable');
    await ensureIndexes();
    await ensureIndexes();

    expect(collection.calls).toHaveLength(2);
  });
});
