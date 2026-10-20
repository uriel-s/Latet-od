// The value a StreetPicker holds (spec §3.1, ADR-0005). The booking form turns it into the
// request's `streetCode` / `streetName`; Yoel's "רחוב קרוב" picker reuses it later (section 6).

/**
 * What a StreetPicker holds: a street from the official list, or a name typed by hand
 * ("הרחוב שלי לא ברשימה"). `null` where it is used means nothing chosen yet.
 *
 * - `listed`: `code` is the official street code (what an order stores); `name` is the official
 *   name, kept for display only (the api takes the name from the code).
 * - `freeText`: the street as the customer wrote it; the order gets no region until Yoel assigns
 *   one.
 */
export type StreetChoice =
  { kind: 'listed'; code: number; name: string } | { kind: 'freeText'; name: string };
