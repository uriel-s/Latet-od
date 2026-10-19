// An order's region and map point, derived from its street codes via the static street list
// (ADR-0005). Orders store no point: it is looked up when a route is built, so fixing a street's
// point in data/streets.json fixes every order on that street. The region is derived when an
// order is created or gets a near street, and the order keeps it so Yoel can still change it by
// hand (spec §3.5).
import { findStreet, type Region, type Street } from './streets.ts';

/** A point on the map (WGS84 degrees). Used only to order a round's stops, never to navigate. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * The two street codes of an order's address that decide its region and point. Defined here
 * structurally so any address shape that carries them can be passed.
 */
export interface AddressLocationKeys {
  /** Street the customer picked from the official list; absent for a free-text street. */
  streetCode?: number;
  /**
   * Street Yoel picked as "רחוב קרוב" for a free-text street (or one with no or a wrong point
   * in the list). One choice sets both region and point (ADR-0005).
   */
  nearStreetCode?: number;
}

/** Finds a street by its official code. Defaults to the real list; tests pass fixed streets. */
export type StreetLookup = (code: number) => Street | undefined;

/**
 * The address's streets, most trusted first. `nearStreetCode` is Yoel's explicit choice, so it
 * comes before the street the customer picked. Codes missing from the list are dropped.
 */
function streetsByPreference(address: AddressLocationKeys, lookup: StreetLookup): Street[] {
  const streets: Street[] = [];
  for (const code of [address.nearStreetCode, address.streetCode]) {
    const street = code === undefined ? undefined : lookup(code);
    if (street !== undefined) streets.push(street);
  }
  return streets;
}

/**
 * The region of an address: from `nearStreetCode` when it is set and that street has a region,
 * otherwise from `streetCode`. Region and point fall back independently (see
 * {@link pointForAddress}). Undefined when neither street gives one: the order is listed under
 * "בלי אזור" until Yoel assigns it.
 */
export function regionForAddress(
  address: AddressLocationKeys,
  lookup: StreetLookup = findStreet,
): Region | undefined {
  return streetsByPreference(address, lookup).find((street) => street.region !== undefined)?.region;
}

/**
 * The map point of an address, used to order a round's stops: from `nearStreetCode` when it is
 * set and that street has a point, otherwise from `streetCode`. Falls back independently of the
 * region, so a near street with a region but no point still takes its point from `streetCode`.
 * Undefined when neither street has a point: the stop goes last with the "בלי מיקום" tag.
 */
export function pointForAddress(
  address: AddressLocationKeys,
  lookup: StreetLookup = findStreet,
): GeoPoint | undefined {
  for (const street of streetsByPreference(address, lookup)) {
    // streetSchema guarantees lat and lng are both present or both absent.
    if (street.lat !== undefined && street.lng !== undefined) {
      return { lat: street.lat, lng: street.lng };
    }
  }
  return undefined;
}
