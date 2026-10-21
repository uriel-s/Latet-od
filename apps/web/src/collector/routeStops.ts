// The words, links and list order of the route screen (spec §3.6 step 2, "מסלול"): the Waze and
// phone links of a stop, its address lines, the badge of a handled stop, the screen's order
// (handled stops drop to the end), how many stored moves one visible arrow tap needs, and keeping
// a "שלח תודה" row already shown, and the navigation buttons of the screen's top (ADR-0007): the
// next stop to collect, the Waze link to the drop-off and the one Google Maps link of the whole
// route. Pure, so all of it is tested without rendering the screen.
import {
  BOTTLES_SPOT_LABELS,
  DROP_OFF_ADDRESS,
  type Address,
  type MessageLink,
  type RoundStopState,
  type RouteStopView,
} from '@bottlerun/shared';

/**
 * The city added to every Waze search. Both regions, רמת בית שמש and בית שמש הוותיקה, are inside
 * the Beit Shemesh municipality, and Waze knows them all as "בית שמש". Without the city, a street
 * name that exists in other towns too (הרצל) can navigate Yoel to the wrong one.
 */
export const ROUTE_CITY = 'בית שמש';

/** The text a navigation app searches for a stop: "street number, city". One place, so Waze and Google Maps agree. */
function searchTextOf(address: Pick<Address, 'streetName' | 'houseNumber'>): string {
  return `${address.streetName.trim()} ${address.houseNumber.trim()}, ${ROUTE_CITY}`;
}

/** Waze's universal link searching `query` and starting navigation; the query is URL-encoded, Hebrew included. */
function wazeSearchUrl(query: string): string {
  return `https://waze.com/ul?q=${encodeURIComponent(query)}&navigate=yes`;
}

/**
 * The "נווט" link of a stop: Waze's universal link, searching the written address
 * ("street number, city") and starting navigation. `https://waze.com/ul` and not `waze://`
 * (spec §3.6): it opens the app on Android and on iPhone, and the Waze site when the app is not
 * installed. The query is URL-encoded, Hebrew included.
 */
export function wazeUrl(address: Pick<Address, 'streetName' | 'houseNumber'>): string {
  return wazeSearchUrl(searchTextOf(address));
}

/** The Waze link to the drop-off point (נחל נחשון 7), for when no stop is left to collect (ADR-0007). */
export function dropOffWazeUrl(): string {
  return wazeSearchUrl(DROP_OFF_ADDRESS);
}

/**
 * The most waypoints one Google Maps link carries on a phone (ADR-0007). With more stops, the link
 * holds the first ones still to collect and Yoel opens it again after collecting.
 */
export const MAX_MAPS_WAYPOINTS = 9;

/**
 * The first stop still to collect, in the stored route order (ADR-0007: the "נווט לעצירה הבאה"
 * button). Handled stops are skipped wherever they sit, so after "אספתי" the answer moves on at
 * once. `undefined` when nothing is left: the button then points at the drop-off.
 */
export function nextStopToCollect(stops: readonly RouteStopView[]): RouteStopView | undefined {
  return stops.find((stop) => !isStopHandled(stop.state));
}

/**
 * One Google Maps link for the stops still to collect, in the stored route order, ending at the
 * drop-off (ADR-0007). `undefined` when no stop is left.
 *
 * - No `origin`: Maps starts from the phone's location, so Yoel's home (ROUTE_START, private)
 *   never appears in a link.
 * - No `optimize`: Maps keeps the order `planRoute` stored.
 * - Waypoints are joined by an encoded pipe (%7C), the strictly valid URL form that Maps decodes;
 *   each address is encoded on its own, so a "|" or "&" inside a street name cannot split them.
 * - At most {@link MAX_MAPS_WAYPOINTS}: the first ones still to collect.
 */
export function googleMapsRouteUrl(stops: readonly RouteStopView[]): string | undefined {
  const waypoints = stops
    .filter((stop) => !isStopHandled(stop.state))
    .slice(0, MAX_MAPS_WAYPOINTS)
    .map((stop) => encodeURIComponent(searchTextOf(stop.order.address)));
  if (waypoints.length === 0) return undefined;
  return (
    'https://www.google.com/maps/dir/?api=1' +
    `&destination=${encodeURIComponent(DROP_OFF_ADDRESS)}` +
    `&waypoints=${waypoints.join('%7C')}` +
    '&travelmode=driving'
  );
}

/**
 * The "חייג" link of a stop. `phone` is the stored E.164 form (+972501234567); the `+` stays, so
 * the phone dials the international form, which works from any phone.
 */
export function telUrl(phone: string): string {
  return `tel:${phone}`;
}

/** The address of a stop's card, one line per part; see {@link stopAddressLines}. */
export interface StopAddressLines {
  /** "streetName houseNumber", e.g. "שד נהר הדן 12". */
  street: string;
  /** Where the bottles are, in the form's words, then the floor and apartment if given. */
  spot: string;
  /** The customer's note; left out when there is none. */
  note?: string;
}

/**
 * The full address of a stop's card (spec §3.6: "כתובת מלאה"): street and number, where the bottles
 * are with the floor and apartment joined by " · " (as the customer's own page shows it), and the
 * note. Empty or blank floorApt and note count as not given.
 */
export function stopAddressLines(address: Address): StopAddressLines {
  const floorApt = address.floorApt?.trim() ?? '';
  const note = address.note?.trim() ?? '';
  const spot = [BOTTLES_SPOT_LABELS[address.bottlesSpot], floorApt]
    .filter((part) => part !== '')
    .join(' · ');
  return {
    street: `${address.streetName.trim()} ${address.houseNumber.trim()}`,
    spot,
    ...(note === '' ? {} : { note }),
  };
}

/** Whether there is nothing left to do at a stop: every state but `toCollect`. */
export function isStopHandled(state: RoundStopState): boolean {
  return state !== 'toCollect';
}

/**
 * The badge of a handled stop's card. The card is also coloured, but the word carries the
 * meaning, so it never depends on colour alone.
 */
export const STOP_STATE_LABELS: Readonly<Record<Exclude<RoundStopState, 'toCollect'>, string>> = {
  collected: 'נאסף',
  notFound: 'לא נמצא',
  cancelled: 'בוטלה',
  left: 'יצאה מהסבב',
};

/**
 * The stops in the order the screen shows them (spec §3.6: "כרטיס שטופל ... יורד לסוף הרשימה"):
 * the stops still to collect in route order, then the handled ones, also in route order. A stable
 * partition, so the route itself never changes on screen, only where handled cards sit.
 */
export function screenOrderOfStops<T extends Pick<RouteStopView, 'state'>>(
  stops: readonly T[],
): T[] {
  return [
    ...stops.filter((stop) => !isStopHandled(stop.state)),
    ...stops.filter((stop) => isStopHandled(stop.state)),
  ];
}

/**
 * How many single-place moves in the STORED route the arrow tap on stop `orderId` needs.
 *
 * The api moves a stop one place in the stored route, which still holds the handled stops, but
 * the screen lists those at the end. One tap must change the VISIBLE list by exactly one place: the
 * stop has to pass its nearest to-collect neighbour in that direction, and every handled stop in
 * between. E.g. stored [B, handled, C]: C up is 2 moves, B down is 2 moves; stored [A, B]: B up
 * is 1.
 *
 * 0 when there is nothing to do: no to-collect stop that way (the top or bottom of the visible
 * list), `orderId` is a handled stop (its card has no arrows), or it is not in `stops`.
 */
export function storedMovesFor(
  stops: readonly RouteStopView[],
  orderId: string,
  direction: 'up' | 'down',
): number {
  const index = stops.findIndex((stop) => stop.order.id === orderId);
  const stop = stops[index];
  if (stop === undefined || isStopHandled(stop.state)) return 0;
  const step = direction === 'up' ? -1 : 1;
  for (
    let neighbour = index + step;
    neighbour >= 0 && neighbour < stops.length;
    neighbour += step
  ) {
    const neighbourStop = stops[neighbour];
    if (neighbourStop !== undefined && !isStopHandled(neighbourStop.state)) {
      return Math.abs(neighbour - index);
    }
  }
  return 0;
}

/**
 * The stops of a newly received view (`next`), keeping every "שלח תודה" row the screen already
 * showed: a `collected` stop without `thankYou` gets the one the same order had in `previous`.
 *
 * Why: a second "אספתי" tap's answer, or a reload that raced the first request, can carry a view
 * whose stop is collected but whose thank-you is not there yet (the first request is still in
 * flight). Hiding a row Yoel has already seen would lose the thank-you he means to send. A
 * `thankYou` in `next` always wins, since it is the newer one; a stop that is not collected never
 * gets one.
 */
export function keepThankYouRows(
  previous: readonly RouteStopView[],
  next: readonly RouteStopView[],
): RouteStopView[] {
  const previousThankYou = new Map<string, MessageLink>();
  for (const stop of previous) {
    if (stop.thankYou !== undefined) previousThankYou.set(stop.order.id, stop.thankYou);
  }
  return next.map((stop) => {
    if (stop.state !== 'collected' || stop.thankYou !== undefined) return stop;
    const thankYou = previousThankYou.get(stop.order.id);
    return thankYou === undefined ? stop : { ...stop, thankYou };
  });
}
