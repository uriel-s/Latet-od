import { describe, expect, it } from 'vitest';
import { pointForAddress, regionForAddress, type StreetLookup } from './location.ts';
import { STREETS, type Street } from './streets.ts';

// Fixed streets, so the tests do not change when the real list is geocoded again.
const OLD_STREET: Street = { code: 1, name: 'הרצל', region: 'old', lat: 31.75, lng: 34.99 };
const RAMAT_STREET: Street = { code: 2, name: 'נחל דולב', region: 'ramat', lat: 31.71, lng: 34.98 };
/** Not found by Nominatim: no point, no region. */
const BARE_STREET: Street = { code: 3, name: 'רחוב חדש' };
/** Region fixed by hand in the file, point still missing. */
const REGION_ONLY_STREET: Street = { code: 4, name: 'נחל שורק', region: 'ramat' };
const UNKNOWN_CODE = 999;

const FAKE_STREETS = new Map(
  [OLD_STREET, RAMAT_STREET, BARE_STREET, REGION_ONLY_STREET].map((street) => [
    street.code,
    street,
  ]),
);
const lookup: StreetLookup = (code) => FAKE_STREETS.get(code);

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

describe('regionForAddress', () => {
  it('takes the region of the street the customer picked', () => {
    expect(regionForAddress({ streetCode: OLD_STREET.code }, lookup)).toBe('old');
  });

  it('takes the region of the near street for a free-text street', () => {
    expect(regionForAddress({ nearStreetCode: RAMAT_STREET.code }, lookup)).toBe('ramat');
  });

  it('prefers the near street when both are set', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: RAMAT_STREET.code };
    expect(regionForAddress(address, lookup)).toBe('ramat');
  });

  it('falls back to the street when the near street code is not in the list', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: UNKNOWN_CODE };
    expect(regionForAddress(address, lookup)).toBe('old');
  });

  it('falls back to the street when the near street has no region', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: BARE_STREET.code };
    expect(regionForAddress(address, lookup)).toBe('old');
  });

  it('is undefined when neither street has a region', () => {
    expect(regionForAddress({ streetCode: BARE_STREET.code }, lookup)).toBeUndefined();
    expect(
      regionForAddress({ streetCode: BARE_STREET.code, nearStreetCode: UNKNOWN_CODE }, lookup),
    ).toBeUndefined();
    expect(regionForAddress({ streetCode: UNKNOWN_CODE }, lookup)).toBeUndefined();
  });

  it('is undefined for an address with no street code', () => {
    expect(regionForAddress({}, lookup)).toBeUndefined();
  });
});

describe('pointForAddress', () => {
  it('takes the point of the street the customer picked', () => {
    expect(pointForAddress({ streetCode: OLD_STREET.code }, lookup)).toEqual({
      lat: 31.75,
      lng: 34.99,
    });
  });

  it('takes the point of the near street for a free-text street', () => {
    expect(pointForAddress({ nearStreetCode: RAMAT_STREET.code }, lookup)).toEqual({
      lat: 31.71,
      lng: 34.98,
    });
  });

  it('prefers the near street when both are set', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: RAMAT_STREET.code };
    expect(pointForAddress(address, lookup)).toEqual({ lat: 31.71, lng: 34.98 });
  });

  it('falls back to the street when the near street code is not in the list', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: UNKNOWN_CODE };
    expect(pointForAddress(address, lookup)).toEqual({ lat: 31.75, lng: 34.99 });
  });

  it('takes the near street point when the street has none', () => {
    const address = { streetCode: BARE_STREET.code, nearStreetCode: RAMAT_STREET.code };
    expect(pointForAddress(address, lookup)).toEqual({ lat: 31.71, lng: 34.98 });
  });

  it('falls back to the street point when the near street has none', () => {
    const address = { streetCode: OLD_STREET.code, nearStreetCode: BARE_STREET.code };
    expect(pointForAddress(address, lookup)).toEqual({ lat: 31.75, lng: 34.99 });
  });

  it('falls back independently of the region', () => {
    // The near street gives the region but has no point, so the point comes from the street.
    const address = { streetCode: OLD_STREET.code, nearStreetCode: REGION_ONLY_STREET.code };
    expect(regionForAddress(address, lookup)).toBe('ramat');
    expect(pointForAddress(address, lookup)).toEqual({ lat: 31.75, lng: 34.99 });
  });

  it('is undefined when neither street has a point', () => {
    expect(pointForAddress({ streetCode: BARE_STREET.code }, lookup)).toBeUndefined();
    expect(
      pointForAddress(
        { streetCode: BARE_STREET.code, nearStreetCode: REGION_ONLY_STREET.code },
        lookup,
      ),
    ).toBeUndefined();
    expect(pointForAddress({ nearStreetCode: UNKNOWN_CODE }, lookup)).toBeUndefined();
  });

  it('is undefined for an address with no street code', () => {
    expect(pointForAddress({}, lookup)).toBeUndefined();
  });
});

describe('region and point from the real street list', () => {
  it('uses the region and point of a geocoded street by default', () => {
    const street = firstRealStreet(
      (candidate) => candidate.region !== undefined && candidate.lat !== undefined,
    );
    expect(regionForAddress({ streetCode: street.code })).toBe(street.region);
    expect(pointForAddress({ streetCode: street.code })).toEqual({
      lat: street.lat,
      lng: street.lng,
    });
  });

  it('has no point for a street Nominatim did not find', () => {
    const street = firstRealStreet((candidate) => candidate.lat === undefined);
    expect(pointForAddress({ streetCode: street.code })).toBeUndefined();
  });
});
