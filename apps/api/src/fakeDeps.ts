// In-memory dependencies for api tests: route tests build their app with
// `createApp(createFakeDeps())`, and override one piece when they need to see or steer it.
import { InMemoryAttemptStore } from './attempts/inMemoryAttemptStore.ts';
import type { AppDeps } from './deps.ts';
import { InMemoryOrdersRepo } from './orders/inMemoryOrdersRepo.ts';

/**
 * Fresh, empty fakes for every dependency: an {@link InMemoryOrdersRepo}, an
 * {@link InMemoryAttemptStore} on the real clock, and a database whose ping always answers.
 * Each call makes new instances, so tests never share state.
 *
 * @param overrides Pieces to use instead, e.g. `{ db: { ping: () => Promise.reject(...) } }` for a
 *   database that is down, or a repo the test keeps a reference to and inspects.
 */
export function createFakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    orders: new InMemoryOrdersRepo(),
    attempts: new InMemoryAttemptStore(),
    db: { ping: () => Promise.resolve() },
    ...overrides,
  };
}
