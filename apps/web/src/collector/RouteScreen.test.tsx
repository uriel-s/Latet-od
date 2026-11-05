import { StrictMode, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLECT_STOP_ERRORS,
  ROUND_MESSAGES,
  type CollectorOrder,
  type CollectorRound,
  type RoundView,
  type RouteStopView,
} from '@bottlerun/shared';
import type { MarkMessageOpenedOutcome, StopActionOutcome } from '../api.ts';
import {
  ALL_STOPS_HANDLED_TEXT,
  HANDLED_TITLE,
  UPCOMING_TITLE,
  donationLine,
  GOOGLE_MAPS_ROUTE_TEXT,
  NAVIGATE_TO_DROP_OFF_TEXT,
  NO_STOPS_TEXT,
  RouteScreen,
  STOP_ACTION_FAILED_MESSAGE,
  STOP_LEFT_ROUTE_MESSAGE,
  routeSummary,
  type RouteScreenProps,
} from './RouteScreen.tsx';
import { dropOffWazeUrl, screenOrderOfStops, wazeUrl } from './routeStops.ts';
import { BOTTLES_COLLECTED_LABEL, NEXT_STOP_EYEBROW, SEND_THANKS_TITLE } from './StopCard.tsx';

/** A confirmed order in round r1, in רמת בית שמש; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
    },
    bottlesEstimated: 40,
    status: 'confirmed',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

const DANA = makeOrder();
const MOSHE = makeOrder({
  id: 'o2',
  contact: { name: 'משה לוי', phone: '+972527654321' },
  address: {
    streetCode: 130,
    streetName: "בית ג'מאל",
    houseNumber: '5',
    bottlesSpot: 'privateHouse',
  },
  bottlesEstimated: 80,
});
const YOSSI = makeOrder({
  id: 'o3',
  contact: { name: 'יוסי מזרחי', phone: '+972501239999' },
  address: { streetCode: 101, streetName: 'הרצל', houseNumber: '3', bottlesSpot: 'privateHouse' },
  bottlesEstimated: 50,
});

/** Round r1, its route built. */
const ROUND: CollectorRound = {
  id: 'r1',
  date: '2026-11-19',
  region: 'ramat',
  status: 'open',
  phase: 'routed',
  createdAt: new Date('2026-10-20T07:00:00Z'),
};

/** The "שלח תודה" link of `order`. */
function thankYouUrl(order: CollectorOrder): string {
  return `https://wa.me/${order.contact.phone.slice(1)}?text=${encodeURIComponent('תודה רבה')}`;
}

/** A stop of `order` still to collect; overrides change it. */
function stopOf(order: CollectorOrder, overrides: Partial<RouteStopView> = {}): RouteStopView {
  return { order, hasLocation: true, state: 'toCollect', ...overrides };
}

/** `stop` collected, with its thank-you row (`thankYou: false` leaves the row out). */
function collected(stop: RouteStopView, { thankYou = true } = {}): RouteStopView {
  const { order } = stop;
  return {
    ...stop,
    order: { ...order, status: 'collected' },
    state: 'collected',
    ...(thankYou
      ? {
          thankYou: {
            orderId: order.id,
            messageIndex: 1,
            kind: 'thankYou' as const,
            name: order.contact.name,
            url: thankYouUrl(order),
          },
        }
      : {}),
  };
}

/** Round r1's view with `stops` in their stored driving order. */
function makeView(stops: RouteStopView[]): RoundView {
  return {
    round: ROUND,
    groups: [
      { key: 'confirmed', orders: [] },
      { key: 'pending', orders: [] },
      { key: 'otherDate', orders: [] },
    ],
    sendList: [],
    stops,
  };
}

/** Three stops to collect: דנה, משה, יוסי. */
const VIEW = makeView([stopOf(DANA), stopOf(MOSHE), stopOf(YOSSI)]);

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One answer of the fake api in place of doing the action; `'rejects'` rejects at call time. */
type Answer = StopActionOutcome | Promise<StopActionOutcome> | 'rejects';

interface Call {
  action: 'move' | 'collect' | 'notFound';
  roundId: string;
  orderId: string;
  /** The direction of a move, or the count of "אספתי". */
  arg?: string | number;
}

/**
 * A fake of the three stop actions over a stored route, like the api: a move swaps the stop with
 * its stored neighbour (`atEdge` at an end), "אספתי" collects it with its thank-you, "לא נמצא"
 * marks it, and each answers the round as it is now. Answers pushed to `next` are used first, in
 * order, in place of doing the action.
 */
function fakeApi(initial: RoundView = VIEW): {
  props: Required<Pick<RouteScreenProps, 'moveStop' | 'collectStop' | 'markStopNotFound'>>;
  calls: Call[];
  next: Answer[];
} {
  let stops = [...initial.stops];
  const calls: Call[] = [];
  const next: Answer[] = [];

  function answer(act: () => StopActionOutcome): Promise<StopActionOutcome> {
    const given = next.shift();
    if (given === 'rejects') return Promise.reject(new Error('boom'));
    if (given !== undefined) return Promise.resolve(given);
    return Promise.resolve(act());
  }
  const saved = (): StopActionOutcome => ({ kind: 'saved', view: { ...initial, stops } });
  const replace = (orderId: string, change: (stop: RouteStopView) => RouteStopView): void => {
    stops = stops.map((stop) => (stop.order.id === orderId ? change(stop) : stop));
  };

  return {
    calls,
    next,
    props: {
      moveStop: (roundId, orderId, direction) => {
        calls.push({ action: 'move', roundId, orderId, arg: direction });
        return answer(() => {
          const index = stops.findIndex((stop) => stop.order.id === orderId);
          const other = index + (direction === 'up' ? -1 : 1);
          const [stop, neighbour] = [stops[index], stops[other]];
          if (stop === undefined || neighbour === undefined) {
            return { kind: 'atEdge', message: ROUND_MESSAGES.stopAtEdge };
          }
          stops = [...stops];
          stops[index] = neighbour;
          stops[other] = stop;
          return saved();
        });
      },
      collectStop: (roundId, orderId, bottlesCollected) => {
        calls.push({ action: 'collect', roundId, orderId, arg: bottlesCollected });
        return answer(() => {
          replace(orderId, (stop) => collected(stop));
          return saved();
        });
      },
      markStopNotFound: (roundId, orderId) => {
        calls.push({ action: 'notFound', roundId, orderId });
        return answer(() => {
          replace(orderId, (stop) => ({ ...stop, state: 'notFound' }));
          return saved();
        });
      },
    },
  };
}

const markOpened = (): Promise<MarkMessageOpenedOutcome> =>
  Promise.resolve({ kind: 'marked', openedAt: new Date('2026-10-20T08:00:00Z') });

/** What the route told its parent. */
interface Parent {
  views: RoundView[];
  stale: string[];
  typing: boolean[];
}

/** The parent's part: holds the view, so a view the route hands back re-renders it. */
function Harness({
  initial,
  api,
  parent,
}: {
  initial: RoundView;
  api: ReturnType<typeof fakeApi>;
  parent: Parent;
}) {
  const [view, setView] = useState(initial);
  return (
    <RouteScreen
      view={view}
      onView={(next) => {
        parent.views.push(next);
        setView(next);
      }}
      onStale={(message) => parent.stale.push(message)}
      onTypingChange={(typing) => parent.typing.push(typing)}
      markOpened={markOpened}
      {...api.props}
    />
  );
}

function renderRoute(
  initial: RoundView = VIEW,
  { strict = false }: { strict?: boolean } = {},
): { api: ReturnType<typeof fakeApi>; parent: Parent; unmount: () => void } {
  const api = fakeApi(initial);
  const parent: Parent = { views: [], stale: [], typing: [] };
  const harness = <Harness initial={initial} api={api} parent={parent} />;
  const { unmount } = render(strict ? <StrictMode>{harness}</StrictMode> : harness);
  return { api, parent, unmount };
}

/** The customers' names, in the order the list shows the cards. */
function shownNames(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
}

function cardOf(name: string): HTMLElement {
  const card = screen.getByRole('heading', { level: 3, name }).closest('li');
  if (card === null) throw new Error(`no card for ${name}`);
  return card;
}

function button(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

/** The big "העצירה הבאה" card: the first stop still to collect. */
function currentCard(): HTMLElement {
  const card = screen.getByText(NEXT_STOP_EYEBROW).closest('li');
  if (card === null) throw new Error('no current card');
  return card;
}

/** Opens the card's "⋯" sheet for `name`. */
function openMore(name: string): void {
  fireEvent.click(button(`עוד פעולות, ${name}`));
}

/** Opens a card's "⋯" sheet and taps a button inside it ("לא נמצא" or an arrow). */
function sheetAction(name: string, label: string | RegExp): void {
  openMore(name);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }));
}

/**
 * Taps "אספתי" of `name`'s stop: on the big card itself, or, for an upcoming stop, in its "⋯"
 * sheet (collecting out of order).
 */
function startCollect(name: string): void {
  const direct = screen.queryByRole('button', { name: `אספתי, ${name}` });
  if (direct !== null) {
    fireEvent.click(direct);
    return;
  }
  fireEvent.click(button(`עוד פעולות, ${name}`));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'אספתי' }));
}

/** Taps "אספתי" on `name`'s card, types `text` (the estimate when undefined), and saves. */
function collect(name: string, text?: string): void {
  startCollect(name);
  if (text !== undefined) {
    fireEvent.change(screen.getByLabelText(BOTTLES_COLLECTED_LABEL), { target: { value: text } });
  }
  fireEvent.click(button('שמור'));
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/app/rounds');
});

describe('routeSummary', () => {
  it('counts the collected stops out of all, and those left', () => {
    expect(
      routeSummary([
        { state: 'collected' },
        { state: 'collected' },
        { state: 'notFound' },
        { state: 'toCollect' },
        { state: 'toCollect' },
      ]),
    ).toBe('נאספו 2 מתוך 5 · נשארו 2');
  });

  it('says so when the route has no stop', () => {
    expect(routeSummary([])).toBe(NO_STOPS_TEXT);
  });
});

describe('RouteScreen order', () => {
  it('lists the stops in stored route order, numbered, with the summary', () => {
    renderRoute();

    expect(shownNames()).toEqual(['דנה כהן', 'משה לוי', 'יוסי מזרחי']);
    const timeline = screen.getByRole('list', { name: UPCOMING_TITLE });
    expect(timeline.tagName).toBe('OL');
    // The dots count the cards on screen: the current stop is 1, the timeline starts at 2.
    expect(within(cardOf('משה לוי')).getByText('2')).toBeTruthy();
    expect(within(cardOf('יוסי מזרחי')).getByText('3')).toBeTruthy();
    expect(screen.getByText('נאספו 0 מתוך 3 · נשארו 3').getAttribute('aria-live')).toBe('polite');
  });

  it.each(['collected', 'notFound', 'cancelled'] as const)('puts a %s stop at the end', (state) => {
    renderRoute(makeView([stopOf(DANA), stopOf(MOSHE, { state }), stopOf(YOSSI)]));
    expect(shownNames()).toEqual(['דנה כהן', 'יוסי מזרחי', 'משה לוי']);
    // The numbers count the cards on screen.
    expect(within(cardOf('יוסי מזרחי')).getByText('2')).toBeTruthy();
  });

  it('says so, with no list, when the route has no stop', () => {
    renderRoute(makeView([]));
    expect(screen.getByText(NO_STOPS_TEXT)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('links the current stop to Waze and to its phone', () => {
    renderRoute();

    const card = cardOf('דנה כהן');
    expect(within(card).getByRole('link', { name: 'נווט, דנה כהן' }).getAttribute('href')).toBe(
      wazeUrl(DANA.address),
    );
    expect(within(card).getByRole('link', { name: /^חייג/ }).getAttribute('href')).toBe(
      'tel:+972501234567',
    );
  });

  it('keeps Waze and the phone of an upcoming stop in its "⋯" sheet', () => {
    renderRoute();

    fireEvent.click(button('עוד פעולות, משה לוי'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'נווט' }).getAttribute('href')).toBe(
      `https://waze.com/ul?q=${encodeURIComponent("בית ג'מאל 5, בית שמש")}&navigate=yes`,
    );
    expect(within(dialog).getByRole('link', { name: 'חייג' }).getAttribute('href')).toBe(
      'tel:+972527654321',
    );
  });

  it('shows the screen order of screenOrderOfStops across the three groups', () => {
    const stops = [
      stopOf(DANA, { state: 'notFound' }),
      stopOf(MOSHE),
      stopOf(YOSSI),
      stopOf(makeOrder({ id: 'o4', contact: { name: 'רות בר', phone: '+972521111111' } }), {
        state: 'collected',
      }),
    ];
    renderRoute(makeView(stops));

    expect(shownNames()).toEqual(screenOrderOfStops(stops).map((stop) => stop.order.contact.name));
    expect(shownNames()).toEqual(['משה לוי', 'יוסי מזרחי', 'דנה כהן', 'רות בר']);
    expect(screen.getByText(UPCOMING_TITLE)).toBeTruthy();
    expect(screen.getByText(HANDLED_TITLE)).toBeTruthy();
    // The handled group lists the two handled stops, with their state in words.
    const handled = screen.getByRole('list', { name: HANDLED_TITLE });
    expect(within(handled).getByText('לא נמצא')).toBeTruthy();
    expect(within(handled).getByText('נאסף')).toBeTruthy();
  });

  it('collects an upcoming stop out of order from its sheet', async () => {
    const { api } = renderRoute();
    collect('יוסי מזרחי', '12');
    await waitFor(() =>
      expect(api.calls).toEqual([{ action: 'collect', roundId: 'r1', orderId: 'o3', arg: 12 }]),
    );
  });

  it('marks an upcoming stop not found from its sheet', () => {
    renderRoute();
    fireEvent.click(button('עוד פעולות, משה לוי'));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'לא נמצא' }),
    ).toBeTruthy();
  });
});

describe('RouteScreen progress and current stop', () => {
  it('shows "עצירה N מתוך M" and keeps the summary as text', () => {
    renderRoute(makeView([collected(stopOf(DANA)), stopOf(MOSHE), stopOf(YOSSI)]));

    const progress = screen.getByRole('group', { name: 'התקדמות המסלול' });
    expect(within(progress).getByText('עצירה 2 מתוך 3')).toBeTruthy();
    expect(within(progress).getByText('נאספו 1 מתוך 3 · נשארו 2')).toBeTruthy();
    // One decorative segment per stop: done, current, ahead.
    const segments = progress.querySelectorAll('.route-progress-bar i');
    expect([...segments].map((segment) => segment.className)).toEqual([
      'route-progress-done',
      'route-progress-current',
      '',
    ]);
  });

  it('makes the first stop to collect the current card, with its tags', () => {
    renderRoute(
      makeView([collected(stopOf(DANA)), stopOf(YOSSI, { hasLocation: false }), stopOf(MOSHE)]),
    );

    const card = currentCard();
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('יוסי מזרחי');
    expect(within(card).getByText('הרצל 3')).toBeTruthy();
    expect(within(card).getByText('בלי מיקום')).toBeTruthy();
    expect(within(card).getByText('אושרה')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'אספתי, יוסי מזרחי' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: /^חייג/ })).toBeTruthy();
    // Only one card is the current one.
    expect(screen.getAllByText(NEXT_STOP_EYEBROW)).toHaveLength(1);
  });

  it('moves the current card to the next stop after "אספתי"', async () => {
    renderRoute();
    expect(within(currentCard()).getByRole('heading', { level: 3 }).textContent).toBe('דנה כהן');

    collect('דנה כהן');

    await waitFor(() =>
      expect(within(currentCard()).getByRole('heading', { level: 3 }).textContent).toBe('משה לוי'),
    );
    expect(screen.getByText('עצירה 2 מתוך 3')).toBeTruthy();
  });

  it('shows the drop-off card and no current card when no stop is left', () => {
    renderRoute(makeView([collected(stopOf(DANA)), stopOf(MOSHE, { state: 'notFound' })]));

    expect(screen.queryByText(NEXT_STOP_EYEBROW)).toBeNull();
    expect(screen.getByText(ALL_STOPS_HANDLED_TEXT)).toBeTruthy();
    expect(screen.getByRole('link', { name: NAVIGATE_TO_DROP_OFF_TEXT }).getAttribute('href')).toBe(
      dropOffWazeUrl(),
    );
  });

  it('keeps "לא נמצא" and the arrows behind "⋯" until it is tapped', () => {
    renderRoute();

    const more = button('עוד פעולות, דנה כהן');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getByRole('button', { name: 'לא נמצא' })).toBeTruthy();
    expect(sheet.getByRole('button', { name: /^הזז למטה/ })).toBeTruthy();
  });
});

describe('RouteScreen navigation links', () => {
  it('opens Waze at the first stop to collect, in stored order', () => {
    renderRoute(makeView([collected(stopOf(DANA)), stopOf(YOSSI), stopOf(MOSHE)]));

    const link = within(currentCard()).getByRole('link', { name: 'נווט, יוסי מזרחי' });
    expect(link.getAttribute('href')).toBe(wazeUrl(YOSSI.address));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('moves on to the next stop after "אספתי"', async () => {
    renderRoute();
    expect(within(currentCard()).getByRole('link', { name: 'נווט, דנה כהן' })).toBeTruthy();

    collect('דנה כהן');

    await waitFor(() =>
      expect(within(currentCard()).getByRole('heading', { level: 3 }).textContent).toBe('משה לוי'),
    );
    const next = within(currentCard()).getByRole('link', { name: 'נווט, משה לוי' });
    expect(next.getAttribute('href')).toBe(wazeUrl(MOSHE.address));
  });

  it('points at the drop-off when every stop is handled, and hides the Google Maps link', () => {
    renderRoute(makeView([collected(stopOf(DANA)), stopOf(MOSHE, { state: 'notFound' })]));

    const link = screen.getByRole('link', { name: NAVIGATE_TO_DROP_OFF_TEXT });
    expect(link.getAttribute('href')).toBe(dropOffWazeUrl());
    expect(screen.queryByRole('link', { name: GOOGLE_MAPS_ROUTE_TEXT })).toBeNull();
  });

  it('links all stops still to collect in Google Maps, ending at the drop-off, without origin', () => {
    renderRoute(makeView([collected(stopOf(DANA)), stopOf(YOSSI), stopOf(MOSHE)]));

    const href =
      screen.getByRole('link', { name: GOOGLE_MAPS_ROUTE_TEXT }).getAttribute('href') ?? '';
    expect(href).not.toContain('origin=');
    const places = href
      .slice('https://www.google.com/maps/dir//'.length)
      .split('/')
      .map(decodeURIComponent);
    expect(places).toHaveLength(3);
    expect(places.slice(0, 2)).toEqual(['הרצל 3, בית שמש', "בית ג'מאל 5, בית שמש"]);
    expect(places[2]).toContain('נחל נחשון 7');
  });

  it('shows neither link for a route with no stop', () => {
    renderRoute(makeView([]));
    expect(screen.queryByRole('link', { name: /נווט/ })).toBeNull();
    expect(screen.queryByRole('link', { name: GOOGLE_MAPS_ROUTE_TEXT })).toBeNull();
  });
});

describe('RouteScreen "אספתי"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the estimate, then moves the card to the end with its "שלח תודה" row', async () => {
    const { api, parent } = renderRoute();

    collect('דנה כהן');

    await waitFor(() => expect(shownNames()).toEqual(['משה לוי', 'יוסי מזרחי', 'דנה כהן']));
    expect(api.calls).toEqual([{ action: 'collect', roundId: 'r1', orderId: 'o1', arg: 40 }]);
    expect(parent.views).toHaveLength(1);
    const card = cardOf('דנה כהן');
    expect(within(card).getByText('נאסף')).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 4, name: SEND_THANKS_TITLE })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'שלח לדנה כהן' }).getAttribute('href')).toBe(
      thankYouUrl(DANA),
    );
    expect(screen.getByText('נאספו 1 מתוך 3 · נשארו 2')).toBeTruthy();
  });

  // The saved card leaves the current list for the handled one, where React mounts a new card:
  // the buzz and the focus must still come (the screen tells the new card, justSaved).
  it("buzzes once and moves the focus to 'שלח תודה' after Yoel's own 'אספתי'", async () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    renderRoute();

    collect('דנה כהן');

    const title = await screen.findByRole('heading', { level: 4, name: SEND_THANKS_TITLE });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(30);
  });

  it('neither buzzes nor moves the focus when the save fails', async () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    const { api } = renderRoute();
    api.next.push({ kind: 'failed' });

    collect('דנה כהן');

    await waitFor(() =>
      expect(within(currentCard()).getByRole('alert').textContent).toBe(STOP_ACTION_FAILED_MESSAGE),
    );
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('sends the corrected quantity', async () => {
    const { api } = renderRoute();
    collect('משה לוי', '42');
    await waitFor(() =>
      expect(api.calls).toEqual([{ action: 'collect', roundId: 'r1', orderId: 'o2', arg: 42 }]),
    );
  });

  it('keeps a shown "שלח תודה" row when a later view lacks it', async () => {
    const { api } = renderRoute();
    collect('דנה כהן');
    await screen.findByRole('link', { name: 'שלח לדנה כהן' });

    // A later answer whose collected stop has no thank-you yet (a request that raced the first).
    api.next.push({
      kind: 'saved',
      view: makeView([collected(stopOf(DANA), { thankYou: false }), stopOf(YOSSI), stopOf(MOSHE)]),
    });
    // Moshe is the current card now, so his arrows sit behind "⋯".
    openMore('משה לוי');
    sheetAction('משה לוי', /^הזז למטה/);

    await waitFor(() => expect(shownNames()).toEqual(['יוסי מזרחי', 'משה לוי', 'דנה כהן']));
    expect(screen.getByRole('link', { name: 'שלח לדנה כהן' }).getAttribute('href')).toBe(
      thankYouUrl(DANA),
    );
  });
});

describe('RouteScreen "לא נמצא"', () => {
  it('asks first, then marks the stop and moves it to the end with its badge', async () => {
    const { api } = renderRoute();

    openMore('דנה כהן');
    sheetAction('דנה כהן', 'לא נמצא');
    expect(api.calls).toEqual([]);
    fireEvent.click(button('כן, לא נמצא'));

    await waitFor(() => expect(shownNames()).toEqual(['משה לוי', 'יוסי מזרחי', 'דנה כהן']));
    expect(api.calls).toEqual([{ action: 'notFound', roundId: 'r1', orderId: 'o1' }]);
    expect(within(cardOf('דנה כהן')).getByText('לא נמצא')).toBeTruthy();
  });
});

describe('RouteScreen moves', () => {
  it('shows no "up" on the first card and no "down" on the last one to collect', () => {
    renderRoute(makeView([stopOf(DANA), stopOf(MOSHE), stopOf(YOSSI, { state: 'collected' })]));

    /** The arrows in the sheet of one card; the sheet is closed again after. */
    const arrowsOf = (name: string): string[] => {
      openMore(name);
      const labels = within(screen.getByRole('dialog'))
        .getAllByRole('button')
        .map((arrow) => arrow.textContent ?? '')
        .filter((text) => text.includes('הזז'));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      return labels;
    };
    expect(arrowsOf('דנה כהן')).toEqual(['▼ הזז למטה']);
    expect(arrowsOf('משה לוי')).toEqual(['▲ הזז למעלה']);
    // A handled stop has no "⋯" at all.
    expect(within(cardOf('יוסי מזרחי')).queryByRole('button')).toBeNull();
  });

  it('moves a stop down and up, one stored place each', async () => {
    const { api, parent } = renderRoute();

    openMore('דנה כהן');
    sheetAction('דנה כהן', /^הזז למטה/);
    await waitFor(() => expect(shownNames()).toEqual(['משה לוי', 'דנה כהן', 'יוסי מזרחי']));
    sheetAction('יוסי מזרחי', /^הזז למעלה/);
    await waitFor(() => expect(shownNames()).toEqual(['משה לוי', 'יוסי מזרחי', 'דנה כהן']));

    expect(api.calls).toEqual([
      { action: 'move', roundId: 'r1', orderId: 'o1', arg: 'down' },
      { action: 'move', roundId: 'r1', orderId: 'o3', arg: 'up' },
    ]);
    expect(parent.views).toHaveLength(2);
  });

  it("keeps the focus on the moved stop's '⋯' when it leaves the current card", async () => {
    renderRoute();

    sheetAction('דנה כהן', /^הזז למטה/);

    await waitFor(() => expect(within(currentCard()).getByText('משה לוי')).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(button('עוד פעולות, דנה כהן')));
  });

  it('passes a handled stop in between with two stored moves for one tap', async () => {
    const { api, parent } = renderRoute(
      makeView([stopOf(DANA), stopOf(MOSHE, { state: 'notFound' }), stopOf(YOSSI)]),
    );
    expect(shownNames()).toEqual(['דנה כהן', 'יוסי מזרחי', 'משה לוי']);

    sheetAction('יוסי מזרחי', /^הזז למעלה/);

    await waitFor(() => expect(shownNames()).toEqual(['יוסי מזרחי', 'דנה כהן', 'משה לוי']));
    expect(api.calls).toEqual([
      { action: 'move', roundId: 'r1', orderId: 'o3', arg: 'up' },
      { action: 'move', roundId: 'r1', orderId: 'o3', arg: 'up' },
    ]);
    // Each stored move's answer is swapped in.
    expect(parent.views).toHaveLength(2);
  });

  it('stops a two-move tap at the first answer that is not saved', async () => {
    const { api, parent } = renderRoute(
      makeView([stopOf(DANA), stopOf(MOSHE, { state: 'notFound' }), stopOf(YOSSI)]),
    );
    api.next.push(
      {
        kind: 'saved',
        view: makeView([stopOf(DANA), stopOf(YOSSI), stopOf(MOSHE, { state: 'notFound' })]),
      },
      { kind: 'failed' },
    );

    sheetAction('יוסי מזרחי', /^הזז למעלה/);

    await waitFor(() =>
      expect(within(cardOf('יוסי מזרחי')).getByRole('alert').textContent).toBe(
        STOP_ACTION_FAILED_MESSAGE,
      ),
    );
    expect(api.calls).toHaveLength(2);
    expect(parent.views).toHaveLength(1);
  });
});

describe('RouteScreen errors', () => {
  it.each([ROUND_MESSAGES.stopHandled, ROUND_MESSAGES.routeNotOpen])(
    'hands a stale answer to the parent: %s',
    async (message) => {
      const { api, parent } = renderRoute();
      api.next.push({ kind: 'stale', message });

      collect('דנה כהן');

      await waitFor(() => expect(parent.stale).toEqual([message]));
      expect(parent.views).toEqual([]);
    },
  );

  it('tells the parent a stop that left the route', async () => {
    const { api, parent } = renderRoute();
    api.next.push({ kind: 'notFound' });

    sheetAction('משה לוי', 'לא נמצא');
    fireEvent.click(button('כן, לא נמצא'));

    await waitFor(() => expect(parent.stale).toEqual([STOP_LEFT_ROUTE_MESSAGE]));
  });

  it('shows "already at the edge" in the card', async () => {
    const { api } = renderRoute();
    api.next.push({ kind: 'atEdge', message: ROUND_MESSAGES.stopAtEdge });

    sheetAction('משה לוי', /^הזז למעלה/);

    await waitFor(() =>
      expect(within(cardOf('משה לוי')).getByRole('alert').textContent).toBe(
        ROUND_MESSAGES.stopAtEdge,
      ),
    );
  });

  it.each([{ kind: 'failed' } as const, 'rejects' as const])(
    'shows a failed "לא נמצא" in the open sheet, and the next tap clears it (%s)',
    async (failure) => {
      const { api } = renderRoute();
      api.next.push(failure);

      sheetAction('משה לוי', 'לא נמצא');
      fireEvent.click(button('כן, לא נמצא'));
      // In the still-open sheet, where Yoel looks, not in the card behind its dark background.
      await waitFor(() =>
        expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(
          STOP_ACTION_FAILED_MESSAGE,
        ),
      );
      expect(window.location.pathname).toBe('/app/rounds');

      fireEvent.click(button('כן, לא נמצא'));
      await waitFor(() => expect(within(cardOf('משה לוי')).getByText('לא נמצא')).toBeTruthy());
      expect(within(cardOf('משה לוי')).queryByRole('alert')).toBeNull();
    },
  );

  it("shows the api's refused count next to the quantity field", async () => {
    const { api } = renderRoute();
    api.next.push({
      kind: 'invalid',
      fieldErrors: { bottlesCollected: COLLECT_STOP_ERRORS.bottlesTooMany },
    });

    collect('דנה כהן', '42');

    const field = screen.getByLabelText(BOTTLES_COLLECTED_LABEL);
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(COLLECT_STOP_ERRORS.bottlesTooMany).id).toBe(
      field.getAttribute('aria-describedby'),
    );
  });

  it('shows the plain count message when the refusal names none', async () => {
    const { api } = renderRoute();
    api.next.push({ kind: 'invalid', fieldErrors: {} });

    collect('דנה כהן');

    expect(await screen.findByText(COLLECT_STOP_ERRORS.bottlesInvalid)).toBeTruthy();
  });

  it('goes to the login, replacing the screen, when the session ended', async () => {
    const { api } = renderRoute();
    api.next.push({ kind: 'loggedOut' });
    const historyLength = window.history.length;

    collect('דנה כהן');

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(window.history.length).toBe(historyLength);
  });

  it('ignores an answer that comes after the route left the screen', async () => {
    const answer = deferred<StopActionOutcome>();
    const { api, parent, unmount } = renderRoute();
    api.next.push(answer.promise);
    collect('דנה כהן');
    unmount();

    answer.resolve({ kind: 'loggedOut' });
    await settle();

    expect(window.location.pathname).toBe('/app/rounds');
    expect(parent.views).toEqual([]);
  });
});

describe('RouteScreen busy', () => {
  it('sends one request for a double tap, while the other cards still work', async () => {
    const answer = deferred<StopActionOutcome>();
    const { api } = renderRoute();
    api.next.push(answer.promise);

    collect('דנה כהן');
    fireEvent.click(button('שומר...'));
    expect(button('שומר...').getAttribute('aria-disabled')).toBe('true');
    sheetAction('יוסי מזרחי', /^הזז למעלה/);

    await waitFor(() => expect(shownNames()).toEqual(['דנה כהן', 'יוסי מזרחי', 'משה לוי']));
    expect(api.calls.map((call) => call.action)).toEqual(['collect', 'move']);

    answer.resolve({ kind: 'failed' });
    await waitFor(() =>
      expect(within(cardOf('דנה כהן')).getByRole('alert').textContent).toBe(
        STOP_ACTION_FAILED_MESSAGE,
      ),
    );
  });

  it('sends one move for a double tap on an arrow', async () => {
    const answer = deferred<StopActionOutcome>();
    const { api } = renderRoute();
    api.next.push(answer.promise);

    sheetAction('דנה כהן', /^הזז למטה/);
    // The second tap finds "⋯" busy: no sheet opens, so no second request can be made.
    fireEvent.click(button('עוד פעולות, דנה כהן'));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(api.calls).toHaveLength(1);
    answer.resolve({ kind: 'saved', view: makeView([stopOf(MOSHE), stopOf(DANA), stopOf(YOSSI)]) });
    await waitFor(() => expect(shownNames()).toEqual(['משה לוי', 'דנה כהן', 'יוסי מזרחי']));
    expect(api.calls).toHaveLength(1);
  });
});

describe('RouteScreen typing', () => {
  it('tells the parent once while any quantity field is open', () => {
    const { parent } = renderRoute(VIEW, { strict: true });

    startCollect('דנה כהן');
    expect(parent.typing).toEqual([true]);
    startCollect('משה לוי');
    fireEvent.click(within(cardOf('דנה כהן')).getByRole('button', { name: 'ביטול' }));
    expect(parent.typing).toEqual([true]);
    fireEvent.click(within(cardOf('משה לוי')).getByRole('button', { name: 'ביטול' }));
    expect(parent.typing).toEqual([true, false]);
  });

  it('stops typing once the save closes the field', async () => {
    const { parent } = renderRoute();
    collect('דנה כהן');
    await waitFor(() => expect(parent.typing).toEqual([true, false]));
  });

  it('tells the parent typing stopped when the route leaves with a field open', () => {
    const { parent, unmount } = renderRoute();
    fireEvent.click(button('אספתי, דנה כהן'));
    unmount();
    expect(parent.typing).toEqual([true, false]);
  });
});

describe('donationLine and the donation row', () => {
  const collectedWith = (order: CollectorOrder, bottlesCollected: number) =>
    collected(stopOf({ ...order, bottlesCollected }));

  it('is hidden while nothing was collected', () => {
    expect(donationLine([stopOf(DANA), stopOf(MOSHE)])).toBeUndefined();
    renderRoute();
    expect(screen.queryByText(/לתפילין/)).toBeNull();
  });

  it('sums the real counts of the collected stops, in shekels', () => {
    const stops = [collectedWith(DANA, 40), collectedWith(MOSHE, 85), stopOf(YOSSI)];
    expect(donationLine(stops)).toBe('בסבב הזה נאספו 125 בקבוקים, כ־25 ₪ לתפילין');
    renderRoute(makeView(stops));
    expect(screen.getByText('בסבב הזה נאספו 125 בקבוקים, כ־25 ₪ לתפילין')).toBeTruthy();
  });

  it('reads right for one bottle and counts only collected stops', () => {
    const stops = [
      collectedWith(DANA, 1),
      stopOf({ ...MOSHE, bottlesCollected: 50 }, { state: 'notFound' }),
    ];
    expect(donationLine(stops)).toBe('בסבב הזה נאסף בקבוק אחד, כ־0.20 ₪ לתפילין');
  });
});
