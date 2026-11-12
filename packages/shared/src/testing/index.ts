// Helpers for tests, shared by every workspace: `@bottlerun/shared/testing` (its own entry in
// packages/shared/package.json, so nothing in the main `@bottlerun/shared` entry pulls it into a
// production bundle). Plain TypeScript with no vitest import, so any test runner can load it.
// Only test files may import it: *.test.ts(x) and *.contract.ts (enforced in eslint.config.js).
import { STREETS, type Street } from '../streets.ts';

/** A promise and the function that settles it, from {@link deferred}. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/**
 * A promise the test settles by hand, to look at a screen while its request is on its way: hand
 * `promise` to a fake, check the in-flight state, then call `resolve`.
 */
export function deferred<T>(): Deferred<T> {
  // Replaced synchronously by the Promise executor below; the no-op only satisfies the type.
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The first street of the real list (data/streets.json) that matches, or a failed test if there
 * is none. Tests use real streets, not invented ones, so a region or map point they rely on is one
 * the app really has.
 */
export function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}
