// In-memory AttemptStore: the fake that rate-limit and login tests run against (ADR-0004).
// Time comes from an injected clock, so a test moves past a window without waiting.
import type { AttemptStore, AttemptStoreOptions } from './attemptStore.ts';

/** One recorded attempt, as epoch milliseconds. */
interface Attempt {
  at: number;
  /** When the attempt may be deleted: `at` plus the window it was recorded with. */
  expiresAt: number;
}

/**
 * A fake {@link AttemptStore} that keeps attempts in a Map. Each instance has its own Map; not
 * for production, where the api is serverless and an in-memory count would reset on every
 * cold start and differ between instances.
 */
export class InMemoryAttemptStore implements AttemptStore {
  private readonly attempts = new Map<string, Attempt[]>();
  private readonly now: () => Date;

  constructor(options: AttemptStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  hit(key: string, windowMs: number): Promise<number> {
    const nowMs = this.dropExpired();
    const attempts = this.attempts.get(key) ?? [];
    attempts.push({ at: nowMs, expiresAt: nowMs + windowMs });
    this.attempts.set(key, attempts);
    return Promise.resolve(countInWindow(attempts, nowMs, windowMs));
  }

  count(key: string, windowMs: number): Promise<number> {
    const nowMs = this.dropExpired();
    return Promise.resolve(countInWindow(this.attempts.get(key) ?? [], nowMs, windowMs));
  }

  reset(key: string): Promise<void> {
    this.attempts.delete(key);
    return Promise.resolve();
  }

  /**
   * Deletes every expired attempt, and keys left with none, like the TTL index does in Mongo,
   * so a long-running store does not grow with every IP it has seen. Returns the current time.
   */
  private dropExpired(): number {
    const nowMs = this.now().getTime();
    for (const [key, attempts] of this.attempts) {
      const live = attempts.filter((attempt) => attempt.expiresAt > nowMs);
      if (live.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, live);
    }
    return nowMs;
  }
}

/** Attempts made after `nowMs - windowMs` (see the window rule on {@link AttemptStore}). */
function countInWindow(attempts: readonly Attempt[], nowMs: number, windowMs: number): number {
  return attempts.filter((attempt) => attempt.at > nowMs - windowMs).length;
}
