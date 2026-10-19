// How the api reports errors: one error middleware for the whole app, and one way to log an error.
// Logs are where request data leaks most easily (CLAUDE.md, privacy: never log request bodies,
// phones, addresses or tokens), and on Vercel anyone with access to the project reads them. So an
// error is logged as one line of JSON built from an allow-list of fields that cannot hold a
// customer's data, and never handed to Express's default handler, which prints the whole error.
import type { ErrorRequestHandler, Request, Response } from 'express';
import type { ApiErrorBody } from '@bottlerun/shared';

/** One error as it is logged: only fields that cannot hold request data (see {@link logError}). */
interface LoggedError {
  name: string;
  code?: string | number;
  message?: string;
  stack?: string;
}

/**
 * Logs `error` as ONE line of JSON on `console.error`:
 * `{ level: 'error', method, route, name, code, message?, stack? }`.
 *
 * Privacy rules, because error messages and URLs carry customer data:
 * - Never the body, query, headers or URL: a path like `/api/o/<token>` holds the secret of a
 *   customer's page. `route` is the matched route PATTERN (`/api/o/:token`), when there is one.
 * - `message` and the full `stack` (whose first line repeats the message) only for errors whose
 *   message the JavaScript engine writes from code, never from data: TypeError, ReferenceError,
 *   RangeError (see {@link isEngineError}). Every other error is logged with its `name`, its
 *   `code` and the stack frames only, because its message may quote data: a Mongo E11000 message
 *   holds the duplicate phone, and a `JSON.parse` SyntaxError quotes the body it failed on.
 * - A thrown value that is not an Error (say, a string) is logged as `name: 'NonError'` only.
 *
 * Code that throws a TypeError or RangeError itself must therefore never put data in its message.
 *
 * @param req The request being handled, for its method and route pattern; omit outside a request.
 */
export function logError(error: unknown, req?: Request): void {
  console.error(
    JSON.stringify({
      level: 'error',
      method: req?.method,
      // JSON.stringify leaves out keys whose value is undefined.
      route: req === undefined ? undefined : routePattern(req),
      ...describeError(error),
    }),
  );
}

/**
 * The app's single error middleware: register it last. Every error a route throws or passes to
 * `next()` (Express 5 forwards rejected promises too) ends here.
 *
 * - Client mistakes the body parser reports: malformed JSON → 400 `invalid_json`, a body over the
 *   limit → 413 `too_large`, any other error with a 4xx `status` → that status, `bad_request`.
 *   Logged as one `warn` line with the status and the error's type only: their messages and their
 *   `body` property quote what the client sent.
 * - Anything else is a bug or an outage: logged with {@link logError}, answered 500 `internal`
 *   with no detail, so nothing about the server's insides reaches the client.
 *
 * Once headers are sent, the status can no longer change. Express's convention is `next(err)`,
 * but its final handler prints the whole error with `console.error`, message and body included,
 * so this logs the error safely and closes the connection, which is what that handler would do.
 *
 * It takes four parameters although `next` is never called: Express treats a middleware as an
 * error handler only when the function takes exactly four.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs the 4th parameter
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (res.headersSent) {
    logError(error, req);
    res.destroy();
    return;
  }

  const clientError = clientErrorResponse(error);
  if (clientError !== undefined) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'bad_request',
        status: clientError.status,
        type: clientError.type,
      }),
    );
    sendError(res, clientError.status, clientError.code);
    return;
  }

  logError(error, req);
  sendError(res, 500, 'internal');
};

/** Answers with the api's error body `{ error: code }`. */
function sendError(res: Response, status: number, code: string): void {
  const body: ApiErrorBody = { error: code };
  res.status(status).json(body);
}

/** A client mistake: the status and code to answer with, and the error type to log. */
interface ClientErrorResponse {
  status: number;
  code: string;
  type?: string;
}

/**
 * Body-parser error types are constants of dot-separated lowercase words, such as
 * `entity.parse.failed`. Another error's `type` is logged only if it has that shape too, so a
 * `type` that happens to hold data never reaches the log.
 */
const LOGGABLE_ERROR_TYPE = /^[a-z]+(?:\.[a-z]+)+$/u;

/**
 * The response for a client mistake, or undefined when `error` is not one. Body-parser errors
 * (from `http-errors`) carry `type` and `status`; other libraries may use `statusCode`.
 */
function clientErrorResponse(error: unknown): ClientErrorResponse | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { type, status, statusCode } = error as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const loggedType = typeof type === 'string' && LOGGABLE_ERROR_TYPE.test(type) ? type : undefined;

  if (type === 'entity.parse.failed') return { status: 400, code: 'invalid_json', type };
  if (type === 'entity.too.large') return { status: 413, code: 'too_large', type };

  const httpStatus = typeof status === 'number' ? status : statusCode;
  if (typeof httpStatus === 'number' && Number.isInteger(httpStatus)) {
    if (httpStatus >= 400 && httpStatus < 500) {
      return { status: httpStatus, code: 'bad_request', type: loggedType };
    }
  }
  return undefined;
}

/**
 * The pattern of the route that matched, e.g. `/api/o/:token`, never the URL itself. Undefined
 * when no route matched (an error in middleware that runs before the routes, like the body
 * parser), or for a route declared with a RegExp or a list of paths (the api declares strings).
 *
 * `req.baseUrl` is that of the router running the caller: inside a route handler it is the
 * router's mount path; in the app-level error handler it is the app's (empty), so a route of a
 * mounted router is logged by its own path only. Still a pattern either way.
 */
function routePattern(req: Request): string | undefined {
  // Express types `req.route` as `any`; it is a Route whose `path` is the pattern it was declared with.
  const route = req.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? `${req.baseUrl}${route.path}` : undefined;
}

/** The fields of `error` that may be logged (see {@link logError}). */
function describeError(error: unknown): LoggedError {
  if (!(error instanceof Error)) return { name: 'NonError' };
  if (isEngineError(error)) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: error.name, code: errorCode(error), stack: stackFrames(error.stack) };
}

/**
 * True for TypeError, ReferenceError and RangeError thrown by the JavaScript engine, whose
 * messages describe code ("Cannot read properties of undefined (reading 'phone')"), not data.
 *
 * Errors with a `code` are left out: Node's own TypeErrors and RangeErrors (`ERR_INVALID_ARG_TYPE`,
 * `ERR_OUT_OF_RANGE`, …) quote the value they received ("Received type string ('0521234567')").
 */
function isEngineError(error: Error): boolean {
  const engineType =
    error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError;
  return engineType && !('code' in error);
}

/** The error's `code` (a Node system code such as `ECONNREFUSED`, a Mongo number such as 11000). */
function errorCode(error: Error): string | number | undefined {
  const { code } = error as { code?: unknown };
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

/**
 * The stack without the message: only the `    at …` frame lines. Dropping just the first line
 * would not be enough, because a message may span several lines and the stack repeats all of them.
 */
function stackFrames(stack: string | undefined): string | undefined {
  const frames = stack?.split('\n').filter((line) => /^\s+at /u.test(line));
  return frames === undefined || frames.length === 0 ? undefined : frames.join('\n');
}
