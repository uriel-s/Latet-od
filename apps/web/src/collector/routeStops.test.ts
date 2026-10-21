import { describe, expect, it } from 'vitest';
import type { Address, MessageLink, RoundStopState, RouteStopView } from '@bottlerun/shared';
import { DROP_OFF_ADDRESS } from '@bottlerun/shared';
import {
  MAX_MAPS_WAYPOINTS,
  ROUTE_CITY,
  STOP_STATE_LABELS,
  dropOffWazeUrl,
  googleMapsRouteUrl,
  isStopHandled,
  keepThankYouRows,
  nextStopToCollect,
  screenOrderOfStops,
  stopAddressLines,
  storedMovesFor,
  telUrl,
  wazeUrl,
} from './routeStops.ts';

/** An address at a private house with no floorApt or note, overridable per test. */
function makeAddress(overrides: Partial<Address> = {}): Address {
  return {
    streetCode: 201,
    streetName: 'שד נהר הדן',
    houseNumber: '12',
    bottlesSpot: 'privateHouse',
    ...overrides,
  };
}

/** A to-collect stop of order `o1`, overridable per test; `id` sets the order's id. */
function makeStop(
  overrides: Partial<Omit<RouteStopView, 'order'>> & { id?: string } = {},
): RouteStopView {
  const { id = 'o1', ...stopOverrides } = overrides;
  return {
    order: {
      id,
      contact: { name: 'דנה כהן', phone: '+972501234567' },
      address: makeAddress(),
      bottlesEstimated: 40,
      status: 'confirmed',
      region: 'ramat',
      source: 'form',
      createdAt: new Date('2026-10-01T08:00:00Z'),
      hasLocation: true,
    },
    hasLocation: true,
    state: 'toCollect',
    ...stopOverrides,
  };
}

/** A "שלח תודה" row for order `orderId`, at message `messageIndex`. */
function makeThankYou(orderId: string, messageIndex = 1): MessageLink {
  return {
    orderId,
    messageIndex,
    kind: 'thankYou',
    name: 'דנה כהן',
    url: `https://wa.me/972501234567?text=${String(messageIndex)}`,
  };
}

/** A stop of order `id` on `streetName` number 7, in `state`. */
function stopOn(
  id: string,
  streetName: string,
  state: RoundStopState = 'toCollect',
): RouteStopView {
  const stop = makeStop({ id, state });
  return {
    ...stop,
    order: { ...stop.order, address: makeAddress({ streetName, houseNumber: '7' }) },
  };
}

/** The order ids of `stops`, in their order. */
function ids(stops: readonly RouteStopView[]): string[] {
  return stops.map((stop) => stop.order.id);
}

describe('wazeUrl', () => {
  it('searches the street, the number and the city, URL-encoded, and starts navigating', () => {
    const url = wazeUrl({ streetName: 'שד נהר הדן', houseNumber: '12' });
    expect(url).toBe(
      'https://waze.com/ul?q=%D7%A9%D7%93%20%D7%A0%D7%94%D7%A8%20%D7%94%D7%93%D7%9F%2012%2C%20' +
        '%D7%91%D7%99%D7%AA%20%D7%A9%D7%9E%D7%A9&navigate=yes',
    );
    const query = new URL(url).searchParams.get('q');
    expect(query).toBe('שד נהר הדן 12, בית שמש');
    expect(decodeURIComponent(url)).toBe(
      'https://waze.com/ul?q=שד נהר הדן 12, בית שמש&navigate=yes',
    );
  });

  it('adds Beit Shemesh as the city', () => {
    expect(ROUTE_CITY).toBe('בית שמש');
  });

  it('trims the street and the number', () => {
    expect(wazeUrl({ streetName: '  הרצל ', houseNumber: ' 12א ' })).toBe(
      `https://waze.com/ul?q=${encodeURIComponent('הרצל 12א, בית שמש')}&navigate=yes`,
    );
  });

  it('encodes characters that would break the query, like & and an apostrophe', () => {
    const url = wazeUrl({ streetName: "בית ג'מאל & co", houseNumber: '5' });
    expect(url).not.toContain('&co');
    expect(new URL(url).searchParams.get('q')).toBe("בית ג'מאל & co 5, בית שמש");
    expect(new URL(url).searchParams.get('navigate')).toBe('yes');
  });
});

describe('telUrl', () => {
  it('dials the stored E.164 phone, keeping the +', () => {
    expect(telUrl('+972501234567')).toBe('tel:+972501234567');
  });
});

describe('stopAddressLines', () => {
  it('has the street with the number and the spot in words, and no note', () => {
    expect(stopAddressLines(makeAddress())).toEqual({
      street: 'שד נהר הדן 12',
      spot: 'בכניסה לבית פרטי',
    });
  });

  it('joins the floor and apartment to the spot with " · "', () => {
    const address = makeAddress({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3, דירה 12' });
    expect(stopAddressLines(address).spot).toBe('בבניין - ליד דלת הדירה · קומה 3, דירה 12');
  });

  it('has the note when there is one, trimmed', () => {
    const address = makeAddress({ bottlesSpot: 'buildingEntrance', note: '  ליד העגלות ' });
    expect(stopAddressLines(address)).toEqual({
      street: 'שד נהר הדן 12',
      spot: 'למטה בכניסה לבניין',
      note: 'ליד העגלות',
    });
  });

  it('ignores an empty or blank floorApt and note', () => {
    const lines = stopAddressLines(makeAddress({ floorApt: '', note: '   ' }));
    expect(lines).toEqual({ street: 'שד נהר הדן 12', spot: 'בכניסה לבית פרטי' });
    expect('note' in lines).toBe(false);
  });
});

describe('isStopHandled', () => {
  it.each<[RoundStopState, boolean]>([
    ['toCollect', false],
    ['collected', true],
    ['notFound', true],
    ['cancelled', true],
    ['left', true],
  ])('says %s is handled: %s', (state, handled) => {
    expect(isStopHandled(state)).toBe(handled);
  });
});

describe('STOP_STATE_LABELS', () => {
  it('names every handled state in words', () => {
    expect(STOP_STATE_LABELS).toEqual({
      collected: 'נאסף',
      notFound: 'לא נמצא',
      cancelled: 'בוטלה',
      left: 'יצאה מהסבב',
    });
  });
});

describe('screenOrderOfStops', () => {
  it('keeps a route with nothing handled as it is', () => {
    const stops = [makeStop({ id: 'a' }), makeStop({ id: 'b' }), makeStop({ id: 'c' })];
    expect(ids(screenOrderOfStops(stops))).toEqual(['a', 'b', 'c']);
  });

  it('puts the handled stops last, each group in route order', () => {
    const stops = [
      makeStop({ id: 'h1', state: 'collected' }),
      makeStop({ id: 'a' }),
      makeStop({ id: 'h2', state: 'notFound' }),
      makeStop({ id: 'b' }),
      makeStop({ id: 'h3', state: 'left' }),
      makeStop({ id: 'c' }),
      makeStop({ id: 'h4', state: 'cancelled' }),
    ];
    expect(ids(screenOrderOfStops(stops))).toEqual(['a', 'b', 'c', 'h1', 'h2', 'h3', 'h4']);
  });

  it('does not change the list it is given', () => {
    const stops = [makeStop({ id: 'h', state: 'collected' }), makeStop({ id: 'a' })];
    screenOrderOfStops(stops);
    expect(ids(stops)).toEqual(['h', 'a']);
  });

  it('is empty for no stops', () => {
    expect(screenOrderOfStops([])).toEqual([]);
  });
});

describe('storedMovesFor', () => {
  const handled = makeStop({ id: 'h', state: 'collected' });
  /** Stored [b, handled, c]: on screen b, c, then the handled card. */
  const withHandledBetween = [makeStop({ id: 'b' }), handled, makeStop({ id: 'c' })];

  it('moves a stop one place when its neighbour is to collect', () => {
    const stops = [makeStop({ id: 'a' }), makeStop({ id: 'b' })];
    expect(storedMovesFor(stops, 'b', 'up')).toBe(1);
    expect(storedMovesFor(stops, 'a', 'down')).toBe(1);
  });

  it('moves a stop past the handled stops between it and its to-collect neighbour', () => {
    expect(storedMovesFor(withHandledBetween, 'c', 'up')).toBe(2);
    expect(storedMovesFor(withHandledBetween, 'b', 'down')).toBe(2);
  });

  it('counts every handled stop in between', () => {
    const stops = [
      makeStop({ id: 'a' }),
      makeStop({ id: 'h1', state: 'notFound' }),
      makeStop({ id: 'h2', state: 'left' }),
      makeStop({ id: 'h3', state: 'cancelled' }),
      makeStop({ id: 'b' }),
    ];
    expect(storedMovesFor(stops, 'b', 'up')).toBe(4);
    expect(storedMovesFor(stops, 'a', 'down')).toBe(4);
  });

  it('is 0 at the top or the bottom of the visible list', () => {
    expect(storedMovesFor(withHandledBetween, 'b', 'up')).toBe(0);
    expect(storedMovesFor(withHandledBetween, 'c', 'down')).toBe(0);
  });

  it('is 0 when only handled stops are that way', () => {
    const stops = [handled, makeStop({ id: 'a' }), makeStop({ id: 'h2', state: 'notFound' })];
    expect(storedMovesFor(stops, 'a', 'up')).toBe(0);
    expect(storedMovesFor(stops, 'a', 'down')).toBe(0);
  });

  it('is 0 for a handled stop', () => {
    expect(storedMovesFor(withHandledBetween, 'h', 'up')).toBe(0);
    expect(storedMovesFor(withHandledBetween, 'h', 'down')).toBe(0);
  });

  it('is 0 for an order that is not in the route', () => {
    expect(storedMovesFor(withHandledBetween, 'missing', 'up')).toBe(0);
    expect(storedMovesFor([], 'missing', 'down')).toBe(0);
  });
});

describe('keepThankYouRows', () => {
  it('keeps the thank-you a collected stop had when the new view lacks it', () => {
    const shown = makeThankYou('a');
    const previous = [makeStop({ id: 'a', state: 'collected', thankYou: shown })];
    const next = [makeStop({ id: 'a', state: 'collected' }), makeStop({ id: 'b' })];
    const kept = keepThankYouRows(previous, next);
    expect(kept[0]?.thankYou).toEqual(shown);
    expect(ids(kept)).toEqual(['a', 'b']);
  });

  it('does not add a thank-you to a stop that is no longer collected', () => {
    const previous = [makeStop({ id: 'a', state: 'collected', thankYou: makeThankYou('a') })];
    const next = [makeStop({ id: 'a', state: 'cancelled' })];
    expect(keepThankYouRows(previous, next)[0]?.thankYou).toBeUndefined();
  });

  it('lets the thank-you of the new view win', () => {
    const newer = makeThankYou('a', 2);
    const previous = [makeStop({ id: 'a', state: 'collected', thankYou: makeThankYou('a', 1) })];
    const next = [makeStop({ id: 'a', state: 'collected', thankYou: newer })];
    expect(keepThankYouRows(previous, next)[0]?.thankYou).toEqual(newer);
  });

  it('takes the thank-you of the same order only', () => {
    const previous = [makeStop({ id: 'a', state: 'collected', thankYou: makeThankYou('a') })];
    const next = [makeStop({ id: 'b', state: 'collected' })];
    expect(keepThankYouRows(previous, next)[0]?.thankYou).toBeUndefined();
  });

  it('leaves a collected stop without a thank-you anywhere as it is', () => {
    const next = [makeStop({ id: 'a', state: 'collected' })];
    const kept = keepThankYouRows([], next);
    expect(kept).toEqual(next);
    expect(kept[0] !== undefined && 'thankYou' in kept[0]).toBe(false);
  });
});

describe('nextStopToCollect', () => {
  it('is the first stop still to collect, in the stored order', () => {
    const stops = [stopOn('a', 'הרצל'), stopOn('b', 'הנביאים')];
    expect(nextStopToCollect(stops)?.order.id).toBe('a');
  });

  it('skips handled stops, wherever they sit', () => {
    const stops = [
      stopOn('a', 'הרצל', 'collected'),
      stopOn('b', 'הנביאים', 'notFound'),
      stopOn('c', 'הגפן'),
      stopOn('d', 'הזית'),
    ];
    expect(nextStopToCollect(stops)?.order.id).toBe('c');
  });

  it('is undefined when nothing is left to collect or there are no stops', () => {
    expect(nextStopToCollect([stopOn('a', 'הרצל', 'collected')])).toBeUndefined();
    expect(nextStopToCollect([])).toBeUndefined();
  });
});

describe('googleMapsRouteUrl', () => {
  /** The decoded places of a link: the stops, then the drop-off last. */
  function placesOf(url: string): string[] {
    const path = url.slice('https://www.google.com/maps/dir//'.length);
    return path.split('/').map(decodeURIComponent);
  }

  it('starts from the phone location and ends at the drop-off', () => {
    const url = googleMapsRouteUrl([stopOn('a', 'הרצל')]) ?? '';
    expect(url.startsWith('https://www.google.com/maps/dir//')).toBe(true);
    expect(placesOf(url).at(-1)).toBe(DROP_OFF_ADDRESS);
  });

  it('never has an origin, so the start stays private', () => {
    const url = googleMapsRouteUrl([stopOn('a', 'הרצל'), stopOn('b', 'הגפן')]) ?? '';
    expect(url).not.toContain('origin');
  });

  it('adds the city to every address and keeps the stored order', () => {
    const url = googleMapsRouteUrl([stopOn('a', 'הרצל'), stopOn('b', 'הגפן')]) ?? '';
    expect(placesOf(url)).toEqual(['הרצל 7, בית שמש', 'הגפן 7, בית שמש', DROP_OFF_ADDRESS]);
  });

  it('leaves out handled stops', () => {
    const url =
      googleMapsRouteUrl([
        stopOn('a', 'הרצל', 'collected'),
        stopOn('b', 'הגפן'),
        stopOn('c', 'הזית', 'cancelled'),
        stopOn('d', 'הנביאים'),
      ]) ?? '';
    expect(placesOf(url)).toEqual(['הגפן 7, בית שמש', 'הנביאים 7, בית שמש', DROP_OFF_ADDRESS]);
  });

  it('keeps only the first 9 stops still to collect', () => {
    const stops = Array.from({ length: 11 }, (_, i) => stopOn(`o${i}`, `רחוב${i}`));
    const stopsInLink = placesOf(googleMapsRouteUrl(stops) ?? '').slice(0, -1);
    expect(MAX_MAPS_WAYPOINTS).toBe(9);
    expect(stopsInLink).toHaveLength(9);
    expect(stopsInLink[0]).toBe('רחוב0 7, בית שמש');
    expect(stopsInLink[8]).toBe('רחוב8 7, בית שמש');
  });

  it('counts the cap on stops still to collect, not on handled ones', () => {
    const stops = [
      stopOn('x', 'הרצל', 'collected'),
      ...Array.from({ length: 9 }, (_, i) => stopOn(`o${i}`, `רחוב${i}`)),
    ];
    expect(placesOf(googleMapsRouteUrl(stops) ?? '').slice(0, -1)).toHaveLength(9);
  });

  it('encodes a street name with / or & instead of splitting the link', () => {
    const url = googleMapsRouteUrl([stopOn('a', 'א/ב&ג')]) ?? '';
    expect(placesOf(url)).toEqual(['א/ב&ג 7, בית שמש', DROP_OFF_ADDRESS]);
  });

  it('is undefined when no stop is left to collect', () => {
    expect(googleMapsRouteUrl([stopOn('a', 'הרצל', 'collected')])).toBeUndefined();
    expect(googleMapsRouteUrl([])).toBeUndefined();
  });
});

describe('dropOffWazeUrl', () => {
  it('searches the drop-off address in the same Waze form as a stop', () => {
    const url = dropOffWazeUrl();
    expect(url).toBe(`https://waze.com/ul?q=${encodeURIComponent(DROP_OFF_ADDRESS)}&navigate=yes`);
    expect(new URL(url).searchParams.get('q')).toBe('נחל נחשון 7, בית שמש');
  });
});
