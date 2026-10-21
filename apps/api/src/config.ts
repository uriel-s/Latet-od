// Fixed settings of the api, in code because there is no settings screen (ADR-0005). They stay on
// the server: the browser never needs them. The route's start point (Yoel's home) is NOT here: it
// is private and comes from ROUTE_START in env (route/routeConfig.ts).
import { DROP_OFF_ADDRESS, type GeoPoint } from '@bottlerun/shared';

/** Where the bottles are unloaded at the end of every route (נקודת פריקה, spec §3.6). */
export interface DropOff {
  /** The address as Yoel would read it. */
  readonly address: string;
  /** Where the route ends, for ordering the stops. */
  readonly point: Readonly<GeoPoint>;
}

/**
 * The drop-off point, the last stop of every route: נחל נחשון 7.
 *
 * `point` is the street's point (code 417 in packages/shared/data/streets.json, from
 * OpenStreetMap), not the house's: accurate enough to order the stops, which is all a point is
 * used for (ADR-0005). If it ever puts the last stop in the wrong order, correct it here by hand.
 */
export const DROP_OFF = {
  address: DROP_OFF_ADDRESS, // shared: the browser builds navigation links to it (ADR-0007)
  point: { lat: 31.71402, lng: 34.99325 },
} as const satisfies DropOff;
