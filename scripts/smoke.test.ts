// Tests for the post-deploy smoke check (scripts/smoke.ts). There is no network: every request goes
// to a fake fetch that answers the way the deployed site does, with Vercel's routing from
// vercel.json in front of the api and the SPA. The fake site serves the REAL apps/web/index.html
// and apps/web/public/og-image.jpg, so these tests also show that the committed page passes the
// Open Graph check.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OG_IMAGE_MAX_BYTES,
  formatResults,
  main,
  parseBaseUrl,
  readOgTags,
  runSmokeChecks,
  type SmokeFetch,
  type SmokeResult,
} from './smoke.ts';

const INDEX_HTML = fs.readFileSync(
  fileURLToPath(new URL('../apps/web/index.html', import.meta.url)),
  'utf8',
);
const OG_IMAGE = fs.readFileSync(
  fileURLToPath(new URL('../apps/web/public/og-image.jpg', import.meta.url)),
);
/** og:image in the committed index.html: the production host, which the check must not request. */
const PRODUCTION_OG_IMAGE = 'https://latet-od.vercel.app/og-image.jpg';

const SITE = 'https://site.example';

const CHECK_NAMES = ['health', 'api-404', 'open-graph', 'spa-deep-link'];

/** index.html as Vercel serves it for any SPA path, with vercel.json's noindex header on /o/*. */
function indexHtml(path: string, html: string = INDEX_HTML): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  if (path.startsWith('/o/')) headers.set('x-robots-tag', 'noindex');
  return new Response(html, { headers });
}

function jpeg(bytes: Uint8Array = OG_IMAGE): Response {
  return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
}

/**
 * A healthy deploy, routed as vercel.json routes it. A file in the build output (the OG image) is
 * served first. Then /api/* goes to the function: health, or the JSON 404 for any other path. Every
 * other path gets index.html.
 */
function goodSite(path: string): Response {
  if (path === '/og-image.jpg') return jpeg();
  if (path === '/api/health') {
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  }
  if (path.startsWith('/api/')) return Response.json({ error: 'not_found' }, { status: 404 });
  return indexHtml(path);
}

/** The good site, except that `path` answers `response()`. */
function siteWith(overridePath: string, response: () => Response): (path: string) => Response {
  return (path) => (path === overridePath ? response() : goodSite(path));
}

/** A fake fetch that answers `respond(path)` and records every request. */
function fakeFetch(respond: (path: string) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: SmokeFetch = (url, init) => {
    requests.push({ url, init });
    return Promise.resolve(respond(new URL(url).pathname));
  };
  return { fetch, requests, urls: (): string[] => requests.map((request) => request.url) };
}

/** A clock that moves 125 ms on every read, so the health check takes 125 ms. */
function fakeClock(): () => number {
  let ms = 0;
  return () => (ms += 125);
}

async function check(respond: (path: string) => Response) {
  const fake = fakeFetch(respond);
  const results = await runSmokeChecks(SITE, fake.fetch, fakeClock());
  return { results, urls: fake.urls(), requests: fake.requests };
}

function result(results: readonly SmokeResult[], name: string): SmokeResult {
  const found = results.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no result named ${name}`);
  return found;
}

/** The names of the checks that failed. */
function failedNames(results: readonly SmokeResult[]): string[] {
  return results.filter((candidate) => !candidate.ok).map((candidate) => candidate.name);
}

/** index.html with `search` replaced; fails the test if `search` is not in the file. */
function editedIndexHtml(search: string | RegExp, replacement: string): string {
  const edited = INDEX_HTML.replace(search, replacement);
  expect(edited).not.toBe(INDEX_HTML);
  return edited;
}

describe('runSmokeChecks', () => {
  it('passes all four checks against a site serving the committed index.html and og-image.jpg', async () => {
    const { results } = await check(goodSite);

    expect(results.map(({ name, ok }) => ({ name, ok }))).toEqual(
      CHECK_NAMES.map((name) => ({ name, ok: true })),
    );
    expect(result(results, 'health').detail).toBe('HTTP 200 {"ok":true} in 125 ms');
    expect(result(results, 'open-graph').detail).toContain('/og-image.jpg image/jpeg 67 KB');
    expect(result(results, 'spa-deep-link').detail).toContain('X-Robots-Tag: noindex');
  });

  it("fetches the og:image path from the site under test, not from og:image's production host", async () => {
    const { results, urls } = await check(goodSite);

    expect(readOgTags(INDEX_HTML).get('og:image')).toBe(PRODUCTION_OG_IMAGE);
    expect(result(results, 'open-graph').detail).toContain(PRODUCTION_OG_IMAGE);
    expect(urls).toContain(`${SITE}/og-image.jpg`);
    expect(urls.filter((url) => !url.startsWith(`${SITE}/`))).toEqual([]);
  });

  it('sends only GETs, one after another, each with a timeout and no body', async () => {
    const { urls, requests } = await check(goodSite);

    expect(urls).toEqual([
      `${SITE}/api/health`,
      `${SITE}/api/smoke-check-no-such-route`,
      `${SITE}/`,
      `${SITE}/og-image.jpg`,
      `${SITE}/o/smoke-check`,
    ]);
    for (const { init } of requests) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  describe('health', () => {
    it('fails on 503 {"ok":false}, the answer when the database is down', async () => {
      const { results } = await check(
        siteWith('/api/health', () => Response.json({ ok: false }, { status: 503 })),
      );

      expect(failedNames(results)).toEqual(['health']);
      expect(result(results, 'health').detail).toBe(
        '/api/health answered HTTP 503 {"ok":false} in 125 ms: the function runs but did not ' +
          'reach the database',
      );
    });

    it('does not print an unexpected body, which could hold private data', async () => {
      const { results } = await check(
        siteWith('/api/health', () => Response.json({ ok: true, phone: '0501234567' })),
      );

      expect(result(results, 'health')).toEqual({
        name: 'health',
        ok: false,
        detail: '/api/health answered HTTP 200 unexpected JSON body in 125 ms',
      });
    });
  });

  describe('api-404', () => {
    it('fails, as does health, when /api paths get index.html (the rewrites in the wrong order)', async () => {
      const spaCatchesApi = (path: string): Response =>
        path.startsWith('/api/') ? indexHtml(path) : goodSite(path);
      const { results } = await check(spaCatchesApi);

      expect(failedNames(results)).toEqual(['health', 'api-404']);
      expect(result(results, 'health').detail).toContain('HTTP 200 body is not JSON');
      expect(result(results, 'api-404').detail).toContain(
        'got HTTP 200 with a body that is not JSON (index.html?',
      );
    });

    it('fails on a 404 that is not the api JSON error', async () => {
      const { results } = await check(
        siteWith(
          '/api/smoke-check-no-such-route',
          () => new Response('Not Found', { status: 404 }),
        ),
      );

      expect(failedNames(results)).toEqual(['api-404']);
    });
  });

  describe('open-graph', () => {
    it('fails when the page has no og:image', async () => {
      const html = editedIndexHtml(/<meta property="og:image" content="[^"]*" \/>/, '');
      const { results } = await check(siteWith('/', () => indexHtml('/', html)));

      expect(failedNames(results)).toEqual(['open-graph']);
      expect(result(results, 'open-graph').detail).toBe('/ has no og:image');
    });

    it.each(['/og-image.jpg', 'http://site.example/og-image.jpg'])(
      'fails when og:image is %s, not an absolute https URL',
      async (ogImage) => {
        const html = editedIndexHtml(PRODUCTION_OG_IMAGE, ogImage);
        const { results } = await check(siteWith('/', () => indexHtml('/', html)));

        expect(failedNames(results)).toEqual(['open-graph']);
        expect(result(results, 'open-graph').detail).toBe(
          `og:image is not an absolute https URL: ${ogImage}`,
        );
      },
    );

    it('fails when the page is not 200 text/html', async () => {
      const { results } = await check(siteWith('/', () => new Response('', { status: 500 })));

      expect(result(results, 'open-graph').detail).toBe('/ answered HTTP 500');
    });

    it('fails when the image is over 300 KB', async () => {
      const tooBig = new Uint8Array(OG_IMAGE_MAX_BYTES + 1);
      const { results } = await check(siteWith('/og-image.jpg', () => jpeg(tooBig)));

      expect(failedNames(results)).toEqual(['open-graph']);
      expect(result(results, 'open-graph').detail).toContain(
        `/og-image.jpg is ${OG_IMAGE_MAX_BYTES + 1} bytes, over the ${OG_IMAGE_MAX_BYTES}-byte`,
      );
    });

    it('passes an image of exactly 300 KB', async () => {
      const atLimit = new Uint8Array(OG_IMAGE_MAX_BYTES);
      const { results } = await check(siteWith('/og-image.jpg', () => jpeg(atLimit)));

      expect(result(results, 'open-graph').ok).toBe(true);
    });

    it('fails when the image path gets index.html (the file is missing from the build)', async () => {
      const { results } = await check(siteWith('/og-image.jpg', () => indexHtml('/og-image.jpg')));

      expect(failedNames(results)).toEqual(['open-graph']);
      expect(result(results, 'open-graph').detail).toBe(
        '/og-image.jpg answered text/html, not an image',
      );
    });

    it('fails when the image answers 404', async () => {
      const { results } = await check(
        siteWith('/og-image.jpg', () => new Response('', { status: 404 })),
      );

      expect(result(results, 'open-graph').detail).toBe('/og-image.jpg answered HTTP 404');
    });
  });

  describe('spa-deep-link', () => {
    it('fails when the deep path answers 404 (no SPA fallback rewrite)', async () => {
      const { results } = await check(
        siteWith('/o/smoke-check', () => new Response('Not Found', { status: 404 })),
      );

      expect(failedNames(results)).toEqual(['spa-deep-link']);
      expect(result(results, 'spa-deep-link').detail).toBe('/o/smoke-check answered HTTP 404');
    });

    it('fails when the deep path has no X-Robots-Tag: noindex', async () => {
      const { results } = await check(siteWith('/o/smoke-check', () => indexHtml('/')));

      expect(failedNames(results)).toEqual(['spa-deep-link']);
      expect(result(results, 'spa-deep-link').detail).toContain('has no X-Robots-Tag: noindex');
    });

    it('fails when the deep path is an HTML page other than index.html', async () => {
      const otherPage = '<!doctype html><html><body><h1>Not here</h1></body></html>';
      const { results } = await check(
        siteWith('/o/smoke-check', () => indexHtml('/o/smoke-check', otherPage)),
      );

      expect(result(results, 'spa-deep-link').detail).toContain('no <div id="root">');
    });
  });

  describe('when fetch rejects', () => {
    it('fails every check with the network error and its cause, without throwing', async () => {
      const fetch: SmokeFetch = () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND site.example') }),
        );

      const results = await runSmokeChecks(SITE, fetch, fakeClock());

      expect(results).toEqual(
        CHECK_NAMES.map((name) => ({
          name,
          ok: false,
          detail: 'fetch failed: getaddrinfo ENOTFOUND site.example',
        })),
      );
    });

    it('fails a check whose request timed out, and runs the next checks', async () => {
      const fake = fakeFetch(goodSite);
      const fetch: SmokeFetch = (url, init) =>
        new URL(url).pathname === '/api/health'
          ? Promise.reject(
              new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
            )
          : fake.fetch(url, init);

      const results = await runSmokeChecks(SITE, fetch, fakeClock());

      expect(result(results, 'health')).toEqual({
        name: 'health',
        ok: false,
        detail: 'no answer within 30 s',
      });
      expect(failedNames(results)).toEqual(['health']);
    });
  });
});

describe('readOgTags', () => {
  it('reads the og tags of the committed index.html', () => {
    const tags = readOgTags(INDEX_HTML);

    expect(tags.get('og:title')).toBe('לתת עוד: איסוף בקבוקים בבית שמש');
    expect(tags.get('og:description')).toMatch(/^הבקבוקים שלכם, התפילין שלהם!/);
    expect(tags.get('og:image')).toBe(PRODUCTION_OG_IMAGE);
  });

  it('reads content before property, single quotes, extra attributes and a self-closing tag', () => {
    const html = [
      `<meta content="Title" property="og:title">`,
      `<meta property='og:description' content='Say "hi"' data-x=1 />`,
      `<META data-note="a > b" Property="og:image" CONTENT="https://img.example/a.jpg?w=1&amp;h=2">`,
    ].join('\n');

    expect(Object.fromEntries(readOgTags(html))).toEqual({
      'og:title': 'Title',
      'og:description': 'Say "hi"',
      'og:image': 'https://img.example/a.jpg?w=1&h=2',
    });
  });

  it('reads a tag whose attributes span several lines', () => {
    const html = '<meta\n  property="og:title"\n  content="  Spread out  "\n/>';

    expect(readOgTags(html).get('og:title')).toBe('Spread out');
  });

  it('keeps the first of a repeated tag, and skips commented-out and non-og tags', () => {
    const html = [
      '<!-- <meta property="og:title" content="Commented out" /> -->',
      '<meta name="og:description" content="name, not property" />',
      '<meta name="description" content="Plain description" />',
      '<meta property="og:title" content="First" />',
      '<meta property="og:title" content="Second" />',
    ].join('\n');

    expect(Object.fromEntries(readOgTags(html))).toEqual({ 'og:title': 'First' });
  });
});

describe('parseBaseUrl', () => {
  it.each([
    ['https://x.example', 'https://x.example'],
    ['https://x.example/', 'https://x.example'],
    ['  https://X.Example/  ', 'https://x.example'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('accepts %j as %s', (arg, origin) => {
    expect(parseBaseUrl(arg)).toBe(origin);
  });

  it.each([
    [undefined, 'missing the site URL'],
    ['', 'missing the site URL'],
    ['x.example', 'not an absolute URL'],
    ['/api/health', 'not an absolute URL'],
    ['ftp://x.example', 'not an http or https URL'],
    ['https://x.example/o/abc', 'no path, query or #'],
    ['https://x.example/?preview=1', 'no path, query or #'],
    ['https://x.example/#top', 'no path, query or #'],
  ])('refuses %j', (arg, message) => {
    expect(() => parseBaseUrl(arg)).toThrow(message);
  });

  it('refuses a user name and password without repeating them', () => {
    expect(() => parseBaseUrl('https://user:secret@x.example')).toThrow(
      new Error('the URL must not contain a user name or password'),
    );
  });
});

describe('formatResults', () => {
  it('prints OK or FAIL, the padded name and the detail per check, then a summary', () => {
    expect(
      formatResults([
        { name: 'health', ok: true, detail: 'fine' },
        { name: 'spa-deep-link', ok: false, detail: 'broken' },
      ]),
    ).toEqual([
      'OK   health         fine',
      'FAIL spa-deep-link  broken',
      '1 of 2 checks failed: spa-deep-link',
    ]);
  });
});

describe('main', () => {
  async function runMain(args: string[], respond: (path: string) => Response = goodSite) {
    const fake = fakeFetch(respond);
    const logs: string[] = [];
    const exitCode = await main(args, {
      fetch: fake.fetch,
      log: (line) => logs.push(line),
      now: fakeClock(),
    });
    return { exitCode, logs, urls: fake.urls() };
  }

  it('prints a line per check and a summary, and exits 0 when every check passes', async () => {
    const { exitCode, logs } = await runMain([`${SITE}/`]);

    expect(exitCode).toBe(0);
    expect(logs[0]).toBe(`smoke check of ${SITE}`);
    expect(logs.slice(1, 5).map((line) => line.slice(0, 19))).toEqual([
      'OK   health        ',
      'OK   api-404       ',
      'OK   open-graph    ',
      'OK   spa-deep-link ',
    ]);
    expect(logs.at(-1)).toBe('all 4 checks passed');
  });

  it('exits 1 and names the failed check when one fails', async () => {
    const { exitCode, logs } = await runMain(
      [SITE],
      siteWith('/api/health', () => Response.json({ ok: false }, { status: 503 })),
    );

    expect(exitCode).toBe(1);
    expect(logs[1]).toMatch(/^FAIL health {9}\/api\/health answered HTTP 503/);
    expect(logs.at(-1)).toBe('1 of 4 checks failed: health');
  });

  it.each([[[]], [['site.example']], [[SITE, 'extra']]])(
    'prints the usage and exits 2 without a request for arguments %j',
    async (args) => {
      const { exitCode, logs, urls } = await runMain(args);

      expect(exitCode).toBe(2);
      expect(logs.join('\n')).toContain('usage: npm run smoke -- <site URL>');
      expect(urls).toEqual([]);
    },
  );

  it('prints the usage and exits 0 for --help', async () => {
    const { exitCode, logs, urls } = await runMain(['--help']);

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('usage: npm run smoke -- <site URL>');
    expect(urls).toEqual([]);
  });
});
