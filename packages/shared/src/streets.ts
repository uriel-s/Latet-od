// Beit Shemesh street list: the official codes + names from data.gov.il, with one OpenStreetMap
// point and a region per street (ADR-0005). The booking form's street picker searches it; the
// point and region decide an order's region and the stop order of a route. No network call at
// runtime: the list is a static file in the repo. The points come from OSM, so data/streets.json
// is a Derivative Database under ODbL and every page that uses it credits
// "© OpenStreetMap contributors".
import { z } from 'zod';
import streetsJson from '../data/streets.json' with { type: 'json' };

/**
 * Half of the city a round covers: `ramat` = רמת בית שמש, `old` = בית שמש הוותיקה.
 * Every round is in one region, so an order's region decides which rounds it can join.
 */
export const regionSchema = z.enum(['ramat', 'old']);
export type Region = z.infer<typeof regionSchema>;

/**
 * One street of the official list. Strict, so a typo in a hand edit of the file (`lon` for
 * `lng`) fails loudly instead of silently dropping the point.
 */
export const streetSchema = z
  .strictObject({
    /** Official street code (סמל רחוב), unique within the city. Orders store this, not the name. */
    code: z.int().positive(),
    /** Official Hebrew name, as written in the data.gov.il list. */
    name: z.string().trim().min(1),
    region: regionSchema.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  // Half a point is a hand-edit mistake; planRoute needs both or neither.
  .refine((street) => (street.lat === undefined) === (street.lng === undefined), {
    message: 'lat and lng must be both present or both absent',
    path: ['lat'],
  });

/**
 * A street. No point / no region means Nominatim did not find the street (or it has not been
 * geocoded yet): its stops get the "בלי מיקום" tag until the point is filled in by hand
 * (ADR-0005: right-click on openstreetmap.org). `region` is set by scripts/geocode-streets.ts
 * from the point; a wrong one is fixed by hand in the file.
 */
export type Street = z.infer<typeof streetSchema>;

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Shape of data/streets.json: an ODbL header, then the streets (the script sorts them by code). */
export const streetsFileSchema = z
  .strictObject({
    attribution: z.literal(OSM_ATTRIBUTION),
    license: z.literal('ODbL'),
    source: z.string().min(1),
    updatedAt: z.iso.date(),
    streets: z.array(streetSchema).min(1),
  })
  // Orders reference streets by code, so a duplicate would make findStreet ambiguous.
  .superRefine((file, ctx) => {
    const seen = new Set<number>();
    file.streets.forEach((street, index) => {
      if (seen.has(street.code)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate street code ${street.code}`,
          path: ['streets', index, 'code'],
        });
      }
      seen.add(street.code);
    });
  });
export type StreetsFile = z.infer<typeof streetsFileSchema>;

// Parsed once at module load: a broken file makes every import (and so every test) fail loudly,
// instead of a street silently missing from the picker.
const streetsFile = streetsFileSchema.parse(streetsJson);

/** Every street in the city, sorted by code. */
export const STREETS: readonly Street[] = streetsFile.streets;

/** Credit line the footer must show once street points are in use (ODbL, ADR-0005). */
export const STREETS_ATTRIBUTION: string = streetsFile.attribution;

const STREETS_BY_CODE: ReadonlyMap<number, Street> = new Map(
  STREETS.map((street) => [street.code, street]),
);

/** The street with this official code, or undefined if the code is not in the list. */
export function findStreet(code: number): Street | undefined {
  return STREETS_BY_CODE.get(code);
}

// Geresh / gershayim in every spelling: ASCII ' " and backtick, Hebrew ׳ ״, typographic ‘ ’ “ ”.
// They are removed, not turned into a space: customers type "זבוטינסקי", "ז'בוטינסקי" and
// "ז׳בוטינסקי" for the same street, and "רמבם" for רמב"ם.
const GERESH_MARKS = /['"`׳״‘’“”]/g;
// Any other non-letter, non-digit (space, hyphen, comma, period) separates words: "אל-על" = "אל על".
const WORD_SEPARATORS = /[^\p{L}\p{N}]+/u;

/** Lower-cased words of a name or query, with geresh marks removed. */
function toSearchWords(text: string): string[] {
  return text
    .replace(GERESH_MARKS, '')
    .toLowerCase()
    .split(WORD_SEPARATORS)
    .filter((word) => word !== '');
}

/**
 * Streets whose name matches what the customer typed, for the street picker.
 *
 * Matching is per word, in any order: every query word must be the start of some word of the
 * name. The official list writes some names surname-first ("דרך רבין יצחק"), so "רבין" and
 * "יצחק רבין" must both find it. An empty query (or only spaces / punctuation) returns no
 * streets: the picker stays empty until the customer types.
 *
 * Names that start with the query come first, then the rest; each group keeps the order of
 * `streets` (by code for the default list). Returns a new array and never mutates `streets`.
 */
export function searchStreets(query: string, streets: readonly Street[] = STREETS): Street[] {
  const queryWords = toSearchWords(query);
  if (queryWords.length === 0) return [];
  const queryPhrase = queryWords.join(' ');

  const startsWithQuery: Street[] = [];
  const containsQuery: Street[] = [];
  for (const street of streets) {
    const nameWords = toSearchWords(street.name);
    const matches = queryWords.every((queryWord) =>
      nameWords.some((nameWord) => nameWord.startsWith(queryWord)),
    );
    if (!matches) continue;
    if (nameWords.join(' ').startsWith(queryPhrase)) startsWithQuery.push(street);
    else containsQuery.push(street);
  }
  return [...startsWithQuery, ...containsQuery];
}
