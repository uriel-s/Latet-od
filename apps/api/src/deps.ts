// What the api needs from the world outside its own code, passed to createApp(deps). Production
// builds the Mongo implementations once per process (db/mongoDeps.ts); tests pass in-memory fakes
// (fakeDeps.ts), so no test touches the network or Atlas.
import type { AttemptStore } from './attempts/attemptStore.ts';
import type { OrdersRepo } from './orders/ordersRepo.ts';

/** Everything the app talks to outside itself; tests pass fakes (CLAUDE.md: every external call behind an interface). */
export interface AppDeps {
  /** Stored orders (collection `orders`). */
  orders: OrdersRepo;
  /** Attempt counts for login limits and the form's rate limit (ADR-0004). */
  attempts: AttemptStore;
  /** Whether the database answers, for /api/health. */
  db: DbHealth;
}

/** Whether the database answers. /api/health uses it, which also opens the connection early (warm-up, ADR-0002). */
export interface DbHealth {
  /** Resolves when the database answers; rejects when it cannot be reached. */
  ping(): Promise<void>;
}
