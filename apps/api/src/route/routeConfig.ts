// The route planning's settings from env (ADR-0005): ROUTE_START is where every route begins,
// Yoel's home. Both entry points call routeDepsFromEnv once at startup through depsFromEnv
// (envDeps.ts), so a missing or wrong start point stops the startup instead of planning every
// round from the wrong place. The value is private: no error message ever repeats it.
import { haversine, straightLineDistance, type GeoPoint } from '@bottlerun/shared';
import { DROP_OFF } from '../config.ts';
import type { RouteDeps } from '../deps.ts';

/** Where the error messages point for the full list of variables. */
const ENV_HINT = 'Set it in apps/api/.env (see .env.example) or in the hosting env.';

/** What ROUTE_START looks like, quoted in its error messages. Never a real point. */
const ROUTE_START_FORMAT =
  '"lat,lng" in decimal degrees, latitude first, e.g. "<lat>,<lng>" of a point in Beit Shemesh';

/**
 * How far ROUTE_START may be from the drop-off point. Beit Shemesh is a few kilometres across, so
 * anything farther is a mistake: usually latitude and longitude swapped (which lands hundreds of
 * kilometres away), or a point copied from the wrong place.
 */
export const MAX_START_DISTANCE_METERS = 30_000;

/**
 * Two decimal numbers separated by a comma, with optional spaces around it and an optional sign:
 * `31.7,35.0`, `31.7, 35`, `-12.5 , +40`. No exponent, no other separator, nothing after.
 */
const LAT_LNG = /^\s*(?<lat>[+-]?\d+(?:\.\d+)?)\s*,\s*(?<lng>[+-]?\d+(?:\.\d+)?)\s*$/u;

/**
 * The route's start point from `ROUTE_START`, Yoel's home (private: env only, never in code).
 *
 * Accepts `"lat,lng"` in decimal degrees, latitude first. Refuses a missing or empty value,
 * anything that is not exactly two numbers, a latitude outside ±90 or a longitude outside ±180,
 * and a point more than {@link MAX_START_DISTANCE_METERS} from the drop-off ({@link DROP_OFF}),
 * which catches swapped latitude and longitude.
 *
 * @throws Error naming ROUTE_START, what is wrong and how to fix it. The value is never repeated:
 *   it is a home address, and the message is printed or logged.
 */
export function parseRouteStart(value: string | undefined): GeoPoint {
  if (!value) {
    throw new Error(
      `ROUTE_START is not set: it is where every route starts (Yoel's home), ` +
        `${ROUTE_START_FORMAT}. ${ENV_HINT}`,
    );
  }
  const groups = LAT_LNG.exec(value)?.groups;
  if (!groups?.lat || !groups.lng) {
    throw new Error(`ROUTE_START is not two numbers: use ${ROUTE_START_FORMAT}. ${ENV_HINT}`);
  }
  const point: GeoPoint = { lat: Number(groups.lat), lng: Number(groups.lng) };
  if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    throw new Error(
      `ROUTE_START is out of range: the latitude must be within ±90 and the longitude within ` +
        `±180. Use ${ROUTE_START_FORMAT}. ${ENV_HINT}`,
    );
  }
  if (haversine(point, DROP_OFF.point) > MAX_START_DISTANCE_METERS) {
    throw new Error(
      `ROUTE_START is more than ${MAX_START_DISTANCE_METERS / 1000} km from the drop-off point: ` +
        `check that the latitude comes first, ${ROUTE_START_FORMAT}. ${ENV_HINT}`,
    );
  }
  return point;
}

/**
 * The {@link RouteDeps} described by `env` (normally `process.env`): the start point from
 * `ROUTE_START` ({@link parseRouteStart}) and straight-line distances (ADR-0005; a road-distance
 * DistanceMatrix can replace it later without touching the planner).
 *
 * @throws Error when ROUTE_START is missing or bad; the message names it, never its value.
 */
export function routeDepsFromEnv(env: NodeJS.ProcessEnv): RouteDeps {
  return { start: parseRouteStart(env.ROUTE_START), distance: straightLineDistance };
}
