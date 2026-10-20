// Tests of the app's shared plumbing (health, 404, body parser, proxy trust, headers) through
// supertest against createApp(fakes): no listen(), no port, no database. POSTs send the site's
// own Host and Origin, to get past the Origin check (tested in sameOrigin.test.ts).
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApp } from './app.ts';
import { createFakeDeps } from './fakeDeps.ts';
import { SAME_ORIGIN_HEADERS } from './testRequest.ts';

const PHONE = '0521234567';

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** All text written to the error and warning logs, for "does not contain" checks. */
function allLogText(): string {
  return [...consoleError.mock.calls, ...consoleWarn.mock.calls].flat().map(String).join('\n');
}

describe('GET /api/health', () => {
  it('returns ok when the database answers, never cached', async () => {
    const res = await request(createApp(createFakeDeps())).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('pings the database on every call (warm-up)', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const app = createApp(createFakeDeps({ db: { ping } }));

    await request(app).get('/api/health');
    await request(app).get('/api/health');

    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('returns 503 not ok when the database does not answer, logging no message', async () => {
    const outage = new Error('Server selection timed out after 5000 ms: cluster0.example.net');
    outage.name = 'MongoServerSelectionError';
    const app = createApp(createFakeDeps({ db: { ping: () => Promise.reject(outage) } }));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      level: 'error',
      method: 'GET',
      route: '/api/health',
      name: 'MongoServerSelectionError',
    });
    expect(allLogText()).not.toContain('cluster0.example.net');
  });
});

describe('unknown api paths', () => {
  it('answer 404 with a JSON error that does not echo the path', async () => {
    // A mistyped customer link: under /api/o, but no route of the customer's page serves it.
    const res = await request(createApp(createFakeDeps())).get('/api/o/some-secret-token/typo');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/u);
    expect(res.body).toEqual({ error: 'not_found' });
    expect(res.text).not.toContain('some-secret-token');
  });
});

describe('request bodies', () => {
  it('answers malformed JSON with 400, logging no part of it', async () => {
    const res = await request(createApp(createFakeDeps()))
      .post('/api/orders')
      .set(SAME_ORIGIN_HEADERS)
      .set('Content-Type', 'application/json')
      .send(`phone ${PHONE}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
    expect(allLogText()).not.toContain(PHONE);
  });

  it('refuses a body over 10kb with 413', async () => {
    const res = await request(createApp(createFakeDeps()))
      .post('/api/orders')
      .set(SAME_ORIGIN_HEADERS)
      .send({ notes: 'x'.repeat(11 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'too_large' });
  });

  it('accepts a body under 10kb', async () => {
    // Not a valid order, so the route answers 400 invalid_order: the parser let the body through
    // to the route instead of refusing it with 413.
    const res = await request(createApp(createFakeDeps()))
      .post('/api/orders')
      .set(SAME_ORIGIN_HEADERS)
      .send({ notes: 'x'.repeat(9 * 1024) });

    expect(res.status).toBe(400);
    expect((res.body as { error?: unknown }).error).toBe('invalid_order');
  });
});

describe('headers and proxy', () => {
  it('does not announce Express', async () => {
    const res = await request(createApp(createFakeDeps())).get('/api/health');

    expect(res.headers).not.toHaveProperty('x-powered-by');
  });

  it('trusts exactly one proxy hop', () => {
    expect(createApp(createFakeDeps()).get('trust proxy')).toBe(1);
  });

  describe('req.ip', () => {
    /** The app with a probe route added by the test (outside /api, so past the 404). */
    function appWithIpProbe(): ReturnType<typeof createApp> {
      const app = createApp(createFakeDeps());
      app.get('/probe/ip', (req, res) => {
        res.json({ ip: req.ip });
      });
      return app;
    }

    it('is the address the proxy added to X-Forwarded-For', async () => {
      const res = await request(appWithIpProbe())
        .get('/probe/ip')
        .set('X-Forwarded-For', '203.0.113.7');

      expect(res.body).toEqual({ ip: '203.0.113.7' });
    });

    it('ignores addresses a client put in X-Forwarded-For itself', async () => {
      // The client sent "198.51.100.1"; the proxy appended the address it really came from.
      const res = await request(appWithIpProbe())
        .get('/probe/ip')
        .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7');

      expect(res.body).toEqual({ ip: '203.0.113.7' });
    });
  });
});
