// One-off job that fills the English street names (`nameEn`) of packages/shared/data/streets.json
// for the English booking form: OpenStreetMap's `name:en` where OSM has one, else the
// transliteration every street already carries (transliterateStreetName, filled by
// geocode-streets.ts for new and renamed streets). The app never calls Overpass at runtime; it
// reads the committed file.
//
//   npx tsx scripts/english-street-names.ts            # one Overpass request, then write the file
//   npx tsx scripts/english-street-names.ts --help
//
// Overpass etiquette (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances):
//   - ONE request for the whole city (OVERPASS_QUERY), never one per street;
//   - an identifying User-Agent (OVERPASS_USER_AGENT);
//   - no retries: when the server is busy (429, 504), times out, or answers an error page, the job
//     skips OSM, keeps every street's current English name, and exits 0. Run it again later.
// Names taken from OSM are ODbL data, covered by the file's existing "© OpenStreetMap
// contributors" / ODbL header (the points already come from OSM).
//
// Last run (YYYY-MM-DD): N names from OSM, M from transliterateStreetName.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { streetsFileSchema, type StreetsFile } from '@bottlerun/shared';
import {
  STREETS_FILE,
  streetNameVariants,
  todayInJerusalem,
  writeStreetsFile,
} from './geocode-streets.ts';

/** The public Overpass instance the one request goes to. */
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Identifies this job to the Overpass operators, with where to find the project. */
export const OVERPASS_USER_AGENT =
  'BottleRun-english-street-names/1.0 (+https://github.com/uriel-s/bottlerun)';

/**
 * How long the client waits for the answer. Longer than the query's own `[timeout:60]`, so a slow
 * but successful answer is not cut off; past it, the job skips OSM.
 */
export const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Overpass area of the Beit Shemesh city boundary: OSM relation 1379449 (the same relation
 * BEIT_SHEMESH_BBOX in geocode-streets.ts comes from); an area id is 3600000000 + relation id.
 */
export const BEIT_SHEMESH_AREA_ID = 3_600_000_000 + 1_379_449;

/**
 * The one Overpass QL query: every named object inside the city that also has `name:en`, tags
 * only (no geometry, so the answer stays small). Streets are `highway` ways; the official list
 * also holds neighbourhoods ("גבעת שרת", "קרית אריה"), which OSM maps as `place` nodes/areas or
 * `landuse=residential` areas, hence the two `nwr` lines.
 */
export const OVERPASS_QUERY: string = [
  '[out:json][timeout:60];',
  `area(id:${BEIT_SHEMESH_AREA_ID})->.city;`,
  '(',
  '  way["highway"]["name"]["name:en"](area.city);',
  '  nwr["place"]["name"]["name:en"](area.city);',
  '  nwr["landuse"="residential"]["name"]["name:en"](area.city);',
  ');',
  'out tags;',
].join('\n');

/** One OSM object's Hebrew `name` and English `name:en`, both trimmed. */
export type OsmName = { name: string; nameEn: string };

// Only the fields we use; Overpass adds `version`, `osm3s`, `type`, `id` … which pass through.
// `remark` is how Overpass reports a runtime error (query timeout, out of memory) inside a 200.
const overpassResponseSchema = z.looseObject({
  remark: z.string().optional(),
  elements: z.array(
    z.looseObject({
      tags: z
        .looseObject({ name: z.string().optional(), 'name:en': z.string().optional() })
        .optional(),
    }),
  ),
});

/** A letter of any script other than Latin (Hebrew, Arabic, Cyrillic …). */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * Whether a `name:en` value is usable as an English name: at least one Latin letter and no letter
 * of another script. Mappers sometimes copy the Hebrew name into `name:en`, or mix both.
 */
function isLatinName(text: string): boolean {
  return LATIN_LETTER.test(text) && !NON_LATIN_LETTER.test(text);
}

/**
 * The name pairs of an Overpass JSON answer. Elements without both `name` and `name:en`, and
 * `name:en` values that are not Latin script (isLatinName), are dropped. Throws when the answer is
 * not Overpass JSON or carries a `remark` (a server-side error: the elements may be incomplete).
 */
export function parseOverpassResponse(json: unknown): OsmName[] {
  const answer = overpassResponseSchema.parse(json);
  if (answer.remark !== undefined) throw new Error(`Overpass reported: ${answer.remark}`);
  const names: OsmName[] = [];
  for (const { tags } of answer.elements) {
    const name = tags?.name?.trim() ?? '';
    const nameEn = tags?.['name:en']?.trim() ?? '';
    if (name === '' || nameEn === '' || !isLatinName(nameEn)) continue;
    names.push({ name, nameEn });
  }
  return names;
}

/** The part of fetch the job uses. globalThis.fetch fits, and tests pass a fake. */
export type OverpassFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Why a request failed, in words for the log; also covers a rejected fetch. */
function describeError(error: unknown): string {
  // AbortSignal.timeout rejects the fetch (or the body read) with a DOMException TimeoutError.
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
 * Sends the one Overpass request (OVERPASS_QUERY, POST form body, OVERPASS_USER_AGENT,
 * REQUEST_TIMEOUT_MS) and resolves with the parsed name pairs. Never rejects and never retries:
 * when Overpass is busy or unavailable (non-2xx such as 429 or 504, a timeout, a network error,
 * or a body that is not Overpass JSON, such as an HTML error page) it logs why and resolves with
 * undefined, and the caller carries on without OSM.
 */
export async function fetchOsmEnglishNames(deps: {
  fetch: OverpassFetch;
  log: (line: string) => void;
}): Promise<OsmName[] | undefined> {
  const skip = (reason: string): undefined => {
    deps.log(`OSM skipped: ${reason}; every street keeps its current English name`);
    return undefined;
  };
  let text: string;
  try {
    const response = await deps.fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': OVERPASS_USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ data: OVERPASS_QUERY }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return skip(`Overpass answered HTTP ${response.status}`);
    // Inside the try: the timeout also aborts a slow body.
    text = await response.text();
  } catch (error) {
    return skip(`Overpass request failed: ${describeError(error)}`);
  }
  try {
    return parseOverpassResponse(JSON.parse(text));
  } catch (error) {
    const detail = error instanceof SyntaxError ? 'the body is not JSON' : describeError(error);
    return skip(`Overpass gave no usable answer: ${detail.slice(0, 200)}`);
  }
}

/** The official entry that is the locality itself (code 9000), not a street: never matched. */
const CITY_NAME = 'בית שמש';

/** Trimmed, runs of whitespace as one space: the form names are compared in. */
function normalizeSpaces(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

/**
 * The keys a Hebrew name is matched by. `exact`: every spelling from streetNameVariants
 * (abbreviation spelled out, geresh/gershayim removed). `words`: the same spellings with their
 * words sorted, so the official list's surname-first "דרך רבין יצחק" meets OSM's "דרך יצחק רבין".
 */
function matchKeys(name: string): { exact: string[]; words: string[] } {
  const exact = streetNameVariants(normalizeSpaces(name)).map(normalizeSpaces);
  const words = exact.map((spelling) => spelling.split(' ').sort().join(' '));
  return { exact: [...new Set(exact)], words: [...new Set(words)] };
}

/** The most frequent value; a tie goes to the alphabetically first, so the result is stable. */
function mostFrequent(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(
    ([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1),
  )[0]?.[0];
}

/**
 * A matcher from an official Hebrew street name to OSM's English name, or undefined when OSM has
 * none for it. Both sides are expanded with streetNameVariants, so any spelling of the official
 * name equal to any spelling of the OSM name matches (`סמ האלון` = `סמטת האלון`, `רשב"י` =
 * `רשבי`). Only when no spelling matches exactly, the sorted words are compared (surname first).
 * When the matching OSM objects disagree (a street is several ways, mapped by different people),
 * the most frequent `name:en` wins, ties alphabetically. The entry named exactly "בית שמש" (the
 * locality, code 9000) never matches: an OSM street of that name is not the city.
 */
export function englishNameMatcher(
  osmNames: readonly OsmName[],
): (name: string) => string | undefined {
  const byExact = new Map<string, number[]>();
  const byWords = new Map<string, number[]>();
  const index = (map: Map<string, number[]>, key: string, element: number): void => {
    map.set(key, [...(map.get(key) ?? []), element]);
  };
  osmNames.forEach((osm, element) => {
    const keys = matchKeys(osm.name);
    keys.exact.forEach((key) => index(byExact, key, element));
    keys.words.forEach((key) => index(byWords, key, element));
  });
  // Set: one OSM object counts once even when two spellings of the official name reach it.
  const lookup = (map: Map<string, number[]>, keys: readonly string[]): string[] =>
    [...new Set(keys.flatMap((key) => map.get(key) ?? []))].map(
      (element) => osmNames[element]?.nameEn ?? '',
    );

  return (name) => {
    if (normalizeSpaces(name) === CITY_NAME) return undefined;
    const keys = matchKeys(name);
    const exact = lookup(byExact, keys.exact);
    return mostFrequent(exact.length > 0 ? exact : lookup(byWords, keys.words));
  };
}

/** Appended once to the file's `source` header, which says where each part of the data is from. */
export const SOURCE_SENTENCE =
  'English names: OpenStreetMap name:en via Overpass where present, else transliteration ' +
  '(scripts/english-street-names.ts).';

/** What applyEnglishNames did, for the log. */
export type EnglishNamesResult = {
  file: StreetsFile;
  /** Streets whose `nameEn` is OSM's `name:en`. */
  fromOsm: number;
  /** Every other street: it kept its current `nameEn` (a transliteration, or a hand fix). */
  fromTransliteration: number;
  /** The streets that got their name from OSM, in file order. */
  osmStreets: { code: number; name: string; nameEn: string }[];
};

/**
 * The file with OSM's English name on every street OSM has one for (englishNameMatcher). Every
 * other street keeps its current `nameEn`: the schema requires one, and geocode-streets.ts fills
 * it with transliterateStreetName for every new or renamed street. Keeping it (rather than
 * transliterating again) means a run while Overpass is down (`osmNames` undefined) never
 * overwrites names that came from OSM before, nor hand fixes. `source` gains SOURCE_SENTENCE
 * once; `updatedAt` is left to the caller. Never mutates `file`.
 */
export function applyEnglishNames(
  file: StreetsFile,
  osmNames: readonly OsmName[] | undefined,
): EnglishNamesResult {
  const englishName = englishNameMatcher(osmNames ?? []);
  const osmStreets: EnglishNamesResult['osmStreets'] = [];
  const streets = file.streets.map((street) => {
    const nameEn = englishName(street.name);
    if (nameEn === undefined) return { ...street };
    osmStreets.push({ code: street.code, name: street.name, nameEn });
    return { ...street, nameEn };
  });
  const source = file.source.includes(SOURCE_SENTENCE)
    ? file.source
    : `${file.source.trimEnd()} ${SOURCE_SENTENCE}`;
  return {
    file: { ...file, source, streets },
    fromOsm: osmStreets.length,
    fromTransliteration: streets.length - osmStreets.length,
    osmStreets,
  };
}

/** What main needs from the outside world; tests override any of it. */
export type MainDeps = {
  fetch: OverpassFetch;
  log: (line: string) => void;
  /** Path of the streets file to read and write; tests pass a temp copy. */
  streetsFile: string;
  now: () => Date;
};

const defaultMainDeps: MainDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  log: (line) => console.log(line),
  streetsFile: STREETS_FILE,
  now: () => new Date(),
};

const USAGE = [
  'usage: npx tsx scripts/english-street-names.ts',
  '  one Overpass request for OSM name:en across Beit Shemesh; streets OSM names get that name,',
  '  the rest keep their current English name (a transliteration). Writes streets.json.',
].join('\n');

/**
 * The command line: see the usage at the top of this file. `argv` excludes node and the script;
 * `env` is unused (no secrets needed) but kept for the same shape as geocode-streets.ts.
 * Resolves with the exit code: 0 done (also when OSM was skipped: that is the planned fallback),
 * 1 the streets file could not be read or written, 2 bad arguments.
 */
export async function main(
  argv: readonly string[],
  _env: Record<string, string | undefined>,
  deps: Partial<MainDeps> = {},
): Promise<number> {
  const { fetch, log, streetsFile, now } = { ...defaultMainDeps, ...deps };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    log(USAGE);
    return 0;
  }
  if (argv.length > 0) {
    log(`unknown arguments: ${argv.join(' ')}`);
    log(USAGE);
    return 2;
  }

  let file: StreetsFile;
  try {
    file = streetsFileSchema.parse(JSON.parse(await fs.readFile(streetsFile, 'utf8')));
  } catch (error) {
    log(`cannot read ${streetsFile}: ${describeError(error)}`);
    return 1;
  }

  const osmNames = await fetchOsmEnglishNames({ fetch, log });
  if (osmNames !== undefined) log(`Overpass: ${osmNames.length} OSM objects with a Latin name:en`);
  const result = applyEnglishNames(file, osmNames);
  try {
    await writeStreetsFile(streetsFile, { ...result.file, updatedAt: todayInJerusalem(now()) });
  } catch (error) {
    log(`cannot write ${streetsFile}: ${describeError(error)}`);
    return 1;
  }

  result.osmStreets.forEach(({ code, name, nameEn }) => log(`  osm: ${code} ${name} -> ${nameEn}`));
  log(
    `summary: ${result.fromOsm} names from OSM, ${result.fromTransliteration} from ` +
      `transliteration (kept as they were)${osmNames === undefined ? '; OSM was skipped' : ''}`,
  );
  return 0;
}

// Run only when executed directly (`npx tsx scripts/english-street-names.ts`), never on import from
// a test. Compared case-insensitively: on Windows the drive letter's case can differ.
const thisFile = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
const invokedFile = path.resolve(process.argv[1] ?? '').toLowerCase();
if (thisFile === invokedFile) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
