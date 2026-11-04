// Tests for the English street names job (scripts/english-street-names.ts). No network and no real
// Overpass: every request goes to a fake fetch, and files are written only into temp directories.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streetsFileSchema, type Street, type StreetsFile } from '@bottlerun/shared';
import {
  BEIT_SHEMESH_AREA_ID,
  OVERPASS_QUERY,
  OVERPASS_URL,
  OVERPASS_USER_AGENT,
  SOURCE_SENTENCE,
  applyEnglishNames,
  englishNameMatcher,
  fetchOsmEnglishNames,
  main,
  parseOverpassResponse,
  type OsmName,
  type OverpassFetch,
} from './english-street-names.ts';
import { serializeStreetsFile } from './geocode-streets.ts';
import { transliterateStreetName } from './transliterateStreetName.ts';

function makeFile(streets: Street[], overrides: Partial<StreetsFile> = {}): StreetsFile {
  return {
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL',
    source: 'Street codes and names: data.gov.il.',
    updatedAt: '2026-01-01',
    streets,
    ...overrides,
  };
}

/** A street as sub-task 2 left it: its English name is the transliteration. */
function street(code: number, name: string): Street {
  return { code, name, nameEn: transliterateStreetName(name) };
}

/** An Overpass element with these tags, as `out tags;` returns it. */
function element(tags: Record<string, string>): { type: string; id: number; tags: object } {
  return { type: 'way', id: 1, tags };
}

/** A complete Overpass JSON answer. */
function overpassAnswer(elements: unknown[]): object {
  return { version: 0.6, generator: 'Overpass API', osm3s: {}, elements };
}

describe('OVERPASS_QUERY', () => {
  it('asks for JSON name:en tags inside the Beit Shemesh boundary area', () => {
    expect(BEIT_SHEMESH_AREA_ID).toBe(3601379449);
    expect(OVERPASS_QUERY).toMatch(/^\[out:json\]\[timeout:\d+\];/);
    expect(OVERPASS_QUERY).toContain('area(id:3601379449)');
    expect(OVERPASS_QUERY).toContain('["name:en"]');
    expect(OVERPASS_QUERY).toContain('way["highway"]');
    expect(OVERPASS_QUERY).toContain('nwr["place"]');
    expect(OVERPASS_QUERY).toContain('nwr["landuse"="residential"]');
    expect(OVERPASS_QUERY).toMatch(/out tags;$/);
  });
});

describe('parseOverpassResponse', () => {
  it('returns the trimmed name pairs of a valid answer', () => {
    const answer = overpassAnswer([
      element({ highway: 'residential', name: 'הרצל ', 'name:en': ' Herzl Street' }),
      element({ place: 'neighbourhood', name: 'גבעת שרת', 'name:en': 'Givat Sharet' }),
    ]);
    expect(parseOverpassResponse(answer)).toEqual([
      { name: 'הרצל', nameEn: 'Herzl Street' },
      { name: 'גבעת שרת', nameEn: 'Givat Sharet' },
    ]);
  });

  it('ignores elements without both tags', () => {
    const answer = overpassAnswer([
      { type: 'node', id: 2 },
      element({ name: 'הרצל' }),
      element({ 'name:en': 'Herzl' }),
      element({ name: '  ', 'name:en': 'Blank' }),
    ]);
    expect(parseOverpassResponse(answer)).toEqual([]);
  });

  it('ignores a name:en that is not Latin script', () => {
    const answer = overpassAnswer([
      element({ name: 'הרצל', 'name:en': 'הרצל' }),
      element({ name: 'הרצל', 'name:en': 'Herzl הרצל' }),
      element({ name: 'הרצל', 'name:en': 'Герцль' }),
      element({ name: 'הרצל', 'name:en': '12' }),
      element({ name: 'הנביאים', 'name:en': "HaNevi'im St." }),
    ]);
    expect(parseOverpassResponse(answer)).toEqual([{ name: 'הנביאים', nameEn: "HaNevi'im St." }]);
  });

  it('throws on an answer that is not Overpass JSON or reports an error', () => {
    expect(() => parseOverpassResponse({ error: 'busy' })).toThrow();
    expect(() => parseOverpassResponse('<html>busy</html>')).toThrow();
    expect(() =>
      parseOverpassResponse({ remark: 'runtime error: Query timed out', elements: [] }),
    ).toThrow(/runtime error/);
  });
});

describe('englishNameMatcher', () => {
  const match = (osmNames: OsmName[], name: string): string | undefined =>
    englishNameMatcher(osmNames)(name);

  it('matches the exact name', () => {
    expect(match([{ name: 'הרצל', nameEn: 'Herzl' }], 'הרצל')).toBe('Herzl');
    expect(match([{ name: 'הרצל', nameEn: 'Herzl' }], 'ז׳בוטינסקי')).toBeUndefined();
  });

  it('matches a spelled-out abbreviation and a name without gershayim', () => {
    const osm = [
      { name: 'סמטת האלון', nameEn: 'HaAlon Alley' },
      { name: 'רשבי', nameEn: 'Rashbi' },
      { name: 'שדרות נהר הדן', nameEn: 'Nahar HaDan Boulevard' },
    ];
    expect(match(osm, 'סמ האלון')).toBe('HaAlon Alley');
    expect(match(osm, 'רשב"י')).toBe('Rashbi');
    expect(match(osm, "שד' נהר הדן")).toBe('Nahar HaDan Boulevard');
    // And the other way round: OSM keeps the gershayim, the official name has none.
    expect(match([{ name: 'רשב"ג', nameEn: 'Rashbag' }], 'רשבג')).toBe('Rashbag');
  });

  it('matches a surname-first official name by its words', () => {
    const osm = [{ name: 'דרך יצחק רבין', nameEn: 'Yitzhak Rabin Road' }];
    expect(match(osm, 'דרך רבין יצחק')).toBe('Yitzhak Rabin Road');
  });

  it('prefers an exact match over a words match', () => {
    const osm = [
      { name: 'בן גוריון דוד', nameEn: 'Exact' },
      { name: 'דוד בן גוריון', nameEn: 'Reordered' },
    ];
    expect(match(osm, 'בן גוריון דוד')).toBe('Exact');
  });

  it('takes the most frequent name:en, ties alphabetically', () => {
    const majority = [
      { name: 'הרצל', nameEn: 'Herzl St' },
      { name: 'הרצל', nameEn: 'Herzl' },
      { name: 'הרצל', nameEn: 'Herzl' },
    ];
    expect(match(majority, 'הרצל')).toBe('Herzl');
    const tie = [
      { name: 'הרצל', nameEn: 'Herzl St' },
      { name: 'הרצל', nameEn: 'Herzl' },
    ];
    expect(match(tie, 'הרצל')).toBe('Herzl');
    expect(match([...tie].reverse(), 'הרצל')).toBe('Herzl');
  });

  it('never matches the locality "בית שמש" itself', () => {
    expect(match([{ name: 'בית שמש', nameEn: 'Beit Shemesh Street' }], 'בית שמש')).toBeUndefined();
  });
});

describe('applyEnglishNames', () => {
  const file = makeFile([
    street(101, 'הרצל'),
    street(181, 'סמ האלון'),
    { code: 200, name: 'הנביאים', nameEn: 'HaNevi’im (hand fix)' },
    street(9000, 'בית שמש'),
  ]);
  const osm: OsmName[] = [
    { name: 'סמטת האלון', nameEn: 'HaAlon Alley' },
    { name: 'בית שמש', nameEn: 'Beit Shemesh' },
  ];

  it('uses OSM where it matches and keeps every other name', () => {
    const result = applyEnglishNames(file, osm);
    expect(result.file.streets.map((s) => s.nameEn)).toEqual([
      'Herzl',
      'HaAlon Alley',
      'HaNevi’im (hand fix)',
      'Beit Shemesh',
    ]);
    expect(result.fromOsm).toBe(1);
    expect(result.fromTransliteration).toBe(3);
    expect(result.osmStreets).toEqual([{ code: 181, name: 'סמ האלון', nameEn: 'HaAlon Alley' }]);
  });

  it('without OSM keeps every current name, including earlier OSM names', () => {
    const fromOsmBefore = applyEnglishNames(file, osm).file;
    const result = applyEnglishNames(fromOsmBefore, undefined);
    expect(result.file.streets).toEqual(fromOsmBefore.streets);
    expect(result.fromOsm).toBe(0);
    expect(result.fromTransliteration).toBe(4);
  });

  it('appends the source sentence once', () => {
    const once = applyEnglishNames(file, osm).file;
    expect(once.source).toBe(`Street codes and names: data.gov.il. ${SOURCE_SENTENCE}`);
    expect(applyEnglishNames(once, osm).file.source).toBe(once.source);
  });

  it('never mutates its input', () => {
    const before = structuredClone(file);
    applyEnglishNames(file, osm);
    expect(file).toEqual(before);
  });
});

type FetchCall = { url: string; init: RequestInit };

/** A fake fetch that records every call and answers with `answer()` (or rejects with it). */
function fakeFetch(answer: () => Promise<Response>): { fetch: OverpassFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: OverpassFetch = (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetch, calls };
}

const jsonReply =
  (body: unknown, status = 200) =>
  (): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

const timeout = (): Promise<Response> =>
  Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

const networkError = (): Promise<Response> =>
  Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }));

describe('fetchOsmEnglishNames', () => {
  it('sends one POST with the query, the User-Agent and a timeout signal', async () => {
    const network = fakeFetch(
      jsonReply(overpassAnswer([element({ name: 'הרצל', 'name:en': 'Herzl' })])),
    );
    const names = await fetchOsmEnglishNames({ fetch: network.fetch, log: () => {} });

    expect(names).toEqual([{ name: 'הרצל', nameEn: 'Herzl' }]);
    expect(network.calls).toHaveLength(1);
    const [call] = network.calls;
    expect(call?.url).toBe(OVERPASS_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toMatchObject({
      'User-Agent': OVERPASS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(new URLSearchParams(call?.init.body as string).get('data')).toBe(OVERPASS_QUERY);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['HTTP 504', jsonReply({ error: 'gateway timeout' }, 504), /HTTP 504/],
    ['HTTP 429', jsonReply({}, 429), /HTTP 429/],
    ['a timeout', timeout, /no answer within 90 s/],
    ['a network error', networkError, /fetch failed: getaddrinfo ENOTFOUND/],
    [
      'an HTML page with 200',
      () => Promise.resolve(new Response('<html>busy</html>', { status: 200 })),
      /not JSON/,
    ],
    [
      'a runtime-error remark',
      jsonReply({ remark: 'runtime error', elements: [] }),
      /remark|runtime/,
    ],
  ])('skips OSM on %s, without throwing or retrying', async (_label, answer, reason) => {
    const network = fakeFetch(answer);
    const logs: string[] = [];
    const names = await fetchOsmEnglishNames({ fetch: network.fetch, log: (l) => logs.push(l) });

    expect(names).toBeUndefined();
    expect(network.calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/OSM skipped/);
    expect(logs.join('\n')).toMatch(reason);
  });
});

describe('main', () => {
  const fixedNow = (): Date => new Date('2026-11-04T09:00:00Z');
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bottlerun-english-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const original = makeFile([
    street(101, 'הרצל'),
    street(181, 'סמ האלון'),
    street(247, 'דרך רבין יצחק'),
    street(9000, 'בית שמש'),
  ]);

  async function tempStreetsFile(file: StreetsFile = original): Promise<string> {
    const target = path.join(tempDir, 'streets.json');
    await fs.writeFile(target, serializeStreetsFile(file), 'utf8');
    return target;
  }

  async function readStreets(target: string): Promise<StreetsFile> {
    return streetsFileSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
  }

  async function run(fetch: OverpassFetch, streetsFile: string, argv: string[] = []) {
    const logs: string[] = [];
    const exitCode = await main(
      argv,
      {},
      {
        fetch,
        streetsFile,
        log: (line) => logs.push(line),
        now: fixedNow,
      },
    );
    return { exitCode, logs };
  }

  const validAnswer = jsonReply(
    overpassAnswer([
      element({ highway: 'residential', name: 'סמטת האלון', 'name:en': 'HaAlon Alley' }),
      element({ highway: 'primary', name: 'דרך יצחק רבין', 'name:en': 'Yitzhak Rabin Road' }),
      element({ place: 'town', name: 'בית שמש', 'name:en': 'Beit Shemesh Town' }),
    ]),
  );

  it('writes OSM names, the source sentence and today, with one POST', async () => {
    const streetsFile = await tempStreetsFile();
    const network = fakeFetch(validAnswer);
    const { exitCode, logs } = await run(network.fetch, streetsFile);

    expect(exitCode).toBe(0);
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.init.method).toBe('POST');
    expect(network.calls[0]?.init.headers).toMatchObject({ 'User-Agent': OVERPASS_USER_AGENT });
    expect(network.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);

    const written = await readStreets(streetsFile);
    expect(written.updatedAt).toBe('2026-11-04');
    expect(written.source).toBe(`${original.source} ${SOURCE_SENTENCE}`);
    expect(written.streets.map((s) => s.nameEn)).toEqual([
      transliterateStreetName('הרצל'),
      'HaAlon Alley',
      'Yitzhak Rabin Road',
      transliterateStreetName('בית שמש'),
    ]);
    expect(logs).toContain('  osm: 181 סמ האלון -> HaAlon Alley');
    expect(logs.at(-1)).toMatch(/2 names from OSM, 2 from transliteration/);
  });

  it('does not repeat the source sentence on a second run', async () => {
    const streetsFile = await tempStreetsFile();
    await run(fakeFetch(validAnswer).fetch, streetsFile);
    await run(fakeFetch(validAnswer).fetch, streetsFile);

    const written = await readStreets(streetsFile);
    expect(written.source.split(SOURCE_SENTENCE)).toHaveLength(2);
  });

  it.each([
    ['HTTP 504', jsonReply({}, 504)],
    ['a timeout', timeout],
    ['a network error', networkError],
  ])('on %s skips OSM, keeps every name and exits 0', async (_label, answer) => {
    const streetsFile = await tempStreetsFile();
    const network = fakeFetch(answer);
    const { exitCode, logs } = await run(network.fetch, streetsFile);

    expect(exitCode).toBe(0);
    expect(network.calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/OSM skipped/);
    expect(logs.at(-1)).toMatch(/0 names from OSM, 4 from transliteration.*OSM was skipped/);
    const written = await readStreets(streetsFile);
    expect(written.streets).toEqual(original.streets);
    written.streets.forEach((s) => expect(s.nameEn).toBe(transliterateStreetName(s.name)));
  });

  it('keeps names from an earlier OSM run when Overpass is down', async () => {
    const streetsFile = await tempStreetsFile();
    await run(fakeFetch(validAnswer).fetch, streetsFile);
    await run(fakeFetch(timeout).fetch, streetsFile);

    const written = await readStreets(streetsFile);
    expect(written.streets.find((s) => s.code === 181)?.nameEn).toBe('HaAlon Alley');
  });

  it('prints the usage for --help and refuses unknown arguments, with no request', async () => {
    const streetsFile = await tempStreetsFile();
    const network = fakeFetch(validAnswer);

    expect((await run(network.fetch, streetsFile, ['--help'])).exitCode).toBe(0);
    expect((await run(network.fetch, streetsFile, ['--refresh'])).exitCode).toBe(2);
    expect(network.calls).toHaveLength(0);
  });

  it('exits 1 when the streets file cannot be read, with no request', async () => {
    const network = fakeFetch(validAnswer);
    const { exitCode, logs } = await run(network.fetch, path.join(tempDir, 'missing.json'));

    expect(exitCode).toBe(1);
    expect(network.calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/cannot read/);
  });
});
