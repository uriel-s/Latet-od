import { describe, expect, it } from 'vitest';
import streetsJson from '../data/streets.json' with { type: 'json' };
import {
  STREETS,
  STREETS_ATTRIBUTION,
  findStreet,
  searchStreets,
  streetSchema,
  streetsFileSchema,
  type Street,
  type StreetsFile,
} from './streets.ts';

/** A valid streets file with two streets; override any header key or the street list. */
function makeStreetsFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL',
    source: 'test',
    updatedAt: '2026-10-19',
    streets: [
      { code: 101, name: 'הרצל', region: 'old', lat: 31.75, lng: 34.99 },
      { code: 247, name: 'דרך רבין יצחק' },
    ],
    ...overrides,
  };
}

/** Codes of the streets `searchStreets` returns, in order. */
function searchCodes(query: string, streets?: readonly Street[]): number[] {
  return searchStreets(query, streets).map((street) => street.code);
}

describe('data/streets.json', () => {
  it('passes streetsFileSchema', () => {
    const file: StreetsFile = streetsFileSchema.parse(streetsJson);
    expect(file.streets).toHaveLength(461);
  });

  it('has unique street codes, sorted ascending', () => {
    const codes = STREETS.map((street) => street.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });

  it('exposes the OpenStreetMap credit for the footer', () => {
    expect(STREETS_ATTRIBUTION).toBe('© OpenStreetMap contributors');
  });
});

describe('streetSchema', () => {
  it('accepts a street with only code and name', () => {
    expect(streetSchema.safeParse({ code: 103, name: "ז'בוטינסקי" }).success).toBe(true);
  });

  it('accepts a street with a point and a region', () => {
    const street = { code: 101, name: 'הרצל', region: 'old', lat: 31.75, lng: 34.99 };
    expect(streetSchema.parse(street)).toEqual(street);
  });

  it('rejects lat without lng', () => {
    expect(streetSchema.safeParse({ code: 101, name: 'הרצל', lat: 31.75 }).success).toBe(false);
  });

  it('rejects lng without lat', () => {
    expect(streetSchema.safeParse({ code: 101, name: 'הרצל', lng: 34.99 }).success).toBe(false);
  });

  it('rejects an unknown key such as a "lon" typo', () => {
    const result = streetSchema.safeParse({ code: 101, name: 'הרצל', lat: 31.75, lon: 34.99 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown region', () => {
    expect(streetSchema.safeParse({ code: 101, name: 'הרצל', region: 'north' }).success).toBe(
      false,
    );
  });

  it('rejects an empty name', () => {
    expect(streetSchema.safeParse({ code: 101, name: '  ' }).success).toBe(false);
  });

  it('rejects a code that is not a positive integer', () => {
    expect(streetSchema.safeParse({ code: 0, name: 'הרצל' }).success).toBe(false);
    expect(streetSchema.safeParse({ code: 10.5, name: 'הרצל' }).success).toBe(false);
  });

  it('rejects a point outside the globe', () => {
    expect(streetSchema.safeParse({ code: 101, name: 'הרצל', lat: 91, lng: 34.99 }).success).toBe(
      false,
    );
  });
});

describe('streetsFileSchema', () => {
  it('accepts a valid file', () => {
    expect(streetsFileSchema.safeParse(makeStreetsFile()).success).toBe(true);
  });

  it('rejects duplicate street codes and names the code', () => {
    const result = streetsFileSchema.safeParse(
      makeStreetsFile({
        streets: [
          { code: 101, name: 'הרצל' },
          { code: 101, name: 'החלוצים' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('101');
  });

  it('rejects a wrong attribution', () => {
    const result = streetsFileSchema.safeParse(makeStreetsFile({ attribution: 'OpenStreetMap' }));
    expect(result.success).toBe(false);
  });

  it('rejects a license other than ODbL', () => {
    expect(streetsFileSchema.safeParse(makeStreetsFile({ license: 'MIT' })).success).toBe(false);
  });

  it('rejects an updatedAt that is not an ISO date', () => {
    expect(streetsFileSchema.safeParse(makeStreetsFile({ updatedAt: '19/10/2026' })).success).toBe(
      false,
    );
  });

  it('rejects an empty street list', () => {
    expect(streetsFileSchema.safeParse(makeStreetsFile({ streets: [] })).success).toBe(false);
  });

  it('rejects an unknown header key', () => {
    expect(streetsFileSchema.safeParse(makeStreetsFile({ version: 2 })).success).toBe(false);
  });
});

describe('findStreet', () => {
  it('returns the street for a known code', () => {
    // Only code and name: the point and region come from the geocoded data and may change
    // whenever the script runs again or the region line moves.
    expect(findStreet(103)).toMatchObject({ code: 103, name: "ז'בוטינסקי" });
  });

  it('returns undefined for an unknown code', () => {
    expect(findStreet(999_999)).toBeUndefined();
  });
});

describe('searchStreets', () => {
  it('finds a street by one word of its name', () => {
    expect(searchStreets('רבין').map((street) => street.name)).toEqual(['דרך רבין יצחק']);
  });

  it('finds a surname-first name when the words are typed in the usual order', () => {
    expect(searchCodes('יצחק רבין')).toEqual([247]);
  });

  it('finds a street by the start of a word', () => {
    expect(searchCodes('ביאל')).toEqual([123]);
  });

  it('matches a geresh typed as ASCII, as Hebrew ׳, as ’ or left out', () => {
    for (const query of ["ז'בוטינסקי", 'ז׳בוטינסקי', 'ז’בוטינסקי', 'זבוטינסקי']) {
      expect(searchCodes(query), query).toEqual([103]);
    }
  });

  it('matches gershayim typed as ASCII, as Hebrew ״, as ” or left out', () => {
    for (const query of ['רמב"ם', 'רמב״ם', 'רמב”ם', 'רמבם']) {
      expect(searchCodes(query), query).toEqual([140]);
    }
    for (const query of ['האדמו"ר מבעלזא', 'האדמו״ר מבעלזא', 'האדמור מבעלזא']) {
      expect(searchCodes(query), query).toEqual([502]);
    }
  });

  it('finds a name with gershayim when the customer types without them', () => {
    expect(searchCodes('שזר')).toEqual([6528]);
  });

  it('treats a hyphen like a space', () => {
    expect(searchCodes('אל-על')).toContain(409);
    expect(searchCodes('אל על')).toContain(409);
    expect(searchCodes('נחל אל על')).toEqual([409]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchStreets('רחוב שלא קיים')).toEqual([]);
  });

  it('returns an empty list for an empty, whitespace-only or punctuation-only query', () => {
    for (const query of ['', '   ', '\t', '-', '"', ' ׳ , . ']) {
      expect(searchStreets(query), JSON.stringify(query)).toEqual([]);
    }
  });

  it('lists names that start with the query first, then the rest, each in input order', () => {
    const streets: Street[] = [
      { code: 1, name: 'דרך רבין יצחק' },
      { code: 2, name: 'רביצקי' },
      { code: 3, name: 'הרב קוק' },
      { code: 4, name: 'רבי עקיבא' },
      { code: 5, name: 'שד רבי טרפון' },
    ];
    expect(searchCodes('רבי', streets)).toEqual([2, 4, 1, 5]);
  });

  it('counts a multi-word query as a start only when the name starts with those words', () => {
    const streets: Street[] = [
      { code: 1, name: 'גבעת נחל שורק' },
      { code: 2, name: 'נחל שורק' },
    ];
    expect(searchCodes('נחל ש', streets)).toEqual([2, 1]);
  });

  it('does not mutate the list it searches', () => {
    // The result reorders these two (starts-with first); the input must keep its order.
    const streets: readonly Street[] = Object.freeze([
      { code: 1, name: 'דרך רבין יצחק' },
      { code: 2, name: 'רביצקי' },
    ]);
    const result = searchStreets('רבי', streets);
    expect(result.map((street) => street.code)).toEqual([2, 1]);
    expect(streets.map((street) => street.code)).toEqual([1, 2]);
    expect(result).not.toBe(streets);
  });
});
