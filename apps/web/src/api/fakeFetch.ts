// Test-only: the fake fetch every api module's tests pass to its endpoints, so no test touches the
// network (CLAUDE.md: fakes, not mocks, for the external interfaces).
import type { FetchFn } from './request.ts';

/**
 * One answer of the fake fetch: an HTTP answer with a JSON (or raw text) body, one with no body
 * at all (a 204, which a Response cannot carry a body with), or no answer.
 */
export type FakeAnswer =
  | { status: number; body: unknown }
  | { status: number; text: string }
  | { status: number; noBody: true }
  | 'networkError'
  | 'throws';

export interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

/**
 * A fake fetch that records every call and gives the `answers` in order. A network error is what
 * a browser's fetch does with no connection: it rejects with a TypeError.
 */
export function makeFakeFetch(...answers: FakeAnswer[]): {
  fetchFn: FetchFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = (input, init) => {
    calls.push({ input, init });
    const answer = answers[calls.length - 1];
    if (answer === undefined) return Promise.reject(new Error(`unexpected call ${calls.length}`));
    if (answer === 'networkError') return Promise.reject(new TypeError('Failed to fetch'));
    if (answer === 'throws') throw new TypeError('fetch is not a function');
    const body =
      'noBody' in answer ? null : 'text' in answer ? answer.text : JSON.stringify(answer.body);
    return Promise.resolve(
      new Response(body, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchFn, calls };
}

/** The JSON body of a recorded call, parsed; fails the test when it has no string body. */
export function jsonBodyOf(call: RecordedCall | undefined): unknown {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body);
}
