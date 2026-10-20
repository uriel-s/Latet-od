// Wraps the Express app as the plain Node (req, res) handler a Vercel function exports
// (vercelEntry.ts, bundled into api/index.js, ADR-0002). It builds the app on the first request and keeps it
// for the life of the warm instance, as server.ts does once per process; nothing request-specific
// is kept between requests (serverless).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import type { ApiErrorBody } from '@bottlerun/shared';
import { createApp } from './app.ts';
import type { AppDeps } from './deps.ts';
import { envErrorMessage } from './envDeps.ts';

/** A Node request listener: what a Vercel Node.js function's default export is. */
export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The api as a Vercel function handler, on the deps `buildDeps` returns (normally
 * `() => depsFromEnv(process.env)`, envDeps.ts).
 *
 * The app is built lazily, on the first request, not when the module loads:
 * - a bad env then answers a clean JSON 500 and logs which variable is wrong, instead of crashing
 *   the module load, which Vercel answers with its generic error page (HTML, not the api's JSON);
 * - the module stays importable without any env, so tests can load the real entry.
 *
 * Once built, the same app serves every later request of the warm instance; the Mongo client is
 * module-level anyway (db/mongoClient.ts), so building it again would gain nothing.
 *
 * When `buildDeps` throws, the failure is NOT kept: the request is answered 500 `internal` (never
 * cached), the error's message is logged as one JSON line, and the next request tries again. So a
 * fixed env takes effect without waiting for the instance to be recycled.
 */
export function createVercelHandler(buildDeps: () => AppDeps): NodeRequestHandler {
  let app: Express | undefined;

  return (req, res) => {
    if (app === undefined) {
      let deps: AppDeps;
      try {
        deps = buildDeps();
      } catch (error) {
        logInvalidEnv(error);
        sendInternalError(res);
        return;
      }
      app = createApp(deps);
    }
    app(req, res);
  };
}

/**
 * Logs why the deps could not be built, as ONE line of JSON like the rest of the api's logs
 * (errors.ts): `{ level: 'error', event: 'invalid_env', message }`. Only the message, no stack:
 * the env errors name the variable that is wrong, never its value (envErrorMessage, envDeps.ts).
 */
function logInvalidEnv(error: unknown): void {
  console.error(
    JSON.stringify({ level: 'error', event: 'invalid_env', message: envErrorMessage(error) }),
  );
}

/**
 * Answers 500 with the api's error body `{ error: 'internal' }`, the same answer errors.ts gives a
 * bug or an outage: nothing about the server's insides reaches the client. Written with plain Node
 * calls, because there is no Express app to answer with yet.
 */
function sendInternalError(res: ServerResponse): void {
  const body: ApiErrorBody = { error: 'internal' };
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // A cached error would outlive the fix to the env.
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
