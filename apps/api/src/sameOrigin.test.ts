// Tests of the Origin check (CSRF, ADR-0004): first through a tiny Express app set up like the
// real one (one trusted proxy hop, the check, one route for every method that counts the requests
// it ran for), then through createApp, to see it is mounted on every path, before the body parser.
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { errorHandler } from './errors.ts';
import { createFakeDeps } from './fakeDeps.ts';
import { requireSameOrigin } from './sameOrigin.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST, TEST_ORIGIN } from './testRequest.ts';

/** The origin of a page on another site. */
const FOREIGN_ORIGIN = 'https://evil.example';

/** Methods that change something: the check applies to them. */
const UNSAFE_METHODS = ['post', 'put', 'patch', 'delete'] as const;
/** Methods that only read: the check never refuses them. */
const SAFE_METHODS = ['get', 'head', 'options'] as const;

type Method = (typeof UNSAFE_METHODS)[number] | (typeof SAFE_METHODS)[number];

afterEach(() => {
  vi.restoreAllMocks();
});

/** The test app, and how many requests reached the route (got past the check). */
interface TestApp {
  app: Express;
  handled: () => number;
}

/**
 * A small app like the real one: one trusted proxy hop (so X-Forwarded-Host is read), the check,
 * then `/probe` for every method, answering 200, then the app's error handler.
 */
function makeTestApp(): TestApp {
  let handled = 0;
  const app = express();
  app.set('trust proxy', 1);
  app.use(requireSameOrigin());
  app.all('/probe', (_req, res) => {
    handled += 1;
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return { app, handled: () => handled };
}

/**
 * A `method` request to /probe, sent to {@link TEST_HOST}, with `origin` as its Origin header
 * (none at all when undefined).
 */
function send(app: Express, method: Method, origin: string | undefined): request.Test {
  const req = request(app)[method]('/probe').set('Host', TEST_HOST);
  if (origin !== undefined) req.set('Origin', origin);
  return req;
}

describe('requireSameOrigin', () => {
  it.each(UNSAFE_METHODS)('lets a same-origin %s through to the route', async (method) => {
    const { app, handled } = makeTestApp();

    const res = await send(app, method, TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(handled()).toBe(1);
  });

  it.each(UNSAFE_METHODS)(
    'refuses a %s from another site with 403 forbidden_origin, without running the route',
    async (method) => {
      const { app, handled } = makeTestApp();

      const res = await send(app, method, FOREIGN_ORIGIN);

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/^application\/json/u);
      expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
      expect(handled()).toBe(0);
    },
  );

  it.each(SAFE_METHODS)('never refuses a %s, even from another site', async (method) => {
    const { app, handled } = makeTestApp();

    const res = await send(app, method, FOREIGN_ORIGIN);

    expect(res.status).toBe(200);
    expect(handled()).toBe(1);
  });

  it.each([
    { label: 'with no Origin (not a browser)', origin: undefined },
    { label: 'with Origin: null (a sandboxed or data: page)', origin: 'null' },
    { label: 'with an empty Origin', origin: '' },
    { label: 'with an Origin that is not a URL', origin: TEST_HOST },
    { label: 'from the same host name on another port', origin: `https://${TEST_HOST}:8443` },
    {
      label: 'from a host that only starts with ours',
      origin: `https://${TEST_HOST}.evil.example`,
    },
  ])('refuses a POST $label', async ({ origin }) => {
    const { app, handled } = makeTestApp();

    const res = await send(app, 'post', origin);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(handled()).toBe(0);
  });

  it('compares the host only, not the scheme (TLS ends at the proxy)', async () => {
    const { app } = makeTestApp();

    const res = await send(app, 'post', `http://${TEST_HOST}`);

    expect(res.status).toBe(200);
  });

  it('compares host names case-insensitively', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/probe')
      .set('Host', TEST_HOST.toUpperCase())
      .set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
  });

  describe('behind the proxy', () => {
    /** The host the proxy connects to, as opposed to the public one the browser used. */
    const INTERNAL_HOST = 'bottlerun-api.internal';

    it('compares with the host the proxy forwarded (X-Forwarded-Host)', async () => {
      const { app } = makeTestApp();

      const res = await request(app)
        .post('/probe')
        .set('Host', INTERNAL_HOST)
        .set('X-Forwarded-Host', TEST_HOST)
        .set('Origin', TEST_ORIGIN);

      expect(res.status).toBe(200);
    });

    it('refuses an Origin that matches only the Host behind the proxy', async () => {
      const { app, handled } = makeTestApp();

      const res = await request(app)
        .post('/probe')
        .set('Host', INTERNAL_HOST)
        .set('X-Forwarded-Host', TEST_HOST)
        .set('Origin', `https://${INTERNAL_HOST}`);

      expect(res.status).toBe(403);
      expect(handled()).toBe(0);
    });
  });

  it('echoes nothing of the request and logs nothing', async () => {
    const consoleSpies = (['error', 'warn', 'log', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { app } = makeTestApp();

    const res = await send(app, 'post', FOREIGN_ORIGIN).set('X-Forwarded-For', '203.0.113.7');

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('evil.example');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('createApp: the Origin check', () => {
  it('runs before the body parser: malformed JSON from another site gets 403, not 400', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await request(createApp(createFakeDeps()))
      .post('/api/orders')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    // The body parser would have logged its failure as a warning: it never ran.
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('covers every path, routes added later included: an unknown /api path gets 403, not 404', async () => {
    const app = createApp(createFakeDeps());

    const foreign = await request(app)
      .post('/api/no-such-route')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN);
    const sameOrigin = await request(app).post('/api/no-such-route').set(SAME_ORIGIN_HEADERS);

    expect(foreign.status).toBe(403);
    expect(sameOrigin.status).toBe(404);
  });

  it('lets a GET from another site through: /api/health answers 200', async () => {
    const res = await request(createApp(createFakeDeps()))
      .get('/api/health')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
