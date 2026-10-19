// Tests of the error middleware and the error log, through a tiny Express app with the same body
// parser as the real one. The main promise: whatever goes wrong, no phone, body or token reaches
// the log, and the client gets a short code, never the server's detail.
import express, { type Express } from 'express';
import { MongoServerError } from 'mongodb';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { errorHandler, logError } from './errors.ts';

const PHONE = '0521234567';
const E164_PHONE = '+972521234567';
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A duplicate-key error as the driver reports it: the message quotes the duplicate phone. */
function duplicatePhoneError(): MongoServerError {
  return new MongoServerError({
    errmsg: `E11000 duplicate key error collection: bottlerun.orders index: one_open_order_per_phone dup key: { contact.phone: "${E164_PHONE}" }`,
    code: 11000,
  });
}

/** A small app: the real body parser (with a small limit), a few failing routes, errorHandler. */
function makeTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/api/echo', (req, res) => {
    res.json(req.body);
  });
  app.post('/api/orders', () => {
    throw duplicatePhoneError();
  });
  app.get('/api/o/:token', () => {
    throw new Error(`no order for token ${TOKEN}`);
  });
  app.get('/api/type-error', (req) => {
    // A real engine TypeError: reading a property of undefined.
    const missing = (req.query as Record<string, { length: number } | undefined>).missing;
    return missing!.length;
  });
  app.get('/api/node-type-error', () => {
    // Node's argument check quotes the value it received in its message.
    return Buffer.alloc(PHONE as unknown as number);
  });
  app.get('/api/multi-line', () => {
    throw new Error(`first line\nphone ${PHONE}`);
  });
  app.get('/api/not-an-error', (_req, _res, next) => {
    next({ phone: PHONE });
  });
  app.get('/api/forbidden', () => {
    throw Object.assign(new Error(`not for ${PHONE}`), { statusCode: 403 });
  });
  app.get('/api/partial', (_req, res) => {
    // Headers and part of the body are already on their way when the route fails.
    res.status(200).write('partial');
    throw new Error(`late failure for ${PHONE}`);
  });
  app.use(errorHandler);
  return app;
}

/**
 * Every argument passed to console.error and console.warn. Each call must have been exactly one
 * line of JSON; returns the parsed entries.
 */
function loggedEntries(spy: MockInstance<typeof console.error>): Record<string, unknown>[] {
  return spy.mock.calls.map((args) => {
    expect(args).toHaveLength(1);
    const line: unknown = args[0];
    expect(typeof line).toBe('string');
    expect(line).not.toContain('\n');
    return JSON.parse(line as string) as Record<string, unknown>;
  });
}

/** All text written to the error and warning logs, for "does not contain" checks. */
function allLogText(): string {
  return [...consoleError.mock.calls, ...consoleWarn.mock.calls]
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join('\n');
}

describe('errorHandler: client mistakes', () => {
  it('answers malformed JSON with 400 invalid_json, logging no part of the body', async () => {
    const res = await request(makeTestApp())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      // Its parse error message quotes this text, and the error carries it as `body`.
      .send(`phone ${PHONE}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
    expect(consoleError).not.toHaveBeenCalled();
    expect(loggedEntries(consoleWarn)).toEqual([
      { level: 'warn', event: 'bad_request', status: 400, type: 'entity.parse.failed' },
    ]);
    expect(allLogText()).not.toContain(PHONE);
  });

  it('answers a body over the limit with 413 too_large', async () => {
    const res = await request(makeTestApp())
      .post('/api/echo')
      .send({ phone: PHONE, notes: 'x'.repeat(2000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'too_large' });
    expect(loggedEntries(consoleWarn)).toEqual([
      { level: 'warn', event: 'bad_request', status: 413, type: 'entity.too.large' },
    ]);
    expect(allLogText()).not.toContain(PHONE);
  });

  it('answers another 4xx error with its status and bad_request, logging no message', async () => {
    const res = await request(makeTestApp()).get('/api/forbidden');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'bad_request' });
    expect(consoleError).not.toHaveBeenCalled();
    expect(loggedEntries(consoleWarn)).toEqual([
      { level: 'warn', event: 'bad_request', status: 403 },
    ]);
    expect(allLogText()).not.toContain(PHONE);
  });

  it('lets a valid body through', async () => {
    const res = await request(makeTestApp()).post('/api/echo').send({ phone: PHONE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ phone: PHONE });
    expect(allLogText()).toBe('');
  });
});

describe('errorHandler: server errors', () => {
  it('answers 500 internal and logs a Mongo error by name and code, without its message', async () => {
    const res = await request(makeTestApp()).post('/api/orders').send({ phone: PHONE });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    const [entry] = loggedEntries(consoleError);
    expect(entry).toMatchObject({
      level: 'error',
      method: 'POST',
      route: '/api/orders',
      name: 'MongoServerError',
      code: 11000,
    });
    expect(entry).not.toHaveProperty('message');
    expect(entry?.stack).toMatch(/^\s+at /u);
    expect(allLogText()).not.toContain(E164_PHONE);
    expect(allLogText()).not.toContain(PHONE);
  });

  it('logs the route pattern, never the token in the url', async () => {
    const res = await request(makeTestApp()).get(`/api/o/${TOKEN}`);

    expect(res.status).toBe(500);
    expect(loggedEntries(consoleError)).toEqual([
      expect.objectContaining({ method: 'GET', route: '/api/o/:token', name: 'Error' }),
    ]);
    expect(allLogText()).not.toContain(TOKEN);
  });

  it('logs the message and stack of an engine TypeError', async () => {
    const res = await request(makeTestApp()).get('/api/type-error');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    const [entry] = loggedEntries(consoleError);
    expect(entry).toMatchObject({ name: 'TypeError', route: '/api/type-error' });
    expect(entry?.message).toMatch(/Cannot read properties of undefined/u);
    expect(entry?.stack).toMatch(/^TypeError: Cannot read properties of undefined/u);
  });

  it("drops the message of Node's own TypeErrors, which quote the value received", async () => {
    await request(makeTestApp()).get('/api/node-type-error');

    const [entry] = loggedEntries(consoleError);
    expect(entry).toMatchObject({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    expect(entry).not.toHaveProperty('message');
    expect(allLogText()).not.toContain(PHONE);
  });

  it('drops every line of a multi-line message from the stack', async () => {
    await request(makeTestApp()).get('/api/multi-line');

    const [entry] = loggedEntries(consoleError);
    expect(entry?.stack).not.toContain('first line');
    expect(allLogText()).not.toContain(PHONE);
  });

  it('logs a thrown value that is not an Error as NonError only', async () => {
    const res = await request(makeTestApp()).get('/api/not-an-error');

    expect(res.status).toBe(500);
    expect(loggedEntries(consoleError)).toEqual([
      { level: 'error', method: 'GET', route: '/api/not-an-error', name: 'NonError' },
    ]);
    expect(allLogText()).not.toContain(PHONE);
  });

  it('closes the connection when headers were already sent, logging safely', async () => {
    // The response is cut off, so the client sees a failed request or a truncated body.
    await request(makeTestApp())
      .get('/api/partial')
      .then(
        () => undefined,
        () => undefined,
      );

    expect(loggedEntries(consoleError)).toEqual([
      expect.objectContaining({ level: 'error', route: '/api/partial', name: 'Error' }),
    ]);
    expect(allLogText()).not.toContain(PHONE);
  });
});

describe('logError', () => {
  it('logs without method and route outside a request', () => {
    logError(new RangeError('Invalid time value'));

    expect(loggedEntries(consoleError)).toEqual([
      {
        level: 'error',
        name: 'RangeError',
        message: 'Invalid time value',
        stack: expect.stringMatching(/^RangeError: Invalid time value/u) as unknown,
      },
    ]);
  });
});
