// The behaviour every AttemptStore must have, as a reusable Vitest suite: the in-memory fake runs
// it in inMemoryAttemptStore.test.ts and the Mongo store runs the same one. Deliberately not
// named *.test.ts: it only declares tests when an implementation calls it.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AttemptStore } from './attemptStore.ts';

const MINUTE_MS = 60_000;
/** The login window per IP (ADR-0004): 5 failures in 15 minutes. */
const WINDOW_MS = 15 * MINUTE_MS;
/** The window of the overall login cap (ADR-0004): 30 failures in an hour. */
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Where the suite's clock starts. In the future on purpose: a real Mongo's TTL monitor deletes by
 * the real clock, and would remove attempts stamped with a past fake time in the middle of a test.
 */
const START_MS = Date.parse('2100-01-01T00:00:00.000Z');

/**
 * Declares the AttemptStore contract tests for one implementation.
 *
 * @param name Shown in the test names, e.g. 'InMemoryAttemptStore'.
 * @param makeStore Called before every test with the suite's fake clock, which the store must use
 *   for every timestamp; must return an EMPTY store.
 */
export function describeAttemptStoreContract(
  name: string,
  makeStore: (now: () => Date) => AttemptStore | Promise<AttemptStore>,
): void {
  describe(`AttemptStore contract: ${name}`, () => {
    let nowMs: number;
    let store: AttemptStore;

    /** Moves the suite's clock forward. */
    function advance(ms: number): void {
      nowMs += ms;
    }

    beforeEach(async () => {
      nowMs = START_MS;
      store = await makeStore(() => new Date(nowMs));
    });

    it('counts each hit, the new one included', async () => {
      expect(await store.hit('login:ip:1.2.3.4', WINDOW_MS)).toBe(1);
      expect(await store.hit('login:ip:1.2.3.4', WINDOW_MS)).toBe(2);
      expect(await store.hit('login:ip:1.2.3.4', WINDOW_MS)).toBe(3);
    });

    it('counts every key on its own', async () => {
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);

      expect(await store.hit('login:ip:5.6.7.8', WINDOW_MS)).toBe(1);
      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(2);
      expect(await store.count('order:ip:1.2.3.4', WINDOW_MS)).toBe(0);
    });

    it('counts without recording an attempt', async () => {
      expect(await store.count('login:all', HOUR_MS)).toBe(0);
      await store.hit('login:all', HOUR_MS);

      expect(await store.count('login:all', HOUR_MS)).toBe(1);
      expect(await store.count('login:all', HOUR_MS)).toBe(1);
      expect(await store.hit('login:all', HOUR_MS)).toBe(2);
    });

    it('stops counting each attempt once its window has passed', async () => {
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);
      advance(10 * MINUTE_MS);
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);

      advance(5 * MINUTE_MS);
      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(1);
      advance(10 * MINUTE_MS);
      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(0);
    });

    it('counts an attempt 1 ms inside the window, not one exactly windowMs old', async () => {
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);

      advance(WINDOW_MS - 1);
      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(1);
      advance(1);
      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(0);
    });

    it('leaves old attempts out of the number a hit returns', async () => {
      await store.hit('order:ip:1.2.3.4', WINDOW_MS);
      await store.hit('order:ip:1.2.3.4', WINDOW_MS);
      advance(WINDOW_MS);

      expect(await store.hit('order:ip:1.2.3.4', WINDOW_MS)).toBe(1);
    });

    it('uses the window it is given', async () => {
      await store.hit('login:all', HOUR_MS);
      advance(20 * MINUTE_MS);
      await store.hit('login:all', HOUR_MS);
      advance(20 * MINUTE_MS);
      await store.hit('login:all', HOUR_MS);

      advance(19 * MINUTE_MS);
      expect(await store.count('login:all', HOUR_MS)).toBe(3);
      advance(2 * MINUTE_MS);
      expect(await store.count('login:all', HOUR_MS)).toBe(2);
    });

    it('reset forgets only the given key', async () => {
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);
      await store.hit('login:ip:1.2.3.4', WINDOW_MS);
      await store.hit('login:all', HOUR_MS);

      await store.reset('login:ip:1.2.3.4');

      expect(await store.count('login:ip:1.2.3.4', WINDOW_MS)).toBe(0);
      expect(await store.count('login:all', HOUR_MS)).toBe(1);
      expect(await store.hit('login:ip:1.2.3.4', WINDOW_MS)).toBe(1);
    });

    it('reset of a key with no attempts does nothing', async () => {
      await store.hit('login:all', HOUR_MS);

      await store.reset('login:ip:9.9.9.9');

      expect(await store.count('login:all', HOUR_MS)).toBe(1);
    });
  });
}
