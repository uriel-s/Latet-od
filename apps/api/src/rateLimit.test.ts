// Tests of the per-IP rate limit through a tiny Express app set up like the real one (one trusted
// proxy hop, the app's error handler), counting in the in-memory AttemptStore on a fake clock, so
// moving past a window takes no waiting.
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AttemptStore } from './attempts/attemptStore.ts';
import { InMemoryAttemptStore } from './attempts/inMemoryAttemptStore.ts';
import { errorHandler } from './errors.ts';
import { rateLimitByIp } from './rateLimit.ts';

/** Not the real order message, so a test passing proves the option is what reaches the body. */
const MESSAGE = 'יותר מדי ניסיונות בבדיקה.';
const MAX = 3;
const WINDOW_MS = 10 * 60 * 1000;
const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.23';

let currentTime: number;
let attempts: InMemoryAttemptStore;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  currentTime = Date.UTC(2026, 9, 19, 8, 0);
  attempts = new InMemoryAttemptStore({ now: () => new Date(currentTime) });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Moves the fake clock forward by `ms`. */
function advance(ms: number): void {
  currentTime += ms;
}

/** The test app, and how many requests reached a route handler (got past the limit). */
interface TestApp {
  app: Express;
  handled: () => number;
}

/**
 * A small app like the real one: one trusted proxy hop (so `req.ip` comes from X-Forwarded-For),
 * `POST /limited` behind the limit with prefix `order:ip` and `POST /other` with prefix `login:ip`,
 * both counting in `store`, then the app's error handler.
 */
function makeTestApp(store: AttemptStore = attempts): TestApp {
  let handled = 0;
  const limit = (keyPrefix: string): RequestHandler =>
    rateLimitByIp({ attempts: store, keyPrefix, max: MAX, windowMs: WINDOW_MS, message: MESSAGE });
  const route: RequestHandler = (_req, res) => {
    handled += 1;
    res.status(201).json({ ok: true });
  };

  const app = express();
  app.set('trust proxy', 1);
  app.post('/limited', limit('order:ip'), route);
  app.post('/other', limit('login:ip'), route);
  app.use(errorHandler);
  return { app, handled: () => handled };
}

/** POSTs to `path` as if the proxy had seen the request come from `ip`. */
function postFrom(app: Express, ip: string, path = '/limited'): request.Test {
  return request(app).post(path).set('X-Forwarded-For', ip);
}

/** Sends `count` requests from `ip`, one after another, and returns their statuses. */
async function sendFrom(app: Express, ip: string, count: number, path?: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent += 1) {
    const res = await postFrom(app, ip, path);
    statuses.push(res.status);
  }
  return statuses;
}

describe('rateLimitByIp', () => {
  it('lets max requests through, then answers 429 without running the route', async () => {
    const { app, handled } = makeTestApp();

    expect(await sendFrom(app, IP, MAX)).toEqual([201, 201, 201]);
    const res = await postFrom(app, IP);

    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/^application\/json/u);
    expect(res.body).toEqual({ error: 'rate_limited', message: MESSAGE });
    expect(res.headers).not.toHaveProperty('retry-after');
    expect(handled()).toBe(MAX);
  });

  it('counts each IP on its own', async () => {
    const { app } = makeTestApp();

    await sendFrom(app, IP, MAX + 1);

    expect((await postFrom(app, OTHER_IP)).status).toBe(201);
    expect((await postFrom(app, IP)).status).toBe(429);
  });

  it('counts under the key `<keyPrefix>:<ip>`', async () => {
    const { app } = makeTestApp();

    await sendFrom(app, IP, 2);

    expect(await attempts.count('order:ip:203.0.113.7', WINDOW_MS)).toBe(2);
  });

  it('keeps the counts of different prefixes apart', async () => {
    const { app } = makeTestApp();

    await sendFrom(app, IP, MAX + 1);
    const res = await postFrom(app, IP, '/other');

    expect(res.status).toBe(201);
    expect(await attempts.count(`order:ip:${IP}`, WINDOW_MS)).toBe(MAX + 1);
    expect(await attempts.count(`login:ip:${IP}`, WINDOW_MS)).toBe(1);
  });

  it('lets the IP through again once the window has passed', async () => {
    const { app } = makeTestApp();
    await sendFrom(app, IP, MAX + 1);

    advance(WINDOW_MS);

    expect((await postFrom(app, IP)).status).toBe(201);
  });

  it('counts blocked attempts too, so a client that keeps trying stays blocked', async () => {
    const { app, handled } = makeTestApp();

    // Minute 0: the client uses up its MAX requests.
    expect(await sendFrom(app, IP, MAX)).toEqual([201, 201, 201]);

    // Halfway through the window it keeps trying: MAX more requests, all blocked, all counted.
    advance(WINDOW_MS / 2);
    expect(await sendFrom(app, IP, MAX)).toEqual([429, 429, 429]);

    // Just past a full window from minute 0, the allowed requests have left the window. If blocked
    // attempts did not count, the window would be empty and this request would pass; the MAX
    // blocked ones are still inside it, so it is blocked.
    advance(WINDOW_MS / 2 + 1000);
    expect((await postFrom(app, IP)).status).toBe(429);

    // A full window after the hammering stopped, only the one attempt above is left: through.
    advance(WINDOW_MS / 2);
    expect((await postFrom(app, IP)).status).toBe(201);
    expect(handled()).toBe(MAX + 1);
  });

  it('answers 500 through the error handler, never reaching the route, when the store fails', async () => {
    // The message names the key, so the test also shows the IP does not reach the log through it.
    const failingStore: AttemptStore = {
      hit: () => Promise.reject(new Error(`connection lost writing order:ip:${IP}`)),
      count: () => Promise.reject(new Error('count is not used by the limit')),
      reset: () => Promise.reject(new Error('reset is not used by the limit')),
    };
    const { app, handled } = makeTestApp(failingStore);

    const res = await postFrom(app, IP);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(handled()).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(IP);
  });

  it('never puts the IP in the response, and logs nothing', async () => {
    const consoleOthers = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    const { app } = makeTestApp();

    await sendFrom(app, IP, MAX);
    const res = await postFrom(app, IP);

    expect(res.status).toBe(429);
    expect(res.text).not.toContain(IP);
    expect(consoleError).not.toHaveBeenCalled();
    for (const spy of consoleOthers) expect(spy).not.toHaveBeenCalled();
  });

  it('still counts a request whose IP Express does not know', async () => {
    // Called directly: through supertest the socket is always there, so `req.ip` is always set.
    const limit = rateLimitByIp({
      attempts,
      keyPrefix: 'order:ip',
      max: MAX,
      windowMs: WINDOW_MS,
      message: MESSAGE,
    });
    const next = vi.fn();

    await limit({ ip: undefined } as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(await attempts.count('order:ip:unknown', WINDOW_MS)).toBe(1);
  });
});
