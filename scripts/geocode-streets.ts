// One-time job (ADR-0005) that maintains packages/shared/data/streets.json: the official Beit
// Shemesh street list from data.gov.il, plus one OpenStreetMap point (via Nominatim) and a
// region per street. The app never calls Nominatim at runtime; it reads the committed file.
//
//   NOMINATIM_EMAIL=<contact mail> npx tsx scripts/geocode-streets.ts                 # fill missing points
//   npx tsx scripts/geocode-streets.ts --refresh-list                                  # re-download codes+names from data.gov.il, then fill missing points (needs NOMINATIM_EMAIL for the second step)
//   npx tsx scripts/geocode-streets.ts --regions                                       # recompute region of every street from its point (no network); overwrites hand-fixed regions
//   npx tsx scripts/geocode-streets.ts --point <code> <lat>,<lng>                      # set one street's point by hand (no network); region from the point
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/), which allows
// small one-off bulk jobs like this one only on these terms:
//   - a single thread: one request at a time, never in parallel;
//   - at most 1 request per second (we wait MIN_REQUEST_INTERVAL_MS between requests);
//   - an identifying User-Agent with a contact address (from env NOMINATIM_EMAIL, never in code);
//   - results are cached: they are committed to the repo, so the job is not repeated.
// The file is saved after every point found, so an interrupted run loses nothing: re-running the
// same command continues with the streets that still have no point.
//
// Per street, a few spellings of the name are tried, one request after another, and the search
// stops at the first that finds a point (nominatimSearchUrls, streetNameVariants): the official
// list abbreviates where OSM spells out ("סמ האלון" is "סמטת האלון" in OSM, `רשב"י` is "רשבי"). A
// street OSM names as the list does still costs one request; a street that nothing finds costs
// one per spelling plus one free-form fallback, still one at a time with the same pause.
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
 * follow the real gap between the neighbourhoods. Its ends sit on the west and east edges of
 * BEIT_SHEMESH_BBOX; points beyond them use the line extended (see regionForPoint).
 *
 * How it was chosen (fitted 2026-10-19; PENDING the developer's approval): every one of the 370
 * geocoded street points was labelled with its OSM suburb (Nominatim reverse, addressdetails):
 * - `ramat`: suburbs "רמת בית שמש א/ב/ג/ד/ה", "רמת אברהם", "נוה שמיר";
 * - `old`: everything else: the old city (it has no suburb in OSM), the industrial zone "אזור
 *   תעשיה ברוש מערב", and the OSM polygon tagged "רמת בית שמש ב'" (with geresh). That polygon's
 *   quarters are old-city neighbourhoods (Sheinfeld/קרית אריה, הקריה החרדית/נחלה ומנוחה, גבעת
 *   שרת, נופי אביב, רמת משה), so the tag is taken as over-broad; the real RBS ב is קרית הרמ"א.
 * Of all lines with the fewest disagreements (4 of 370), this one keeps the most clearance to the
 * nearest street, about 86 m. The 4 disagreements: בית ג'מאל (a monastery, no suburb) comes out
 * `ramat`; 453 דובר שלום, 454 רבי פנחס בן יאיר and 455 אוהל יהושע (the north edge of קרית הרמ"א,
 * mixed in with Sheinfeld) come out `old`.
 *
 * A wrong region is not final: Yoel can change any order's region (spec §3.5), and a street that
 * keeps coming out wrong is fixed by hand in streets.json. Changing the line does not touch the
 * file by itself: run `npx tsx scripts/geocode-streets.ts --regions` to recompute every street's
 * region (that overwrites hand fixes, so redo them after).
 */
export const REGION_DIVIDER: { west: LatLng; east: LatLng } = {
  west: { lat: 31.726, lng: 34.942 },
  east: { lat: 31.7405, lng: 35.032 },
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
 * Abbreviated first words of the official list and the word OSM spells out instead (probed:
 * Nominatim finds nothing for "סמ האלון" or "שד נהר הדן", but finds "סמטת האלון" and "שדרות נהר
 * הדן"). The key is the abbreviation without its geresh; it matches only as the whole first word,
 * with or without a geresh (`שד`, `שד'`, `שד׳`), so "סמדר", "שדרות …" or "גבעת שד" stay as they
 * are. A new abbreviation is one more line.
 */
const LEADING_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['סמ', 'סמטת'],
  ['שד', 'שדרות'],
]);

/** Every geresh and gershayim as names write them: ASCII ' " `, Hebrew ׳ ״, typographic ‘ ’ “ ”. */
const GERESH_AND_GERSHAYIM = /['"`׳״‘’“”]/gu;

/** One geresh closing a word, in the same spellings: the mark of an abbreviation such as `שד'`. */
const TRAILING_GERESH = /['`׳‘’]$/u;

/** First word and rest of a name of two or more words; no match for a single word. */
const FIRST_WORD_AND_REST = /^(\S+)\s+(.+)$/u;

/** The name with every geresh and gershayim removed. */
function withoutGershayim(text: string): string {
  return text.replace(GERESH_AND_GERSHAYIM, '');
}

/**
 * The spellings of an official street name to search Nominatim for, in the order to try them,
 * without duplicates; the first is always the official name itself.
 *
 * The official list abbreviates where OSM spells out, so a name Nominatim does not find as
 * written may be found:
 * - with its abbreviated first word spelled out (LEADING_ABBREVIATIONS): `שד' האמוראים` →
 *   `שדרות האמוראים`;
 * - with geresh and gershayim removed: `רשב"י` → `רשבי` (Nominatim finds neither `רשב"י` nor
 *   `רשב״י`, but finds `רשבי`).
 *
 * Order: the official name first, because it is OSM's name for most streets, and a street it finds
 * costs one request. Then the name with its abbreviated first word spelled out, then the official
 * and the spelled-out name with the marks removed. Spelling out the abbreviation changes only the
 * one word OSM writes in full, while removing marks changes the name itself, so the spelling
 * closer to the official name is tried first.
 *
 * When the first word is an abbreviation, the marks are removed only from the rest of the name:
 * the abbreviation's own geresh (`שד'`) is kept or replaced by the full word, never just dropped,
 * since `שד האמוראים` would be one more abbreviation OSM does not use, a request with no new
 * chance. Examples:
 * - `סמ ויצ"ו` → `סמ ויצ"ו`, `סמטת ויצ"ו`, `סמ ויצו`, `סמטת ויצו`;
 * - `שד' האמוראים` → `שד' האמוראים`, `שדרות האמוראים`;
 * - `רשב"י` → `רשב"י`, `רשבי`;
 * - `הרצל` → `הרצל`.
 */
export function streetNameVariants(name: string): string[] {
  const words = FIRST_WORD_AND_REST.exec(name);
  const firstWord = words?.[1] ?? '';
  const rest = words?.[2] ?? '';
  const expansion = LEADING_ABBREVIATIONS.get(firstWord.replace(TRAILING_GERESH, ''));
  const spellings =
    expansion === undefined
      ? [name, withoutGershayim(name)]
      : [
          name,
          `${expansion} ${rest}`,
          `${firstWord} ${withoutGershayim(rest)}`,
          `${expansion} ${withoutGershayim(rest)}`,
        ];
  return [...new Set(spellings)];
}

/**
 * The Nominatim queries for one street, in the order to try them:
 * 1. one structured `street=<spelling>&city=בית שמש` per spelling of streetNameVariants, in its
 *    order (official name first); a structured query returns the street (highway) object itself;
 * 2. last, one free-form `q=<official name>, בית שמש`, which also finds names in the list that are
 *    neighbourhoods or places rather than streets ("שכ …", "גבעת …"). One is enough: the spellings
 *    are for streets, and the structured queries have tried them all.
 * geocodeStreets stops at the first query that finds a point, so a street OSM has under its
 * official name still costs a single request.
 */
export function nominatimSearchUrls(streetName: string): URL[] {
  const structured = streetNameVariants(streetName).map((spelling) => {
    const url = nominatimBaseUrl();
    url.searchParams.set('street', spelling);
    url.searchParams.set('city', CITY_NAME);
    return url;
  });
  const freeForm = nominatimBaseUrl();
  freeForm.searchParams.set('q', `${streetName}, ${CITY_NAME}`);
  return [...structured, freeForm];
}

// jsonv2 search results: coordinates are strings. category/type are the main OSM tag
// (`highway`/`residential`, `boundary`/`administrative`, `place`/`town` …) and addresstype is the
// address part the object stands for (`road`, `suburb`, `town` …); all three are optional so an
// answer without them still parses. Other fields are not used.
const nominatimResultSchema = z.looseObject({
  lat: z.string(),
  lon: z.string(),
  category: z.string().optional(),
  type: z.string().optional(),
  addresstype: z.string().optional(),
});
const nominatimResultsSchema = z.array(nominatimResultSchema);

/** OSM place / address types that mean the whole locality rather than a place inside it. */
const LOCALITY_TYPES: ReadonlySet<string> = new Set(['city', 'town']);

/**
 * Whether a result is the city itself rather than a place inside it: a `place=city|town` node, or
 * anything whose address type is the city or town (the town's boundary relation has
 * `addresstype: 'town'`). Its point is the town's centroid (31.74621, 34.98868 for Beit Shemesh),
 * which the free-form fallback returns for names it cannot place ("ש 160"). A centroid is not a
 * stop: Yoel would be sent to the middle of town, so such a street is better left without a point,
 * to fill by hand. Other boundaries are kept on purpose: OSM maps some neighbourhoods as boundary
 * polygons (`addresstype: 'suburb'` / `'neighbourhood'`), and their centre is a fair stop point.
 */
function isTheLocalityItself(result: z.infer<typeof nominatimResultSchema>): boolean {
  if (result.category === 'place' && LOCALITY_TYPES.has(result.type ?? '')) return true;
  return LOCALITY_TYPES.has(result.addresstype ?? '');
}

/** Rounds to 5 decimals (≈1 m): a street-level point needs no more, and the file stays short. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * The point of the first search result inside `bbox`, rounded to 5 decimals, or undefined when
 * no result qualifies. Skipped: results with unparseable coordinates, and results that are the
 * city itself rather than a place inside it (isTheLocalityItself: its centroid is not a stop).
 * Throws when the answer is not a result list (Nominatim reports errors as an object such as
 * `{ error: … }`).
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
    if (isTheLocalityItself(result)) continue;
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
 * found is saved at once. Also skipped, with no request and a log line: an entry named exactly
 * CITY_NAME ("בית שמש", code 9000 in the official list), which is the locality itself, not a
 * street; any point found for it would be the town's centroid, not a stop.
 *
 * Any other street without a point (not found last time, or not tried yet) is tried again on
 * every run, which also picks up fixes made in OSM since (and new spellings added to
 * streetNameVariants). Per street the queries of nominatimSearchUrls (each spelling of the name,
 * then the free-form fallback) are tried in order until one finds a point inside the city, and no
 * further query is sent for that street. The street keeps its official name whichever spelling
 * found it. A street that none finds is logged and stays without point and region (fill it by
 * hand, ADR-0005).
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
    if (street.name.trim() === CITY_NAME) {
      deps.log(`skipped: ${label}: the locality itself, not a street`);
      continue;
    }

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

/** Latitude, then longitude, separated by a comma, spaces, or both: "31.71379, 35.00338". */
const LAT_LNG_TEXT = /^\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)\s*$/u;

/**
 * A point typed by hand: latitude first, as openstreetmap.org shows it (right-click → "Show
 * address" puts "31.71379, 35.00338" in the search box). Throws on anything else, and on a point
 * outside the city: that also catches lat and lng typed the wrong way round, since 34.99,31.71
 * is nowhere near Beit Shemesh.
 */
export function parsePointText(
  text: string,
  bbox: typeof BEIT_SHEMESH_BBOX = BEIT_SHEMESH_BBOX,
): LatLng {
  const match = LAT_LNG_TEXT.exec(text);
  if (match === null) {
    throw new Error(`"${text}" is not "<lat>,<lng>" (for example 31.71379,35.00338)`);
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  const insideCity = lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  if (!insideCity) {
    throw new Error(
      `${lat},${lng} is outside Beit Shemesh (lat ${bbox.south}..${bbox.north}, lng ` +
        `${bbox.west}..${bbox.east}); latitude comes first`,
    );
  }
  return { lat: roundCoordinate(lat), lng: roundCoordinate(lng) };
}

/**
 * The file with the point of street `code` set by hand (ADR-0005: a street Nominatim does not
 * find is filled from openstreetmap.org), and its region computed from that point. Replaces a
 * point the street already had. Throws when no street has `code`. Never mutates `file`.
 */
export function setStreetPoint(file: StreetsFile, code: number, point: LatLng): StreetsFile {
  const index = file.streets.findIndex((street) => street.code === code);
  const street = file.streets[index];
  if (street === undefined) throw new Error(`no street has code ${code}`);
  const streets = [...file.streets];
  streets[index] = withPoint(street, point);
  return { ...file, streets };
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
  '  npx tsx scripts/geocode-streets.ts --point <code> <lat>,<lng>',
  '      set the point of one street by hand, e.g. --point 331 31.71379,35.00338',
  '      (no network; the region follows from the point)',
].join('\n');

type Mode =
  'geocode' | 'refresh-list' | 'regions' | 'help' | { point: { code: number; text: string } };

/** A street code as typed on the command line: a positive whole number. */
const CODE_TEXT = /^[1-9]\d*$/u;

/** The mode the arguments ask for; undefined for anything unknown. */
function parseMode(argv: readonly string[]): Mode | undefined {
  if (argv.length === 0) return 'geocode';
  // --point <code> <lat>,<lng>; "<lat>, <lng>" pasted with a space arrives as two arguments.
  if (argv[0] === '--point') {
    const [, code, ...pointParts] = argv;
    if (code === undefined || !CODE_TEXT.test(code) || pointParts.length === 0) return undefined;
    return { point: { code: Number(code), text: pointParts.join(' ') } };
  }
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

  if (typeof mode === 'object') {
    const { code, text } = mode.point;
    try {
      const updated = setStreetPoint(file, code, parsePointText(text));
      await save(updated);
      const street = file.streets.find((candidate) => candidate.code === code);
      log(`set: ${code} "${street?.name ?? ''}" ${street?.lat},${street?.lng} (${street?.region})`);
      log(`${file.streets.filter((other) => !hasPoint(other)).length} streets still have no point`);
    } catch (error) {
      log(`could not set the point: ${errorMessage(error)}`);
      log('the streets file was not changed.');
      return 1;
    }
    return 0;
  }

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
