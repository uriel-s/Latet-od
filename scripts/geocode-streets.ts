// One-time job (ADR-0005) that maintains packages/shared/data/streets.json: the official Beit
// Shemesh street list from data.gov.il, plus one OpenStreetMap point (via Nominatim) and a
// region per street. The app never calls Nominatim at runtime; it reads the committed file.
//
//   NOMINATIM_EMAIL=<contact mail> npx tsx scripts/geocode-streets.ts                 # fill missing points
//   npx tsx scripts/geocode-streets.ts --refresh-list                                  # re-download codes+names from data.gov.il, then fill missing points (needs NOMINATIM_EMAIL for the second step)
//   npx tsx scripts/geocode-streets.ts --regions                                       # recompute region of every street from its point (no network); overwrites hand-fixed regions
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/), which allows
// small one-off bulk jobs like this one only on these terms:
//   - a single thread: one request at a time, never in parallel;
//   - at most 1 request per second (we wait MIN_REQUEST_INTERVAL_MS between requests);
//   - an identifying User-Agent with a contact address (from env NOMINATIM_EMAIL, never in code);
//   - results are cached: they are committed to the repo, so the job is not repeated.
// The file is saved after every point found, so an interrupted run loses nothing: re-running the
// same command continues with the streets that still have no point.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { streetsFileSchema, type Region, type Street, type StreetsFile } from '@bottlerun/shared';

/** Absolute path of the committed street list, packages/shared/data/streets.json. */
export const STREETS_FILE: string = fileURLToPath(
  new URL('../packages/shared/data/streets.json', import.meta.url),
);

/** data.gov.il code of the locality Beit Shemesh (סמל ישוב). */
const BEIT_SHEMESH_LOCALITY = 2610;

/**
 * data.gov.il (CKAN) `datastore_search` URL that returns every street of Beit Shemesh from the
 * national street list (resource 9ad3862c-…). The city has ~461 streets; `limit=2000` leaves
 * room, and parseStreetList fails loudly if the answer is ever truncated.
 */
export const DATA_GOV_URL: string = (() => {
  const url = new URL('https://data.gov.il/api/3/action/datastore_search');
  url.searchParams.set('resource_id', '9ad3862c-8391-4b2f-84a4-2d4c68625f4b');
  url.searchParams.set('filters', JSON.stringify({ סמל_ישוב: BEIT_SHEMESH_LOCALITY }));
  url.searchParams.set('limit', '2000');
  return url.href;
})();

// data.gov.il's firewall has been reported to turn away generic HTTP clients; this is the
// User-Agent its API users send to get through. It names no person, so no contact mail is needed.
const DATA_GOV_USER_AGENT = 'datagov-external-client';

/**
 * Bounding box of Beit Shemesh: Nominatim's boundingbox of the city boundary, OSM relation
 * 1379449 (31.6872931, 31.7753310, 34.9423742, 35.0318847), rounded outward to 3 decimals.
 * Used twice: as the bounded viewbox of every query, and to reject any result outside the city
 * (a street with the same name in Modi'in or Jerusalem must never become a stop's point).
 */
export const BEIT_SHEMESH_BBOX = { south: 31.687, north: 31.776, west: 34.942, east: 35.032 };

/** A point in WGS84 degrees, as stored in streets.json. */
export type LatLng = { lat: number; lng: number };

/**
 * Dividing line between the two halves of the city: רמת בית שמש (`ramat`) is SOUTH of the line,
 * בית שמש הוותיקה (`old`) is north of it.
 *
 * A straight line through two points rather than a single latitude, so it can be tilted to
 * follow the real gap between the neighbourhoods. Points west of `west` or east of `east` use
 * the line extended (see regionForPoint).
 *
 * PROVISIONAL: a horizontal line at 31.729 across the whole bbox, until the streets are geocoded
 * and the line is chosen from the real points. Changing it does not touch the file by itself:
 * run `npx tsx scripts/geocode-streets.ts --regions` to recompute every street's region.
 */
export const REGION_DIVIDER: { west: LatLng; east: LatLng } = {
  west: { lat: 31.729, lng: 34.942 },
  east: { lat: 31.729, lng: 35.032 },
};

/**
 * Region of a point: `ramat` if it is south of the dividing line, else `old` (a point exactly on
 * the line counts as `old`). The line's latitude at the point's longitude is interpolated
 * linearly between the two ends, and extrapolated beyond them.
 */
export function regionForPoint(
  point: LatLng,
  divider: { west: LatLng; east: LatLng } = REGION_DIVIDER,
): Region {
  const { west, east } = divider;
  const slope = (east.lat - west.lat) / (east.lng - west.lng);
  const lineLat = west.lat + slope * (point.lng - west.lng);
  return point.lat < lineLat ? 'ramat' : 'old';
}

/** A street as data.gov.il lists it: official code and name, no point. */
export type StreetListEntry = { code: number; name: string };

// Only the fields we use; CKAN adds more (`_id`, `שם_ישוב`, `fields`, `help` …), allowed through.
const dataGovResponseSchema = z.looseObject({
  success: z.literal(true),
  result: z.looseObject({
    total: z.int().nonnegative(),
    records: z.array(
      z.looseObject({
        סמל_ישוב: z.int(),
        סמל_רחוב: z.int().positive(),
        // The national list pads names with trailing spaces.
        שם_רחוב: z.string().trim().min(1),
      }),
    ),
  }),
});

/**
 * Codes and trimmed names from a data.gov.il `datastore_search` response (see DATA_GOV_URL).
 * Throws on anything that would silently corrupt the list: a record of another locality, an
 * answer cut off by the `limit` (`total` larger than the records returned), or a repeated code.
 */
export function parseStreetList(json: unknown): StreetListEntry[] {
  const { result } = dataGovResponseSchema.parse(json);
  if (result.total !== result.records.length) {
    throw new Error(
      `data.gov.il returned ${result.records.length} of ${result.total} streets: the answer is ` +
        'truncated, raise `limit` in DATA_GOV_URL',
    );
  }
  const seenCodes = new Set<number>();
  return result.records.map((record) => {
    if (record.סמל_ישוב !== BEIT_SHEMESH_LOCALITY) {
      throw new Error(
        `data.gov.il record ${record.סמל_רחוב} belongs to locality ${record.סמל_ישוב}, ` +
          `not Beit Shemesh (${BEIT_SHEMESH_LOCALITY})`,
      );
    }
    if (seenCodes.has(record.סמל_רחוב)) {
      throw new Error(`data.gov.il lists street code ${record.סמל_רחוב} twice`);
    }
    seenCodes.add(record.סמל_רחוב);
    return { code: record.סמל_רחוב, name: record.שם_רחוב };
  });
}

/**
 * A street with its keys in the file's order (code, name, region, lat, lng) and absent keys
 * left out, so serialized lines are stable and diffs stay one line per changed street.
 */
function orderedStreet(street: Street): Street {
  const { code, name, region, lat, lng } = street;
  return {
    code,
    name,
    ...(region === undefined ? {} : { region }),
    ...(lat === undefined ? {} : { lat }),
    ...(lng === undefined ? {} : { lng }),
  };
}

/**
 * Merges a fresh data.gov.il list into the current streets, matching by code (orders store the
 * code, so the code is the identity). A code still in the list keeps its region and point, also
 * when its name changed: a renamed street is still the same road. Codes not in the list are
 * dropped, new codes are added without a point. Returns the new streets sorted by code plus what
 * changed, for the log.
 */
export function mergeStreetList(
  current: readonly Street[],
  list: readonly StreetListEntry[],
): {
  streets: Street[];
  added: Street[];
  removed: Street[];
  renamed: { code: number; from: string; to: string }[];
} {
  const currentByCode = new Map(current.map((street) => [street.code, street]));
  const listCodes = new Set(list.map((entry) => entry.code));
  const byCode = (a: { code: number }, b: { code: number }): number => a.code - b.code;

  const streets: Street[] = [];
  const added: Street[] = [];
  const renamed: { code: number; from: string; to: string }[] = [];
  for (const entry of [...list].sort(byCode)) {
    const existing = currentByCode.get(entry.code);
    const street = orderedStreet({ ...existing, code: entry.code, name: entry.name });
    streets.push(street);
    if (existing === undefined) added.push(street);
    else if (existing.name !== entry.name) {
      renamed.push({ code: entry.code, from: existing.name, to: entry.name });
    }
  }
  const removed = current.filter((street) => !listCodes.has(street.code)).sort(byCode);
  return { streets, added, removed, renamed };
}

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const CITY_NAME = 'בית שמש';

/** A Nominatim search URL with the parameters every query shares: JSON, Israel, inside the city. */
function nominatimBaseUrl(): URL {
  const url = new URL(NOMINATIM_SEARCH_URL);
  const { west, north, east, south } = BEIT_SHEMESH_BBOX;
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'il');
  // Nominatim's viewbox is <x1>,<y1>,<x2>,<y2> in lon/lat; bounded=1 makes it a hard filter.
  url.searchParams.set('viewbox', `${west},${north},${east},${south}`);
  url.searchParams.set('bounded', '1');
  return url;
}

/**
 * The Nominatim queries for one street, in the order to try them:
 * 1. structured `street=<name>&city=בית שמש`, which returns the street (highway) object itself;
 * 2. free-form `q=<name>, בית שמש`, which also finds names in the list that are neighbourhoods
 *    or places rather than streets ("שכ …", "גבעת …").
 */
export function nominatimSearchUrls(streetName: string): URL[] {
  const structured = nominatimBaseUrl();
  structured.searchParams.set('street', streetName);
  structured.searchParams.set('city', CITY_NAME);
  const freeForm = nominatimBaseUrl();
  freeForm.searchParams.set('q', `${streetName}, ${CITY_NAME}`);
  return [structured, freeForm];
}

// jsonv2 search results: coordinates are strings. Other fields are not used.
const nominatimResultsSchema = z.array(z.looseObject({ lat: z.string(), lon: z.string() }));

/** Rounds to 5 decimals (≈1 m): a street-level point needs no more, and the file stays short. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * The point of the first search result inside `bbox`, rounded to 5 decimals, or undefined when
 * no result qualifies. Results with unparseable coordinates are skipped. Throws when the answer
 * is not a result list (Nominatim reports errors as an object such as `{ error: … }`).
 */
export function parseNominatimResponse(
  json: unknown,
  bbox: typeof BEIT_SHEMESH_BBOX = BEIT_SHEMESH_BBOX,
): LatLng | undefined {
  if (!Array.isArray(json)) {
    // String(): JSON.stringify(undefined) is undefined, not a string.
    const answer = String(JSON.stringify(json)).slice(0, 200);
    throw new Error(`Nominatim did not return a result list: ${answer}`);
  }
  for (const result of nominatimResultsSchema.parse(json)) {
    // Number(), not parseFloat(): "31.7abc" must be rejected, not read as 31.7.
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const insideCity =
      lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
    if (insideCity) return { lat: roundCoordinate(lat), lng: roundCoordinate(lng) };
  }
  return undefined;
}

/** Everything geocodeStreets touches outside itself, injected so tests need no network or disk. */
export type GeocodeDeps = {
  fetch: (url: URL, init: { headers: Record<string, string> }) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Persists the file so far; called after every point found. */
  save: (file: StreetsFile) => Promise<void>;
  /** From userAgentFor: the policy requires an identifying User-Agent. */
  userAgent: string;
  log: (line: string) => void;
};

/** Pause between two Nominatim requests. The policy says max 1/s; the margin keeps us under it. */
export const MIN_REQUEST_INTERVAL_MS = 1100;

/**
 * The identifying User-Agent the Nominatim policy requires, with a contact address so OSM can
 * reach us instead of blocking. Throws if `email` is missing or is not an address.
 */
export function userAgentFor(email: string): string {
  const contact = email.trim();
  if (!contact.includes('@')) {
    throw new Error(
      'NOMINATIM_EMAIL must be a contact e-mail address: the Nominatim usage policy requires ' +
        'one in the User-Agent',
    );
  }
  return `BottleRun-street-geocoder/1.0 (contact: ${contact})`;
}

function hasPoint(street: Street): street is Street & LatLng {
  return street.lat !== undefined && street.lng !== undefined;
}

/** The street with this point and the region the point is in. */
function withPoint(street: Street, point: LatLng): Street {
  return orderedStreet({
    ...street,
    region: regionForPoint(point),
    lat: point.lat,
    lng: point.lng,
  });
}

/**
 * Fills the point and region of every street that has no point, one Nominatim request at a time.
 *
 * Streets that already have a point are skipped: that is how a re-run resumes, since every point
 * found is saved at once. A street without one (not found last time, or not tried yet) is tried
 * again on every run, which also picks up fixes made in OSM since. Per street the queries of
 * nominatimSearchUrls are tried in order until one finds a point inside the city; a street that
 * none finds is logged and stays without point and region (fill it by hand, ADR-0005).
 *
 * Waits MIN_REQUEST_INTERVAL_MS before every request except the first. A non-2xx answer (429:
 * we are throttled, 403: blocked) stops the run with an Error naming the status and the street;
 * nothing else needs saving then, because every point found was already saved.
 * Never mutates `file`; resolves with the final file.
 */
export async function geocodeStreets(file: StreetsFile, deps: GeocodeDeps): Promise<StreetsFile> {
  const headers = { 'User-Agent': deps.userAgent };
  const streets = [...file.streets];
  let current = file;
  let isFirstRequest = true;

  const missing = streets.filter((street) => !hasPoint(street));
  deps.log(`${missing.length} of ${streets.length} streets have no point; geocoding them`);

  for (const [index, street] of file.streets.entries()) {
    if (hasPoint(street)) continue;
    const label = `${street.code} "${street.name}"`;

    let point: LatLng | undefined;
    for (const url of nominatimSearchUrls(street.name)) {
      if (!isFirstRequest) await deps.sleep(MIN_REQUEST_INTERVAL_MS);
      isFirstRequest = false;
      const response = await deps.fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Nominatim answered HTTP ${response.status} for street ${label}`);
      }
      try {
        point = parseNominatimResponse(await response.json());
      } catch (error) {
        throw new Error(`${errorMessage(error)} (street ${label})`, { cause: error });
      }
      if (point !== undefined) break;
    }

    if (point === undefined) {
      deps.log(`not found: ${label}`);
      continue;
    }
    streets[index] = withPoint(street, point);
    current = { ...current, streets: [...streets] };
    // Incremental: from here on this point survives a crash, a 429 or Ctrl+C.
    await deps.save(current);
    deps.log(`found: ${label} ${point.lat},${point.lng} (${regionForPoint(point)})`);
  }
  return current;
}

/**
 * Sets every street's region from its point (after REGION_DIVIDER changed). This overwrites
 * regions fixed by hand. A street without a point has nothing to compute from and is left as it
 * is: it keeps no region, or the region someone set by hand.
 */
export function recomputeRegions(file: StreetsFile): StreetsFile {
  return {
    ...file,
    streets: file.streets.map((street) =>
      hasPoint(street)
        ? orderedStreet({ ...street, region: regionForPoint(street) })
        : orderedStreet(street),
    ),
  };
}

/**
 * The file's exact text format: header keys indented 2 spaces, then each street on its own line
 * (4 spaces + compact JSON, keys code,name,region,lat,lng), sorted by code, LF, trailing newline.
 * One street per line keeps git diffs readable; prettier is told to leave the file alone.
 */
export function serializeStreetsFile(file: StreetsFile): string {
  const header = [
    `  "attribution": ${JSON.stringify(file.attribution)},`,
    `  "license": ${JSON.stringify(file.license)},`,
    `  "source": ${JSON.stringify(file.source)},`,
    `  "updatedAt": ${JSON.stringify(file.updatedAt)},`,
  ];
  const streetLines = [...file.streets]
    .sort((a, b) => a.code - b.code)
    .map((street) => `    ${JSON.stringify(orderedStreet(street))}`);
  return ['{', ...header, '  "streets": [', streetLines.join(',\n'), '  ]', '}', ''].join('\n');
}

/**
 * Writes the file atomically: validates it first (a broken file is never written), writes
 * `<path>.tmp`, then renames it over `path`. A run killed mid-write leaves the old file intact.
 */
export async function writeStreetsFile(filePath: string, file: StreetsFile): Promise<void> {
  const valid = streetsFileSchema.parse(file);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, serializeStreetsFile(valid), 'utf8');
  await fs.rename(tempPath, filePath);
}

/** `YYYY-MM-DD` of `now` in Asia/Jerusalem (the project's time zone); stored as `updatedAt`. */
export function todayInJerusalem(now: Date): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** What main needs from the outside world; tests override any of it. */
export type MainDeps = {
  fetch: GeocodeDeps['fetch'];
  sleep: GeocodeDeps['sleep'];
  log: (line: string) => void;
  /** Path of the streets file to read and write; tests pass a temp copy. */
  streetsFile: string;
  now: () => Date;
};

const defaultMainDeps: MainDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  streetsFile: STREETS_FILE,
  now: () => new Date(),
};

const GEOCODE_COMMAND = 'NOMINATIM_EMAIL=<contact mail> npx tsx scripts/geocode-streets.ts';

const USAGE = [
  'usage:',
  `  ${GEOCODE_COMMAND}`,
  '      fill the missing points from Nominatim (resumes where the last run stopped)',
  '  npx tsx scripts/geocode-streets.ts --refresh-list',
  '      re-download codes and names from data.gov.il, then fill the missing points',
  '      (the second step needs NOMINATIM_EMAIL)',
  '  npx tsx scripts/geocode-streets.ts --regions',
  '      recompute every street region from its point after REGION_DIVIDER changed',
  '      (no network; overwrites hand-fixed regions)',
].join('\n');

type Mode = 'geocode' | 'refresh-list' | 'regions' | 'help';

/** The mode the arguments ask for; undefined for anything unknown (one flag at most). */
function parseMode(argv: readonly string[]): Mode | undefined {
  if (argv.length === 0) return 'geocode';
  if (argv.length > 1) return undefined;
  switch (argv[0]) {
    case '--refresh-list':
      return 'refresh-list';
    case '--regions':
      return 'regions';
    case '--help':
    case '-h':
      return 'help';
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** End-of-run summary: the counts, then every street still without a point (to fill by hand). */
function summaryLines(file: StreetsFile): string[] {
  const withoutPoint = file.streets.filter((street) => !hasPoint(street));
  const countRegion = (region: Region): number =>
    file.streets.filter((street) => street.region === region).length;
  return [
    'summary:',
    `  streets:         ${file.streets.length}`,
    `  with a point:    ${file.streets.length - withoutPoint.length}`,
    `  without a point: ${withoutPoint.length}`,
    `  ramat:           ${countRegion('ramat')}`,
    `  old:             ${countRegion('old')}`,
    ...(withoutPoint.length === 0
      ? []
      : [
          'streets without a point (fill by hand from openstreetmap.org, or leave empty):',
          ...withoutPoint.map((street) => `  ${street.code} ${street.name}`),
        ]),
  ];
}

/** Downloads the Beit Shemesh street list from data.gov.il. */
async function downloadStreetList(fetch: MainDeps['fetch']): Promise<StreetListEntry[]> {
  const response = await fetch(new URL(DATA_GOV_URL), {
    headers: { 'User-Agent': DATA_GOV_USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`data.gov.il answered HTTP ${response.status}`);
  return parseStreetList(await response.json());
}

/**
 * The command line: see the usage at the top of this file. `argv` excludes node and the script.
 * Resolves with the exit code: 0 done, 1 failed or needs NOMINATIM_EMAIL, 2 bad arguments.
 */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: Partial<MainDeps> = {},
): Promise<number> {
  const { fetch, sleep, log, streetsFile, now } = { ...defaultMainDeps, ...deps };
  const logAll = (lines: readonly string[]): void => lines.forEach((line) => log(line));

  const mode = parseMode(argv);
  if (mode === undefined) {
    log(`unknown arguments: ${argv.join(' ')}`);
    log(USAGE);
    return 2;
  }
  if (mode === 'help') {
    log(USAGE);
    return 0;
  }

  let file: StreetsFile;
  try {
    file = streetsFileSchema.parse(JSON.parse(await fs.readFile(streetsFile, 'utf8')));
  } catch (error) {
    log(`cannot read ${streetsFile}: ${errorMessage(error)}`);
    return 1;
  }
  // Every write stamps today's date; `file` always mirrors what is on disk, for the summary.
  const save = async (updated: StreetsFile): Promise<void> => {
    const stamped = { ...updated, updatedAt: todayInJerusalem(now()) };
    await writeStreetsFile(streetsFile, stamped);
    file = stamped;
  };

  if (mode === 'regions') {
    try {
      const recomputed = recomputeRegions(file);
      const changed = recomputed.streets.filter(
        (street, index) => street.region !== file.streets[index]?.region,
      ).length;
      await save(recomputed);
      log(`regions recomputed from the points: ${changed} changed`);
    } catch (error) {
      log(`could not recompute the regions: ${errorMessage(error)}`);
      return 1;
    }
    logAll(summaryLines(file));
    return 0;
  }

  if (mode === 'refresh-list') {
    try {
      const merged = mergeStreetList(file.streets, await downloadStreetList(fetch));
      log(
        `data.gov.il: ${merged.streets.length} streets; ${merged.added.length} added, ` +
          `${merged.removed.length} removed, ${merged.renamed.length} renamed`,
      );
      merged.added.forEach((street) => log(`  added:   ${street.code} ${street.name}`));
      merged.removed.forEach((street) => log(`  removed: ${street.code} ${street.name}`));
      merged.renamed.forEach(({ code, from, to }) => log(`  renamed: ${code} ${from} -> ${to}`));
      await save({ ...file, streets: merged.streets });
    } catch (error) {
      log(`could not refresh the street list: ${errorMessage(error)}`);
      log('the streets file was not changed.');
      return 1;
    }
  }

  // Checked before the first request: without a contact address we may not query Nominatim.
  let userAgent: string;
  try {
    userAgent = userAgentFor(env.NOMINATIM_EMAIL ?? '');
  } catch {
    log(
      (mode === 'refresh-list' ? 'The street list is saved. ' : '') +
        'To fill the missing points, set NOMINATIM_EMAIL to a contact e-mail address (the ' +
        'Nominatim usage policy requires one in the User-Agent) and run:',
    );
    log(`  ${GEOCODE_COMMAND}`);
    logAll(summaryLines(file));
    return 1;
  }

  try {
    await geocodeStreets(file, { fetch, sleep, save, userAgent, log });
  } catch (error) {
    log(`stopped: ${errorMessage(error)}`);
    log('points found so far are saved; re-run the same command to continue.');
    logAll(summaryLines(file));
    return 1;
  }
  logAll(summaryLines(file));
  return 0;
}

// Run only when executed directly (`npx tsx scripts/geocode-streets.ts`), never on import from
// a test. Compared case-insensitively: on Windows the drive letter's case can differ.
const thisFile = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
const invokedFile = path.resolve(process.argv[1] ?? '').toLowerCase();
if (thisFile === invokedFile) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
