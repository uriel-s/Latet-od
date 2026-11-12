import { describe, expect, it } from 'vitest';
import { makeFakeFetch } from './fakeFetch.ts';
import { warmUp } from './request.ts';

// What request() decides for every endpoint (a 401, an unknown status, a network error, an
// unexpected error) is checked per endpoint by `describeEveryEndpoint` (request.contract.ts), in
// each resource module's test file.

/** Lets every pending promise callback, and Node's unhandled-rejection check, run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('warmUp', () => {
  it('sends GET /api/health once', () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { ok: true } });

    warmUp(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/health');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('swallows a network error without throwing or an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { fetchFn } = makeFakeFetch('networkError');
      expect(() => warmUp(fetchFn)).not.toThrow();
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows a fetch that throws instead of rejecting', () => {
    const { fetchFn } = makeFakeFetch('throws');

    expect(() => warmUp(fetchFn)).not.toThrow();
  });

  it('ignores an answer that reports the database down', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 503, body: { ok: false } });

    expect(() => warmUp(fetchFn)).not.toThrow();
    await settle();
    expect(calls).toHaveLength(1);
  });
});
