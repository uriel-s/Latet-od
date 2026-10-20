// Tests of the Vercel function handler (createVercelHandler) and of the real entry, vercelEntry.ts
// (the source of the committed bundle api/index.js). supertest serves the plain (req, res) handler
// on its own; no deploy, no database, no network.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppDeps } from './deps.ts';
import { createFakeDeps } from './fakeDeps.ts';
import handler from './vercelEntry.ts';
import { createVercelHandler } from './vercelHandler.ts';

/** What a bad env throws: a message that names the variable, like authDepsFromEnv's. */
const ENV_ERROR = 'SESSION_SECRET is not set: generate one and put it in the hosting env.';

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The one line logged on console.error, parsed; fails the test unless exactly one was logged. */
function onlyErrorLine(): unknown {
  expect(consoleError).toHaveBeenCalledTimes(1);
  return JSON.parse(String(consoleError.mock.calls[0]?.[0]));
}

describe('createVercelHandler', () => {
  it('serves the api: GET /api/health answers ok', async () => {
    const res = await request(createVercelHandler(() => createFakeDeps())).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('builds nothing until the first request', () => {
    const buildDeps = vi.fn(() => createFakeDeps());

    createVercelHandler(buildDeps);

    expect(buildDeps).not.toHaveBeenCalled();
  });

  it('builds the deps once, for every request of the warm instance', async () => {
    const buildDeps = vi.fn(() => createFakeDeps());
    const vercelHandler = createVercelHandler(buildDeps);

    await request(vercelHandler).get('/api/health');
    await request(vercelHandler).get('/api/health');
    const res = await request(vercelHandler).get('/api/nothing-here');

    expect(res.status).toBe(404);
    expect(buildDeps).toHaveBeenCalledTimes(1);
  });

  describe('when the deps cannot be built', () => {
    function failingBuild(): AppDeps {
      throw new Error(ENV_ERROR);
    }

    it('answers 500 internal as JSON, never cached', async () => {
      const res = await request(createVercelHandler(failingBuild)).get('/api/health');

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ error: 'internal' });
    });

    it('logs one JSON line with the message only, no stack', async () => {
      await request(createVercelHandler(failingBuild)).get('/api/health');

      // toEqual: exactly these keys, so no `stack`; and no frame of a stack anywhere in the line.
      expect(onlyErrorLine()).toEqual({ level: 'error', event: 'invalid_env', message: ENV_ERROR });
      expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('vercelHandler.test.ts');
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it('logs a fixed message for a thrown value that is not an Error', async () => {
      const vercelHandler = createVercelHandler(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw 'not an Error';
      });

      const res = await request(vercelHandler).get('/api/health');

      expect(res.status).toBe(500);
      expect(onlyErrorLine()).toEqual({
        level: 'error',
        event: 'invalid_env',
        message: 'api could not start: invalid env',
      });
    });

    it('tries again on the next request, so a fixed env takes effect', async () => {
      const buildDeps = vi
        .fn<() => AppDeps>()
        .mockImplementationOnce(failingBuild)
        .mockImplementation(() => createFakeDeps());
      const vercelHandler = createVercelHandler(buildDeps);

      const first = await request(vercelHandler).get('/api/health');
      const second = await request(vercelHandler).get('/api/health');

      expect(first.status).toBe(500);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ok: true });
      expect(buildDeps).toHaveBeenCalledTimes(2);
    });
  });
});

describe('vercelEntry.ts (the Vercel function entry)', () => {
  it('answers 500 internal and logs the missing variable when the env is empty', async () => {
    // Every variable the api reads, emptied: depsFromEnv throws on MONGODB_URI before any
    // database client exists, so nothing touches the network.
    vi.stubEnv('MONGODB_URI', '');
    vi.stubEnv('COLLECTOR_PASSWORD_HASH', '');
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('PUBLIC_BASE_URL', '');
    vi.stubEnv('MESSAGE_SENDER', '');

    const res = await request(handler).get('/api/health');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(onlyErrorLine()).toMatchObject({
      level: 'error',
      event: 'invalid_env',
      message: expect.stringMatching(/^MONGODB_URI is not set/u) as unknown,
    });
  });
});
