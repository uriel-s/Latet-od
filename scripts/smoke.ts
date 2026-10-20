// Post-deploy smoke check: a few GETs against a deployed site that show the deploy is wired up the
// way vercel.json and ADR-0002 say. docs/deploy.md tells you when to run it:
//
//   npm run smoke -- https://latet-od.vercel.app        (or: npx tsx scripts/smoke.ts <url>)
//
// Run it after every production deploy, and on a preview deploy's URL before you trust that
// deploy. The checks run one after another:
//   health         GET /api/health answers 200 {"ok":true}: the function runs, its env is valid and
//                  it reaches the database. The time it took is printed, so a run after the site
//                  has been idle shows how long a cold start takes.
//   api-404        GET /api/smoke-check-no-such-route answers the api's JSON 404, not index.html.
//                  This shows the /api rewrite comes before the SPA fallback in vercel.json.
//   open-graph     GET / has og:title, og:description and an absolute https og:image, which the
//                  WhatsApp link preview needs. The deploy under test serves that image's path as
//                  image/* of at most 300 KB, WhatsApp's size limit (ADR-0002).
//   spa-deep-link  GET /o/smoke-check is index.html, so a WhatsApp link to a customer page loads
//                  the SPA. It also has the X-Robots-Tag: noindex header from vercel.json.
// Exit code: 0 when every check passes, 1 when any check fails, 2 for a bad argument.
//
// It is safe to run against production at any time. It sends only GETs, sends no customer data and
// changes nothing. /o/smoke-check uses a made-up token: no order has it, because real tokens are
// long and random. Vercel's request logs will show that path and the 404 path, which does no harm.
// Each request waits up to 30 s, which is long enough for a cold start. A preview URL behind
// Vercel's deployment protection (Vercel Authentication) answers 401 to every check.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ApiErrorBody, HealthResponse } from '@bottlerun/shared';

/** How long one request may take: long enough for a cold start of the function plus Atlas. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** WhatsApp shows no preview image above this size (ADR-0002). */
export const OG_IMAGE_MAX_BYTES = 300 * 1024;

const HEALTH_PATH = '/api/health';
/** An /api path that no route serves: the api answers its JSON 404, the SPA fallback 200. */
const API_404_PATH = '/api/smoke-check-no-such-route';
/** A made-up customer-page path: no order has this token. */
const DEEP_LINK_PATH = '/o/smoke-check';

/** What a healthy GET /api/health answers (apps/api/src/app.ts). */
const HEALTHY_BODY: HealthResponse = { ok: true };
/** What the api answers for an /api path that no route serves (apps/api/src/app.ts). */
const NOT_FOUND_BODY: ApiErrorBody = { error: 'not_found' };

/** Identifies these requests in Vercel's request logs. */
const USER_AGENT = 'BottleRun-smoke-check/1.0';

/** The outcome of one check, printed as one output line. */
export type SmokeResult = { name: string; ok: boolean; detail: string };

/** The part of fetch the checks use. globalThis.fetch fits, and tests pass a fake. */
export type SmokeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Turns the command-line argument into the site's origin (`https://host[:port]`, without the
 * trailing slash). Accepts only an absolute http(s) URL of the site itself, with or without a
 * trailing `/`. Throws an Error that says what is wrong for a missing or relative URL, another
 * scheme, a path, query or hash, or a user name/password.
 */
export function parseBaseUrl(arg: string | undefined): string {
  const text = arg?.trim() ?? '';
  if (text === '') throw new Error('missing the site URL');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`not an absolute URL: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`not an http or https URL: ${text}`);
  }
  // The URL is not repeated in this message because it holds the password.
  if (url.username !== '' || url.password !== '') {
    throw new Error('the URL must not contain a user name or password');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`give the site's address only, with no path, query or #: ${text}`);
  }
  return url.origin;
}

/** A `<meta …>` tag. A quoted attribute value may contain `>`. */
const META_TAG = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
/** One attribute: name="value", name='value', name=value or a bare name. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** The attributes of one start tag, by lower-cased name. The first of a repeated name wins. */
function readAttributes(attributeText: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of attributeText.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
  lt: '<',
  gt: '>',
};

/** Decodes the few entities that can occur in a meta value, such as `&amp;` in an image URL. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|quot|apos|#39|lt|gt);/g,
    (entity, name: string) => ENTITIES[name] ?? entity,
  );
}

/**
 * The Open Graph tags of a page: `og:*` property → content (trimmed, entities decoded), read from
 * `<meta property="og:…" content="…">` in any attribute order and with either quote style. No
 * DOM library is used: a regex over the tags is enough for the one static index.html.
 * Commented-out tags are skipped. When a property repeats, the first one is kept, because Open
 * Graph readers use the first og:image.
 */
export function readOgTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [, attributeText = ''] of html.replace(HTML_COMMENT, '').matchAll(META_TAG)) {
    const attributes = readAttributes(attributeText);
    const property = attributes.get('property')?.trim().toLowerCase();
    const content = attributes.get('content');
    if (property?.startsWith('og:') && content !== undefined && !tags.has(property)) {
      tags.set(property, decodeEntities(content).trim());
    }
  }
  return tags;
}

/** GETs a path (starting with `/`) on the site under test. */
type Get = (path: string) => Promise<Response>;

/**
 * One check. It resolves with the detail for a pass, or throws an Error whose message is the
 * failure detail.
 */
type Check = (get: Get, now: () => number) => Promise<string>;

/** The body parsed as JSON, or undefined when it is not JSON (for example index.html). */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The media type without parameters: "text/html; charset=utf-8" → "text/html". */
function mediaType(response: Response): string {
  const header = response.headers.get('content-type') ?? '';
  return (header.split(';')[0] ?? '').trim().toLowerCase();
}

/** Throws unless the response is a 200 text/html page. */
function expectHtmlPage(response: Response, pagePath: string): void {
  if (response.status !== 200) throw new Error(`${pagePath} answered HTTP ${response.status}`);
  const type = mediaType(response);
  if (type !== 'text/html') {
    throw new Error(`${pagePath} answered ${type || 'no content-type'}, not text/html`);
  }
}

/** The health body for the output. Only `{"ok":…}` is printed in full; anything else is described. */
function describeHealthBody(body: unknown): string {
  if (body === undefined) return 'body is not JSON';
  const isHealthShape =
    isDeepStrictEqual(body, { ok: true }) || isDeepStrictEqual(body, { ok: false });
  return isHealthShape ? JSON.stringify(body) : 'unexpected JSON body';
}

/** What a failing health status most likely means (apps/api: app.ts, envDeps.ts). */
function healthHint(status: number): string {
  if (status === 503) return ': the function runs but did not reach the database';
  if (status === 500) return ': invalid env vars? see the function logs (invalid_env)';
  return '';
}

const checkHealth: Check = async (get, now) => {
  const startedAt = now();
  const response = await get(HEALTH_PATH);
  const body = await readJson(response);
  const tookMs = Math.round(now() - startedAt);
  const answer = `HTTP ${response.status} ${describeHealthBody(body)} in ${tookMs} ms`;
  if (response.status !== 200 || !isDeepStrictEqual(body, HEALTHY_BODY)) {
    throw new Error(`${HEALTH_PATH} answered ${answer}${healthHint(response.status)}`);
  }
  return answer;
};

const checkApiNotFound: Check = async (get) => {
  const response = await get(API_404_PATH);
  const body = await readJson(response);
  if (response.status === 404 && isDeepStrictEqual(body, NOT_FOUND_BODY)) {
    return 'HTTP 404 {"error":"not_found"} from the function';
  }
  // A 200 that is not JSON is index.html: the SPA fallback caught an /api path.
  const got = body === undefined ? 'a body that is not JSON' : 'another JSON body';
  const hint =
    body === undefined ? ' (index.html? /api/(.*) must be the first rewrite in vercel.json)' : '';
  throw new Error(
    `expected HTTP 404 {"error":"not_found"}, got HTTP ${response.status} with ${got}${hint}`,
  );
};

/** og:image as a URL. Throws unless it is an absolute https URL, which WhatsApp needs. */
function absoluteHttpsUrl(value: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:')
    throw new Error(`og:image is not an absolute https URL: ${value}`);
  return url;
}

const REQUIRED_OG_TAGS = ['og:title', 'og:description', 'og:image'] as const;

const checkOpenGraph: Check = async (get) => {
  const page = await get('/');
  const html = await page.text();
  expectHtmlPage(page, '/');
  const tags = readOgTags(html);
  const missing = REQUIRED_OG_TAGS.filter((property) => !tags.get(property));
  if (missing.length > 0) throw new Error(`/ has no ${missing.join(', ')}`);
  const imageUrl = absoluteHttpsUrl(tags.get('og:image') ?? '');

  // og:image names the production host, but the image is fetched by its path from the site under
  // test, so a preview deploy checks its own copy of the file.
  const imagePath = imageUrl.pathname + imageUrl.search;
  const image = await get(imagePath);
  const bytes = (await image.arrayBuffer()).byteLength;
  if (image.status !== 200) throw new Error(`${imagePath} answered HTTP ${image.status}`);
  const type = mediaType(image);
  if (!type.startsWith('image/')) {
    throw new Error(`${imagePath} answered ${type || 'no content-type'}, not an image`);
  }
  if (bytes > OG_IMAGE_MAX_BYTES) {
    throw new Error(
      `${imagePath} is ${bytes} bytes, over the ${OG_IMAGE_MAX_BYTES}-byte (300 KB) limit ` +
        'WhatsApp sets for a preview image',
    );
  }
  const kb = Math.round(bytes / 1024);
  return `og:title, og:description, og:image ${imageUrl.href}; ${imagePath} ${type} ${kb} KB`;
};

/** The element the SPA mounts on (apps/web/index.html): it identifies index.html. */
const SPA_ROOT = /<div\s(?:[^>]*\s)?id\s*=\s*["']?root\b/i;

const checkSpaDeepLink: Check = async (get) => {
  const response = await get(DEEP_LINK_PATH);
  const html = await response.text();
  expectHtmlPage(response, DEEP_LINK_PATH);
  if (!SPA_ROOT.test(html)) {
    throw new Error(`${DEEP_LINK_PATH} is not the SPA's index.html: no <div id="root">`);
  }
  const robots = response.headers.get('x-robots-tag') ?? '';
  if (!/\bnoindex\b/i.test(robots)) {
    throw new Error(
      `${DEEP_LINK_PATH} has no X-Robots-Tag: noindex (the /o/(.*) header in vercel.json)`,
    );
  }
  return `HTTP 200 index.html, X-Robots-Tag: ${robots}`;
};

/** Every check, in the order they run and print. */
const CHECKS: readonly { name: string; run: Check }[] = [
  { name: 'health', run: checkHealth },
  { name: 'api-404', run: checkApiNotFound },
  { name: 'open-graph', run: checkOpenGraph },
  { name: 'spa-deep-link', run: checkSpaDeepLink },
];

/** The failure detail for anything a check throws, including a rejected fetch. */
function errorMessage(error: unknown): string {
  // AbortSignal.timeout rejects the fetch with a DOMException named TimeoutError.
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'TimeoutError'
  ) {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  if (!(error instanceof Error)) return String(error);
  // Node's fetch rejects with "fetch failed" and puts the reason (DNS, TLS, refused) in `cause`.
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/**
 * Runs every check against `baseUrl` (an origin from parseBaseUrl) and resolves with one result
 * per check, in order. Never rejects: a check that throws, or whose fetch rejects or times out,
 * becomes a failed result with the error's message. The requests run one after another, so the
 * first one meets any cold start. Each request is a GET with a REQUEST_TIMEOUT_MS timeout.
 * `now` (ms) times the health check.
 */
export async function runSmokeChecks(
  baseUrl: string,
  fetchFn: SmokeFetch,
  now: () => number = () => performance.now(),
): Promise<SmokeResult[]> {
  // The path is appended to the origin, never resolved against it, so a path such as //other.host
  // cannot leave the site under test.
  const get: Get = (pagePath) =>
    fetchFn(`${baseUrl}${pagePath}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const results: SmokeResult[] = [];
  for (const { name, run } of CHECKS) {
    try {
      results.push({ name, ok: true, detail: await run(get, now) });
    } catch (error) {
      results.push({ name, ok: false, detail: errorMessage(error) });
    }
  }
  return results;
}

/**
 * The output: `OK   <name>  <detail>` or `FAIL <name>  <detail>` per check, with the names
 * padded to one width, then a summary line.
 */
export function formatResults(results: readonly SmokeResult[]): string[] {
  const nameWidth = Math.max(0, ...results.map((result) => result.name.length));
  const lines = results.map(
    (result) =>
      `${(result.ok ? 'OK' : 'FAIL').padEnd(4)} ${result.name.padEnd(nameWidth)}  ${result.detail}`,
  );
  const failed = results.filter((result) => !result.ok).map((result) => result.name);
  const summary =
    failed.length === 0
      ? `all ${results.length} checks passed`
      : `${failed.length} of ${results.length} checks failed: ${failed.join(', ')}`;
  return [...lines, summary];
}

/** What main needs from the outside world; tests override any of it. */
export type SmokeDeps = {
  fetch: SmokeFetch;
  log: (line: string) => void;
  /** Milliseconds from a monotonic clock, used to time the health check. */
  now: () => number;
};

const defaultDeps: SmokeDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  log: (line) => console.log(line),
  now: () => performance.now(),
};

const USAGE = [
  'usage: npm run smoke -- <site URL>',
  '   or: npx tsx scripts/smoke.ts <site URL>',
  'example: npm run smoke -- https://latet-od.vercel.app',
  "The URL is the site's address only (http or https, no path). The checks send only GETs.",
].join('\n');

/**
 * The command line. `args` excludes node and the script, and must be one site URL (or --help).
 * Resolves with the exit code: 0 when every check passed, 1 when any failed, 2 for bad arguments.
 */
export async function main(
  args: readonly string[],
  deps: Partial<SmokeDeps> = {},
): Promise<number> {
  const { fetch, log, now } = { ...defaultDeps, ...deps };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    log(USAGE);
    return 0;
  }
  let baseUrl: string;
  try {
    if (args.length > 1) throw new Error(`expected one URL, got ${args.length} arguments`);
    baseUrl = parseBaseUrl(args[0]);
  } catch (error) {
    log(errorMessage(error));
    log(USAGE);
    return 2;
  }

  log(`smoke check of ${baseUrl}`);
  const results = await runSmokeChecks(baseUrl, fetch, now);
  formatResults(results).forEach((line) => log(line));
  return results.every((result) => result.ok) ? 0 : 1;
}

// Run only when executed directly (`npm run smoke`, `npx tsx scripts/smoke.ts`), never when a test
// imports this file. The paths are compared case-insensitively because the drive letter's case can
// differ on Windows.
const thisFile = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
const invokedFile = path.resolve(process.argv[1] ?? '').toLowerCase();
if (thisFile === invokedFile) {
  process.exitCode = await main(process.argv.slice(2));
}
