// Tests for the street geocoding script. No network and no real Nominatim: every request goes to
// a fake fetch, sleeps resolve at once, and files are written only into temp directories.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streetsFileSchema, type Street, type StreetsFile } from '@bottlerun/shared';
import {
  BEIT_SHEMESH_BBOX,
  MIN_REQUEST_INTERVAL_MS,
  REGION_DIVIDER,
  STREETS_FILE,
  geocodeStreets,
  main,
  mergeStreetList,
  nominatimSearchUrls,
  parseNominatimResponse,
  parseStreetList,
  recomputeRegions,
  regionForPoint,
  serializeStreetsFile,
  todayInJerusalem,
  userAgentFor,
  writeStreetsFile,
  type GeocodeDeps,
} from './geocode-streets.ts';

const TEST_EMAIL = 'test@example.com';
// Points Nominatim returns for Beit Shemesh: the city centre (old city) and one in Ramat Beit
// Shemesh; Modi'in is a real out-of-city result for a street name that exists in both cities.
const CITY_CENTRE = { lat: 31.7462, lng: 34.9887 };
const RAMAT_POINT = { lat: 31.71, lng: 34.985 };
const MODIIN_POINT = { lat: 31.8977, lng: 35.0104 };

function makeFile(streets: Street[], overrides: Partial<StreetsFile> = {}): StreetsFile {
  return {
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL',
    source: 'test',
    updatedAt: '2026-01-01',
    streets,
    ...overrides,
  };
}

/** One jsonv2 search result, with the string coordinates Nominatim sends. */
function hit(point: { lat: number; lng: number }): { lat: string; lon: string; name: string } {
  return { lat: String(point.lat), lon: String(point.lng), name: 'result' };
}

type Reply = { status?: number; body: unknown };

/**
 * Fake fetch that answers each request with `respond(url)` and records every call, plus a fake
 * sleep; both push to one `events` list so tests can check the order of sleeps and requests.
 */
function fakeDeps(respond: (url: URL) => Reply) {
  const events: string[] = [];
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  const saved: StreetsFile[] = [];
  const logs: string[] = [];
  const deps: GeocodeDeps = {
    fetch: (url, init) => {
      events.push('fetch');
      requests.push({ url, headers: init.headers });
      const { status = 200, body } = respond(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    },
    sleep: (ms) => {
      events.push(`sleep ${ms}`);
      return Promise.resolve();
    },
    save: (file) => {
      saved.push(file);
      return Promise.resolve();
    },
    userAgent: userAgentFor(TEST_EMAIL),
    log: (line) => logs.push(line),
  };
  return { deps, events, requests, saved, logs };
}

/** Which street a recorded Nominatim request was for, and whether it was the structured one. */
function describeRequest(url: URL): string {
  const street = url.searchParams.get('street');
  return street === null ? `q:${url.searchParams.get('q')}` : `street:${street}`;
}

describe('regionForPoint', () => {
  it('puts a Ramat Beit Shemesh point in ramat and the city centre in old', () => {
    expect(regionForPoint(RAMAT_POINT)).toBe('ramat');
    expect(regionForPoint(CITY_CENTRE)).toBe('old');
  });

  it('splits just south / north of the line at both ends of REGION_DIVIDER', () => {
    for (const end of [REGION_DIVIDER.west, REGION_DIVIDER.east]) {
      expect(regionForPoint({ lat: end.lat - 0.0005, lng: end.lng })).toBe('ramat');
      expect(regionForPoint({ lat: end.lat + 0.0005, lng: end.lng })).toBe('old');
    }
  });

  it('interpolates a tilted line between its ends and extends it beyond them', () => {
    // Rises 0.02° over 0.08°: 31.73 at the midpoint 34.99, 31.75 at 35.07 (beyond the east end).
    const tilted = { west: { lat: 31.72, lng: 34.95 }, east: { lat: 31.74, lng: 35.03 } };
    expect(regionForPoint({ lat: 31.7295, lng: 34.99 }, tilted)).toBe('ramat');
    expect(regionForPoint({ lat: 31.7305, lng: 34.99 }, tilted)).toBe('old');
    expect(regionForPoint({ lat: 31.749, lng: 35.07 }, tilted)).toBe('ramat');
    expect(regionForPoint({ lat: 31.751, lng: 35.07 }, tilted)).toBe('old');
  });
});

describe('parseNominatimResponse', () => {
  it('returns the first result inside the city, skipping an earlier one outside it', () => {
    expect(parseNominatimResponse([hit(MODIIN_POINT), hit(CITY_CENTRE)])).toEqual(CITY_CENTRE);
  });

  it('returns undefined when there are no results', () => {
    expect(parseNominatimResponse([])).toBeUndefined();
  });

  it('returns undefined when every result is outside the city', () => {
    expect(parseNominatimResponse([hit(MODIIN_POINT)])).toBeUndefined();
  });

  it('skips a result whose coordinates do not parse', () => {
    const broken = { lat: '31.7abc', lon: '34.98' };
    expect(parseNominatimResponse([broken, hit(RAMAT_POINT)])).toEqual(RAMAT_POINT);
  });

  it('rounds the point to 5 decimals', () => {
    const precise = { lat: '31.74623456', lon: '34.98871234' };
    expect(parseNominatimResponse([precise])).toEqual({ lat: 31.74623, lng: 34.98871 });
  });

  it('throws when Nominatim answers with an error object', () => {
    expect(() => parseNominatimResponse({ error: 'Unable to geocode' })).toThrow(
      /Unable to geocode/,
    );
  });

  it('uses the bounding box it is given', () => {
    const modiinBox = { south: 31.85, north: 31.95, west: 34.95, east: 35.05 };
    expect(parseNominatimResponse([hit(CITY_CENTRE), hit(MODIIN_POINT)], modiinBox)).toEqual(
      MODIIN_POINT,
    );
  });
});

describe('nominatimSearchUrls', () => {
  it('tries the structured street query first, then the free-form one', () => {
    const [structured, freeForm, ...rest] = nominatimSearchUrls('הרצל');
    expect(rest).toEqual([]);
    expect(structured?.searchParams.get('street')).toBe('הרצל');
    expect(structured?.searchParams.get('city')).toBe('בית שמש');
    expect(structured?.searchParams.has('q')).toBe(false);
    expect(freeForm?.searchParams.get('q')).toBe('הרצל, בית שמש');
    expect(freeForm?.searchParams.has('street')).toBe(false);
  });

  it('bounds both queries to the city viewbox, in west,north,east,south order', () => {
    const { west, north, east, south } = BEIT_SHEMESH_BBOX;
    for (const url of nominatimSearchUrls('הרצל')) {
      expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
      expect(url.searchParams.get('viewbox')).toBe(`${west},${north},${east},${south}`);
      expect(url.searchParams.get('viewbox')).toBe('34.942,31.776,35.032,31.687');
      expect(url.searchParams.get('bounded')).toBe('1');
      expect(url.searchParams.get('format')).toBe('jsonv2');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('countrycodes')).toBe('il');
    }
  });

  it('round-trips a Hebrew name with geresh and gershayim through the encoded URL', () => {
    for (const name of ["ז'בוטינסקי", 'שביל הל"ה']) {
      const [structured] = nominatimSearchUrls(name);
      expect(new URL(structured?.href ?? '').searchParams.get('street')).toBe(name);
    }
  });
});

describe('geocodeStreets', () => {
  it('falls back to the free-form query when the structured one finds nothing', async () => {
    const fake = fakeDeps((url) => ({
      body: url.searchParams.has('street') ? [] : [hit(CITY_CENTRE)],
    }));
    const result = await geocodeStreets(makeFile([{ code: 1, name: 'שכ נוף' }]), fake.deps);

    expect(fake.requests.map((request) => describeRequest(request.url))).toEqual([
      'street:שכ נוף',
      'q:שכ נוף, בית שמש',
    ]);
    expect(result.streets).toEqual([
      { code: 1, name: 'שכ נוף', region: 'old', lat: CITY_CENTRE.lat, lng: CITY_CENTRE.lng },
    ]);
  });

  it('sends no request for a street that already has a point (resume)', async () => {
    const located = { code: 1, name: 'הרצל', region: 'old', ...CITY_CENTRE } as const;
    const fake = fakeDeps(() => ({ body: [hit(RAMAT_POINT)] }));
    const result = await geocodeStreets(
      makeFile([located, { code: 2, name: 'נהר הירדן' }]),
      fake.deps,
    );

    expect(fake.requests.map((request) => describeRequest(request.url))).toEqual([
      'street:נהר הירדן',
    ]);
    expect(result.streets[0]).toEqual(located);
  });

  it('sleeps MIN_REQUEST_INTERVAL_MS before every request but the first', async () => {
    // Street 1 is found by its structured query; street 2 needs both queries: three requests.
    const fake = fakeDeps((url) => ({
      body: url.searchParams.get('street') === 'ב' ? [] : [hit(RAMAT_POINT)],
    }));
    await geocodeStreets(
      makeFile([
        { code: 1, name: 'א' },
        { code: 2, name: 'ב' },
      ]),
      fake.deps,
    );

    const sleep = `sleep ${MIN_REQUEST_INTERVAL_MS}`;
    expect(MIN_REQUEST_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(fake.events).toEqual(['fetch', sleep, 'fetch', sleep, 'fetch']);
  });

  it('sends the identifying User-Agent with the contact mail on every request', async () => {
    const fake = fakeDeps(() => ({ body: [] }));
    await geocodeStreets(makeFile([{ code: 1, name: 'א' }]), fake.deps);

    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      expect(request.headers['User-Agent']).toContain(TEST_EMAIL);
    }
  });

  it('saves after each street found, and logs a street that is not found', async () => {
    const fake = fakeDeps((url) => {
      const query = url.searchParams.get('street') ?? url.searchParams.get('q') ?? '';
      if (query.startsWith('א')) return { body: [hit(CITY_CENTRE)] };
      if (query.startsWith('ג')) return { body: [hit(RAMAT_POINT)] };
      return { body: [] };
    });
    const result = await geocodeStreets(
      makeFile([
        { code: 1, name: 'א' },
        { code: 2, name: 'בית לא ידוע' },
        { code: 3, name: 'ג' },
      ]),
      fake.deps,
    );

    expect(fake.saved).toHaveLength(2);
    expect(fake.saved.at(-1)).toEqual(result);
    expect(result.streets).toEqual([
      { code: 1, name: 'א', region: 'old', ...CITY_CENTRE },
      { code: 2, name: 'בית לא ידוע' },
      { code: 3, name: 'ג', region: 'ramat', ...RAMAT_POINT },
    ]);
    expect(
      fake.logs.some((line) => line.includes('not found') && line.includes('בית לא ידוע')),
    ).toBe(true);
  });

  it('rejects on HTTP 429, naming the status and the street, after saving earlier points', async () => {
    const fake = fakeDeps((url) =>
      url.searchParams.get('street') === 'א'
        ? { body: [hit(CITY_CENTRE)] }
        : { status: 429, body: 'Too Many Requests' },
    );
    const run = geocodeStreets(
      makeFile([
        { code: 1, name: 'א' },
        { code: 2, name: 'ב' },
      ]),
      fake.deps,
    );

    await expect(run).rejects.toThrow(/HTTP 429.*2 "ב"/);
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]?.streets[0]).toEqual({
      code: 1,
      name: 'א',
      region: 'old',
      ...CITY_CENTRE,
    });
  });

  it('rejects when Nominatim answers with an error object, naming the street', async () => {
    const fake = fakeDeps(() => ({ body: { error: 'Unable to geocode' } }));
    await expect(geocodeStreets(makeFile([{ code: 7, name: 'א' }]), fake.deps)).rejects.toThrow(
      /Unable to geocode.*7 "א"/,
    );
  });

  it('never mutates the input file', async () => {
    const input = makeFile([
      { code: 1, name: 'א' },
      { code: 2, name: 'ב' },
    ]);
    const snapshot = structuredClone(input);
    const fake = fakeDeps(() => ({ body: [hit(CITY_CENTRE)] }));
    await geocodeStreets(input, fake.deps);

    expect(input).toEqual(snapshot);
  });
});

/** A data.gov.il datastore_search answer, with the extra keys CKAN sends. */
function dataGovResponse(
  records: { code: number; name: string; locality?: number }[],
  total = records.length,
) {
  return {
    help: 'https://data.gov.il/api/3/action/help_show?name=datastore_search',
    success: true,
    result: {
      total,
      records: records.map(({ code, name, locality = 2610 }, index) => ({
        _id: index + 1,
        סמל_ישוב: locality,
        שם_ישוב: 'בית שמש ',
        סמל_רחוב: code,
        שם_רחוב: name,
      })),
    },
  };
}

describe('parseStreetList', () => {
  it('returns the codes and trimmed names', () => {
    const json = dataGovResponse([
      { code: 101, name: 'הרצל     ' },
      { code: 9000, name: ' בית שמש ' },
    ]);
    expect(parseStreetList(json)).toEqual([
      { code: 101, name: 'הרצל' },
      { code: 9000, name: 'בית שמש' },
    ]);
  });

  it('throws on a record of another locality', () => {
    const json = dataGovResponse([{ code: 101, name: 'הרצל', locality: 3000 }]);
    expect(() => parseStreetList(json)).toThrow(/locality 3000/);
  });

  it('throws when the answer is truncated (total larger than the records)', () => {
    const json = dataGovResponse([{ code: 101, name: 'הרצל' }], 2500);
    expect(() => parseStreetList(json)).toThrow(/truncated/);
  });

  it('throws on a repeated street code', () => {
    const json = dataGovResponse([
      { code: 101, name: 'הרצל' },
      { code: 101, name: 'הרצל ב' },
    ]);
    expect(() => parseStreetList(json)).toThrow(/101 twice/);
  });

  it('throws on a failed CKAN call', () => {
    expect(() => parseStreetList({ success: false, error: { message: 'boom' } })).toThrow();
  });
});

describe('mergeStreetList', () => {
  const current: Street[] = [
    { code: 101, name: 'הרצל', region: 'old', ...CITY_CENTRE },
    { code: 102, name: 'שם ישן', region: 'ramat', ...RAMAT_POINT },
    { code: 103, name: 'נמחק' },
  ];
  // Unsorted on purpose: the merge sorts by code.
  const list = [
    { code: 104, name: 'חדש' },
    { code: 102, name: 'שם חדש' },
    { code: 101, name: 'הרצל' },
  ];

  it('keeps points of existing codes (also when renamed), adds new codes, removes missing ones', () => {
    const merged = mergeStreetList(current, list);
    expect(merged.streets).toEqual([
      { code: 101, name: 'הרצל', region: 'old', ...CITY_CENTRE },
      { code: 102, name: 'שם חדש', region: 'ramat', ...RAMAT_POINT },
      { code: 104, name: 'חדש' },
    ]);
    expect(merged.added).toEqual([{ code: 104, name: 'חדש' }]);
    expect(merged.removed).toEqual([{ code: 103, name: 'נמחק' }]);
    expect(merged.renamed).toEqual([{ code: 102, from: 'שם ישן', to: 'שם חדש' }]);
  });

  it('writes the keys in the file order code, name, region, lat, lng', () => {
    const merged = mergeStreetList(current, list);
    expect(Object.keys(merged.streets[1] ?? {})).toEqual(['code', 'name', 'region', 'lat', 'lng']);
  });
});

describe('recomputeRegions', () => {
  it('sets the region from the point, overwriting a hand-set one', () => {
    const file = makeFile([{ code: 1, name: 'א', region: 'old', ...RAMAT_POINT }]);
    expect(recomputeRegions(file).streets).toEqual([
      { code: 1, name: 'א', region: 'ramat', ...RAMAT_POINT },
    ]);
    expect(file.streets[0]?.region).toBe('old');
  });

  it('leaves a street without a point without a region', () => {
    const file = makeFile([{ code: 1, name: 'א' }]);
    expect(recomputeRegions(file).streets).toEqual([{ code: 1, name: 'א' }]);
  });
});

describe('serializeStreetsFile', () => {
  it('round-trips the committed streets.json byte for byte', async () => {
    const text = await fs.readFile(STREETS_FILE, 'utf8');
    const file = streetsFileSchema.parse(JSON.parse(text));
    expect(serializeStreetsFile(file)).toBe(text);
  });

  it('writes a geocoded street on one line, keys in file order', () => {
    const file = makeFile([{ lng: 34.98, lat: 31.7, region: 'ramat', name: 'x', code: 1 }]);
    expect(serializeStreetsFile(file).split('\n')).toContain(
      '    {"code":1,"name":"x","region":"ramat","lat":31.7,"lng":34.98}',
    );
  });

  it('sorts the streets by code', () => {
    const text = serializeStreetsFile(
      makeFile([
        { code: 2, name: 'ב' },
        { code: 1, name: 'א' },
      ]),
    );
    expect(text.indexOf('"code":1')).toBeLessThan(text.indexOf('"code":2'));
  });
});

describe('todayInJerusalem', () => {
  it('formats the date in Asia/Jerusalem, not UTC', () => {
    // 22:30 UTC on 19/10 is already 01:30 on 20/10 in Israel (UTC+3 in summer time).
    expect(todayInJerusalem(new Date('2026-10-19T22:30:00Z'))).toBe('2026-10-20');
    expect(todayInJerusalem(new Date('2026-10-19T20:00:00Z'))).toBe('2026-10-19');
  });
});

describe('userAgentFor', () => {
  it('identifies the app and contains the contact mail', () => {
    expect(userAgentFor(TEST_EMAIL)).toBe(`BottleRun-street-geocoder/1.0 (contact: ${TEST_EMAIL})`);
  });

  it('throws without a mail address', () => {
    expect(() => userAgentFor('')).toThrow(/NOMINATIM_EMAIL/);
    expect(() => userAgentFor('not-an-address')).toThrow(/NOMINATIM_EMAIL/);
  });
});

describe('with a temp directory', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bottlerun-streets-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('writeStreetsFile', () => {
    it('writes the serialized file and leaves no .tmp behind', async () => {
      const target = path.join(tempDir, 'streets.json');
      const file = makeFile([{ code: 1, name: 'א', region: 'old', ...CITY_CENTRE }]);
      await writeStreetsFile(target, file);

      expect(await fs.readFile(target, 'utf8')).toBe(serializeStreetsFile(file));
      expect(await fs.readdir(tempDir)).toEqual(['streets.json']);
    });

    it('refuses an invalid file and leaves the existing one untouched', async () => {
      const target = path.join(tempDir, 'streets.json');
      await writeStreetsFile(target, makeFile([{ code: 1, name: 'א' }]));
      const before = await fs.readFile(target, 'utf8');

      const duplicateCodes = makeFile([
        { code: 1, name: 'א' },
        { code: 1, name: 'ב' },
      ]);
      await expect(writeStreetsFile(target, duplicateCodes)).rejects.toThrow(/duplicate/);
      expect(await fs.readFile(target, 'utf8')).toBe(before);
      expect(await fs.readdir(tempDir)).toEqual(['streets.json']);
    });
  });

  describe('main', () => {
    const fixedNow = (): Date => new Date('2026-10-19T09:00:00Z');

    /** Writes `file` as the streets file of a test run; returns its path. */
    async function tempStreetsFile(file: StreetsFile): Promise<string> {
      const target = path.join(tempDir, 'streets.json');
      await fs.writeFile(target, serializeStreetsFile(file), 'utf8');
      return target;
    }

    /** A fetch that must not be called: records the URL and fails the request. */
    function forbiddenFetch() {
      const urls: string[] = [];
      const fetch: GeocodeDeps['fetch'] = (url) => {
        urls.push(url.href);
        return Promise.reject(new Error('no network in this test'));
      };
      return { fetch, urls };
    }

    it('--regions recomputes regions without an email or any request', async () => {
      const streetsFile = await tempStreetsFile(
        makeFile([
          { code: 1, name: 'א', region: 'old', ...RAMAT_POINT },
          { code: 2, name: 'ב' },
        ]),
      );
      const network = forbiddenFetch();
      const logs: string[] = [];

      const exitCode = await main(
        ['--regions'],
        {},
        {
          streetsFile,
          fetch: network.fetch,
          log: (line) => logs.push(line),
          now: fixedNow,
        },
      );

      expect(exitCode).toBe(0);
      expect(network.urls).toEqual([]);
      const written = streetsFileSchema.parse(JSON.parse(await fs.readFile(streetsFile, 'utf8')));
      expect(written.updatedAt).toBe('2026-10-19');
      expect(written.streets).toEqual([
        { code: 1, name: 'א', region: 'ramat', ...RAMAT_POINT },
        { code: 2, name: 'ב' },
      ]);
      expect(logs).toContain('  without a point: 1');
    });

    it('returns 1 without NOMINATIM_EMAIL, makes no request and leaves the file as it was', async () => {
      const streetsFile = await tempStreetsFile(makeFile([{ code: 1, name: 'א' }]));
      const before = await fs.readFile(streetsFile, 'utf8');
      const network = forbiddenFetch();
      const logs: string[] = [];

      const exitCode = await main(
        [],
        {},
        {
          streetsFile,
          fetch: network.fetch,
          log: (line) => logs.push(line),
        },
      );

      expect(exitCode).toBe(1);
      expect(network.urls).toEqual([]);
      expect(await fs.readFile(streetsFile, 'utf8')).toBe(before);
      expect(logs.some((line) => line.includes('NOMINATIM_EMAIL=<contact mail> npx tsx'))).toBe(
        true,
      );
    });

    it('returns 2 with the usage for an unknown flag, before touching the file', async () => {
      const network = forbiddenFetch();
      const logs: string[] = [];
      const exitCode = await main(
        ['--bogus'],
        {},
        {
          streetsFile: path.join(tempDir, 'missing.json'),
          fetch: network.fetch,
          log: (line) => logs.push(line),
        },
      );

      expect(exitCode).toBe(2);
      expect(network.urls).toEqual([]);
      expect(logs.join('\n')).toMatch(/usage:/);
    });

    it('geocodes the missing points and saves them with a fresh updatedAt', async () => {
      const streetsFile = await tempStreetsFile(makeFile([{ code: 1, name: 'א' }]));
      const fake = fakeDeps(() => ({ body: [hit(CITY_CENTRE)] }));

      const exitCode = await main(
        [],
        { NOMINATIM_EMAIL: TEST_EMAIL },
        {
          streetsFile,
          fetch: fake.deps.fetch,
          sleep: fake.deps.sleep,
          log: () => {},
          now: fixedNow,
        },
      );

      expect(exitCode).toBe(0);
      expect(fake.requests[0]?.headers['User-Agent']).toContain(TEST_EMAIL);
      const written = streetsFileSchema.parse(JSON.parse(await fs.readFile(streetsFile, 'utf8')));
      expect(written.updatedAt).toBe('2026-10-19');
      expect(written.streets).toEqual([{ code: 1, name: 'א', region: 'old', ...CITY_CENTRE }]);
    });

    it('returns 1 and tells how to continue when Nominatim throttles the run', async () => {
      const streetsFile = await tempStreetsFile(makeFile([{ code: 1, name: 'א' }]));
      const fake = fakeDeps(() => ({ status: 429, body: 'Too Many Requests' }));
      const logs: string[] = [];

      const exitCode = await main(
        [],
        { NOMINATIM_EMAIL: TEST_EMAIL },
        {
          streetsFile,
          fetch: fake.deps.fetch,
          sleep: fake.deps.sleep,
          log: (line) => logs.push(line),
        },
      );

      expect(exitCode).toBe(1);
      expect(logs.join('\n')).toMatch(/HTTP 429[\s\S]*re-run the same command to continue/);
    });

    it('--refresh-list merges the data.gov.il list and saves it before asking for the email', async () => {
      const streetsFile = await tempStreetsFile(
        makeFile([{ code: 101, name: 'הרצל', region: 'old', ...CITY_CENTRE }]),
      );
      const requests: URL[] = [];
      const fetch: GeocodeDeps['fetch'] = (url) => {
        requests.push(url);
        const body = dataGovResponse([
          { code: 101, name: 'הרצל ' },
          { code: 102, name: 'חדש' },
        ]);
        return Promise.resolve(new Response(JSON.stringify(body)));
      };

      const exitCode = await main(
        ['--refresh-list'],
        {},
        {
          streetsFile,
          fetch,
          log: () => {},
          now: fixedNow,
        },
      );

      expect(exitCode).toBe(1); // the list is saved; the points still need NOMINATIM_EMAIL
      expect(requests.map((url) => url.hostname)).toEqual(['data.gov.il']);
      expect(JSON.parse(requests[0]?.searchParams.get('filters') ?? '')).toEqual({
        סמל_ישוב: 2610,
      });
      const written = streetsFileSchema.parse(JSON.parse(await fs.readFile(streetsFile, 'utf8')));
      expect(written.updatedAt).toBe('2026-10-19');
      expect(written.streets).toEqual([
        { code: 101, name: 'הרצל', region: 'old', ...CITY_CENTRE },
        { code: 102, name: 'חדש' },
      ]);
    });
  });
});
