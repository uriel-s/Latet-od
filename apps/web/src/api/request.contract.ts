// Test-only: what every endpoint answers alike, because request() decides it once for all of them
// (a 401, a status the endpoint does not know, a network error, an unexpected error). Each api
// module's test file lists its own endpoints and calls `describeEveryEndpoint` with them, so no
// endpoint goes without these checks.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { makeFakeFetch, type FakeAnswer } from './fakeFetch.ts';
import type { FetchFn } from './request.ts';

/** One endpoint, called the way its screen calls it. */
export interface EndpointCase {
  name: string;
  /** Calls the endpoint. logout's boolean becomes `cleared` / `failed`, so every row reads alike. */
  call: (fetchFn: FetchFn) => Promise<{ kind: string }>;
  /** An answer it succeeds with: queued after a failing one, it would show a retry. */
  success: FakeAnswer;
  /**
   * What a 401 answers: `loggedOut` behind the login, `failed` on a public route, or null when the
   * endpoint gives it a meaning of its own (login: the wrong password, tested with login).
   */
  on401: 'loggedOut' | 'failed' | null;
  /** Statuses `failed` for this endpoint, on top of {@link ALWAYS_FAILED}. */
  alsoFailed: number[];
  /** The body of those failing answers, when it matters that it would look like a success's. */
  failedBody?: unknown;
  /** How many fetches a network error costs: 2 for the booking form, which retries once. */
  networkTries?: number;
}

/** Statuses no endpoint knows: each answers `failed`, without a retry. */
const ALWAYS_FAILED = [403, 500, 502, 503];

/** What no log line may hold, whatever the endpoint: a path (it can hold a token), a phone, an address. */
const ALWAYS_SECRET = ['/api/', '+97250', 'דרך רבין'];

/** An answer with `status` and `body`; a 204 has none, since a Response cannot carry one. */
function answerWith(status: number, body: unknown): FakeAnswer {
  return status === 204 ? { status, noBody: true } : { status, body };
}

/**
 * A fetch whose answer breaks as it is read: a stand-in for any bug past the network, which the
 * endpoint must log and answer as `failed` instead of rejecting.
 */
const brokenAnswerFetch: FetchFn = () =>
  Promise.resolve({
    get status(): number {
      throw new Error('broken answer');
    },
  } as unknown as Response);

/**
 * Runs the shared checks on `endpoints`. `secrets` are what the module's own requests carry that
 * must never reach a log line (a password, a token), on top of {@link ALWAYS_SECRET}.
 */
export function describeEveryEndpoint(endpoints: EndpointCase[], secrets: string[] = []): void {
  describe('every endpoint', () => {
    let consoleError: MockInstance<typeof console.error>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    const with401 = endpoints.filter(({ on401 }) => on401 !== null);
    // it.each refuses an empty table, and a module whose every endpoint gives 401 a meaning of its
    // own has nothing to check here.
    if (with401.length > 0) {
      it.each(with401)(
        '$name answers $on401 on 401, whatever the body says',
        async ({ call, on401 }) => {
          for (const answer of [
            { status: 401, body: { error: 'unauthenticated' } },
            { status: 401, text: 'Unauthorized' },
          ]) {
            const { fetchFn, calls } = makeFakeFetch(answer);
            expect(await call(fetchFn), JSON.stringify(answer)).toEqual({ kind: on401 });
            expect(calls).toHaveLength(1);
          }
        },
      );
    }

    it.each(endpoints)(
      '$name answers failed on any other status, without a retry',
      async ({ call, success, alsoFailed, failedBody = { error: 'x' } }) => {
        for (const status of [...ALWAYS_FAILED, ...alsoFailed]) {
          const { fetchFn, calls } = makeFakeFetch(answerWith(status, failedBody), success);
          expect(await call(fetchFn), String(status)).toEqual({ kind: 'failed' });
          expect(calls, String(status)).toHaveLength(1);
        }
        expect(consoleError).not.toHaveBeenCalled();
      },
    );

    it.each(endpoints)(
      '$name answers failed after a network error or a fetch that throws, without logging',
      async ({ call, success, networkTries = 1 }) => {
        for (const answer of ['networkError', 'throws'] as const) {
          const answers: FakeAnswer[] = Array.from({ length: networkTries }, () => answer);
          const { fetchFn, calls } = makeFakeFetch(...answers, success);
          expect(await call(fetchFn), answer).toEqual({ kind: 'failed' });
          expect(calls, answer).toHaveLength(networkTries);
        }
        expect(consoleError).not.toHaveBeenCalled();
      },
    );

    it.each(endpoints)(
      '$name logs an unexpected error, without the request, and answers failed',
      async ({ call }) => {
        expect(await call(brokenAnswerFetch)).toEqual({ kind: 'failed' });

        expect(consoleError).toHaveBeenCalledTimes(1);
        // Never the body (a phone, an address, a password) or the path (it can hold a token).
        const logged = consoleError.mock.calls.flat().map(String).join(' ');
        for (const secret of [...ALWAYS_SECRET, ...secrets]) {
          expect(logged).not.toContain(secret);
        }
      },
    );
  });
}
