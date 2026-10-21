// Tests of the route's settings from env: ROUTE_START must be "lat,lng" near Beit Shemesh, and a
// bad value stops the startup with a message that names the variable but never repeats the value
// (it is Yoel's home). Every point here is a made-up round number near the drop-off, not anyone's
// home. The env is a plain object per test.
import { haversine, straightLineDistance } from '@bottlerun/shared';
import { describe, expect, it } from 'vitest';
import { DROP_OFF } from '../config.ts';
import { MAX_START_DISTANCE_METERS, parseRouteStart, routeDepsFromEnv } from './routeConfig.ts';

/** The message `action` throws; fails the test if it does not throw an Error. */
function startupError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('expected a startup error');
}

describe('parseRouteStart', () => {
  it.each([
    ['without spaces', '31.7,35.0', { lat: 31.7, lng: 35 }],
    ['with a space after the comma', '31.7, 35.0', { lat: 31.7, lng: 35 }],
    ['with spaces around the comma and the value', ' 31.7 , 35.0 ', { lat: 31.7, lng: 35 }],
    ['an integer longitude', '31.7, 35', { lat: 31.7, lng: 35 }],
    ['an explicit + sign', '+31.75,+35.0', { lat: 31.75, lng: 35 }],
  ])('accepts "lat,lng" %s', (_label, value, point) => {
    expect(parseRouteStart(value)).toEqual(point);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('refuses to start when ROUTE_START is %s', (_label, value) => {
    const message = startupError(() => parseRouteStart(value));

    expect(message).toMatch(/^ROUTE_START is not set/u);
    expect(message).toContain('latitude first');
    expect(message).toContain('apps/api/.env (see .env.example) or in the hosting env');
  });

  it.each([
    ['one number', '31.7'],
    ['three numbers', '31.7,35.0,1'],
    ['words', 'my home'],
    ['a semicolon', '31.7;35.0'],
    ['trailing junk', '31.7,35.0x'],
    ['an empty longitude', '31.7,'],
    ['only spaces', '   '],
  ])('refuses %s, without repeating the value', (_label, value) => {
    const message = startupError(() => parseRouteStart(value));

    expect(message).toMatch(/^ROUTE_START is not two numbers/u);
    expect(message).toContain('latitude first');
    expect(message).toContain('apps/api/.env (see .env.example) or in the hosting env');
    expect(message).not.toContain(value);
  });

  it.each([
    ['a latitude above 90', '91.5,35.0'],
    ['a latitude below -90', '-91.5,35.0'],
    ['a longitude above 180', '31.7,181.5'],
  ])('refuses %s', (_label, value) => {
    const message = startupError(() => parseRouteStart(value));

    expect(message).toMatch(/^ROUTE_START is out of range/u);
    expect(message).not.toContain(value);
  });

  it('refuses swapped latitude and longitude as too far from the drop-off', () => {
    const message = startupError(() => parseRouteStart('35.0,31.7'));

    expect(message).toMatch(/^ROUTE_START is more than 30 km from the drop-off point/u);
    expect(message).toContain('latitude comes first');
    expect(message).not.toContain('35.0');
    expect(message).not.toContain('31.7');
  });

  it('refuses a valid point outside Beit Shemesh', () => {
    // Roughly Tel Aviv: a real place, but not where the routes start.
    expect(startupError(() => parseRouteStart('32.1,34.8'))).toMatch(/^ROUTE_START is more than/u);
  });

  it('accepts a point just inside the limit and refuses one just outside it', () => {
    // Due north of the drop-off: one degree of latitude is about 111 km.
    const metersPerDegree = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    const inside = DROP_OFF.point.lat + (MAX_START_DISTANCE_METERS - 100) / metersPerDegree;
    const outside = DROP_OFF.point.lat + (MAX_START_DISTANCE_METERS + 100) / metersPerDegree;

    expect(parseRouteStart(`${inside},${DROP_OFF.point.lng}`).lat).toBeCloseTo(inside, 6);
    expect(startupError(() => parseRouteStart(`${outside},${DROP_OFF.point.lng}`))).toMatch(
      /^ROUTE_START is more than/u,
    );
  });
});

describe('routeDepsFromEnv', () => {
  it('builds the start point and straight-line distances from env', () => {
    const route = routeDepsFromEnv({ ROUTE_START: '31.7,35.0' });

    expect(route.start).toEqual({ lat: 31.7, lng: 35 });
    expect(route.distance).toBe(straightLineDistance);
  });

  it('refuses to start without ROUTE_START', () => {
    expect(startupError(() => routeDepsFromEnv({}))).toMatch(/^ROUTE_START is not set/u);
  });
});
