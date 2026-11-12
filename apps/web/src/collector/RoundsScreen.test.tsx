import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROUND_MESSAGES,
  type CollectorOrder,
  type CollectorRound,
  type MessageLink,
  type RoundView,
  type RouteStopView,
} from '@bottlerun/shared';
import { deferred, makeCollectorOrder } from '@bottlerun/shared/testing';
import type { Api } from '../api/ApiContext.tsx';
import type { MarkMessageOpenedOutcome } from '../api/collectorOrdersApi.ts';
import { renderWithApi } from '../api/renderWithApi.tsx';
import type {
  BuildRouteOutcome,
  CloseRoundOutcome,
  RoundsOutcome,
  StopActionOutcome,
} from '../api/roundsApi.ts';
import { BUILD_ROUTE_FAILED_MESSAGE, BUILD_ROUTE_LABEL } from './BuildRouteConfirm.tsx';
import { CLOSE_ROUND_TEXTS, UNSENT_THANK_YOUS_TITLE } from './CloseRoundConfirm.tsx';
import {
  NO_OPEN_ROUND_TEXT,
  ROUNDS_LOAD_FAILED_MESSAGE,
  ROUND_CLOSED_MESSAGE,
  RoundsScreen,
  SEND_LIST_HEADING,
  SEND_LIST_HINT,
  roundGroupsSummary,
} from './RoundsScreen.tsx';
import { ROUND_PICKER_TITLE, ROUND_PICKER_TRIGGER_PREFIX } from './RoundPickerSheet.tsx';
import { wazeUrl } from './routeStops.ts';
import { BOTTLES_COLLECTED_LABEL, SEND_THANKS_TITLE } from './StopCard.tsx';
import { returnToApp } from './visibilityTestHelper.ts';

/**
 * What these tests start from, on top of makeCollectorOrder: in round r1, `confirmed` as planning
 * leaves it (ADR-0012), with a floor and apartment.
 */
const IN_ROUND: Partial<CollectorOrder> = {
  status: 'confirmed',
  address: { ...makeCollectorOrder().address, floorApt: 'קומה 3, דירה 12' },
};

/** In the round. */
const DANA = makeCollectorOrder(IN_ROUND);
/** In the round. */
const MOSHE = makeCollectorOrder({
  ...IN_ROUND,
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
/**
 * In the round as a legacy `pending` order (planned before ADR-0012), shown like a confirmed one;
 * no map point: its card has "בלי מיקום".
 */
const YOSSI = makeCollectorOrder({
  ...IN_ROUND,
  id: 'o4',
  status: 'pending',
  contact: { name: 'יוסי מזרחי', phone: '+972501239999' },
  address: { streetCode: 101, streetName: 'הרצל', houseNumber: '3', bottlesSpot: 'privateHouse' },
  bottlesEstimated: 50,
  hasLocation: false,
});
/** Asked for another date: out of the round, waiting again, with the miss of this round. */
const RACHEL = makeCollectorOrder({
  ...IN_ROUND,
  id: 'o3',
  contact: { name: 'רחל אברהם', phone: '+972541112233' },
  address: { streetName: 'סמטת הגפנים', houseNumber: '7', bottlesSpot: 'buildingEntrance' },
  bottlesEstimated: 30,
  status: 'waiting',
  lastMiss: { date: '2026-11-19', reason: 'askedOtherDate', roundId: 'r1' },
});

/** Round r1: Thursday 19/11 in רמת בית שמש, with a pickup time and a two-line personal text. */
const ROUND: CollectorRound = {
  id: 'r1',
  date: '2026-11-19',
  region: 'ramat',
  status: 'open',
  phase: 'confirming',
  pickupBy: '08:30',
  personalText: 'תודה רבה!\nיואל',
  createdAt: new Date('2026-10-20T07:00:00Z'),
};

/** The "שלח" row of `order`'s round message (kind `confirmRequest`). */
function sendRowOf(order: CollectorOrder): MessageLink {
  return {
    orderId: order.id,
    messageIndex: 1,
    kind: 'confirmRequest',
    name: order.contact.name,
    url: `https://wa.me/${order.contact.phone.slice(1)}?text=x`,
  };
}

/**
 * A round's view as the api builds it: the two groups in order, and by default one "שלח" row
 * per order in the round not collected yet.
 */
function makeView({
  round = {},
  inRound = [],
  otherDate = [],
  sendList = inRound.filter((order) => order.status !== 'collected').map(sendRowOf),
}: {
  round?: Partial<CollectorRound>;
  inRound?: CollectorOrder[];
  otherDate?: CollectorOrder[];
  sendList?: MessageLink[];
}): RoundView {
  return {
    round: { ...ROUND, ...round },
    groups: [
      { key: 'inRound', orders: inRound },
      { key: 'otherDate', orders: otherDate },
    ],
    sendList,
    stops: [],
  };
}

/** Round r1: three customers in the round, one who asked for another date. */
const VIEW = makeView({ inRound: [DANA, MOSHE, YOSSI], otherDate: [RACHEL] });
/** VIEW after משה tapped "לא מתאים הפעם": he asked for another date and has no "שלח" row. */
const VIEW_MOSHE_DECLINED = makeView({
  inRound: [DANA, YOSSI],
  otherDate: [
    RACHEL,
    {
      ...MOSHE,
      status: 'waiting',
      lastMiss: { date: '2026-11-19', reason: 'askedOtherDate', roundId: 'r1' },
    },
  ],
});

/** Round r2, a week after r1 in the other half of the city, no route yet, one customer. */
const SECOND = makeView({
  round: { id: 'r2', date: '2026-11-26', region: 'old' },
  inRound: [
    makeCollectorOrder({
      ...IN_ROUND,
      id: 'o9',
      contact: { name: 'שרה גולן', phone: '+972509998877' },
    }),
  ],
});

const LOADED: RoundsOutcome = { kind: 'loaded', rounds: [VIEW] };
/** Two open rounds, as the api lists them: the nearest date first. */
const LOADED_TWO: RoundsOutcome = { kind: 'loaded', rounds: [VIEW, SECOND] };
const NO_ROUNDS: RoundsOutcome = { kind: 'loaded', rounds: [] };
const LOGGED_OUT = { kind: 'loggedOut' } as const;
const FAILED = { kind: 'failed' } as const;

/**
 * One answer of a fake: an outcome, a promise of one (a `deferred` the test settles), or
 * `'rejects'` (made at call time, so no rejected promise waits unhandled before the call).
 */
type Answer<T> = T | Promise<T> | 'rejects';

/** Answers each call with the next answer given; the last one repeats. */
function answerOf<T>(answers: readonly Answer<T>[], call: number, fallback: T): Promise<T> {
  const answer = answers.length === 0 ? fallback : answers[Math.min(call, answers.length - 1)];
  if (answer === 'rejects') return Promise.reject(new Error('boom'));
  return Promise.resolve(answer ?? fallback);
}

/** A fake `fetchRounds` (answers {@link LOADED} when given nothing). */
function fakeLoad(...answers: Answer<RoundsOutcome>[]): {
  load: () => Promise<RoundsOutcome>;
  calls: () => number;
} {
  let calls = 0;
  const load = (): Promise<RoundsOutcome> => answerOf(answers, calls++, LOADED);
  return { load, calls: () => calls };
}

/** A fake `markMessageOpened` that records its calls and answers `marked` on 20/10. */
function fakeMarkOpened(): {
  markMessageOpened: Api['markMessageOpened'];
  calls: { orderId: string; messageIndex: number }[];
} {
  const calls: { orderId: string; messageIndex: number }[] = [];
  const markMessageOpened = (orderId: string, messageIndex: number) => {
    calls.push({ orderId, messageIndex });
    const outcome: MarkMessageOpenedOutcome = {
      kind: 'marked',
      openedAt: new Date('2026-10-20T07:30:00Z'),
    };
    return Promise.resolve(outcome);
  };
  return { markMessageOpened, calls };
}

/** `order` as a stop of round r1's route, still to collect. */
function stopOf(order: CollectorOrder, overrides: Partial<RouteStopView> = {}): RouteStopView {
  return {
    order: { ...order, status: 'confirmed' },
    hasLocation: true,
    state: 'toCollect',
    ...overrides,
  };
}

/** `stop` collected, with its "שלח תודה" row. */
function collected(stop: RouteStopView): RouteStopView {
  const { order } = stop;
  return {
    ...stop,
    order: { ...order, status: 'collected' },
    state: 'collected',
    thankYou: {
      orderId: order.id,
      messageIndex: 1,
      kind: 'thankYou',
      name: order.contact.name,
      url: `https://wa.me/${order.contact.phone.slice(1)}?text=thanks`,
    },
  };
}

/** Round r1 routed, with `stops` in driving order: no groups left and no "שלח" rows. */
function routedView(stops: RouteStopView[]): RoundView {
  return { ...makeView({ round: { phase: 'routed' }, sendList: [] }), stops };
}

/** Round r1 once its route is built: דנה and משה are its stops. */
const ROUTED = routedView([stopOf(DANA), stopOf(MOSHE)]);

/** A fake `buildRoute` that records its calls (answers built {@link ROUTED}). */
function fakeBuildRoute(...answers: Answer<BuildRouteOutcome>[]): {
  buildRoute: Api['buildRoute'];
  calls: string[];
} {
  const calls: string[] = [];
  const buildRoute = (roundId: string) => {
    calls.push(roundId);
    return answerOf(answers, calls.length - 1, { kind: 'built' as const, view: ROUTED });
  };
  return { buildRoute, calls };
}

/** `view` as the close button ("בטל את הסבב" / "סיימתי את הסבב") answers it: the round closed, its view otherwise as it was. */
function closedView(view: RoundView): RoundView {
  return {
    ...view,
    round: { ...view.round, status: 'closed', closedAt: new Date('2026-11-19T15:00:00Z') },
  };
}

/** A fake `closeRound` that records its calls (answers round r1 closed, from {@link VIEW}). */
function fakeCloseRound(...answers: Answer<CloseRoundOutcome>[]): {
  closeRound: Api['closeRound'];
  calls: string[];
} {
  const calls: string[] = [];
  const closeRound = (roundId: string) => {
    calls.push(roundId);
    return answerOf(answers, calls.length - 1, { kind: 'closed' as const, view: closedView(VIEW) });
  };
  return { closeRound, calls };
}

/** One call of a stop action fake. */
interface StopCall {
  action: 'move' | 'collect' | 'notFound';
  roundId: string;
  orderId: string;
  arg?: string | number;
}

/**
 * Fakes of the three stop actions, recording into one list; each answers the next of `answers`
 * (the last repeats), or a failure when given none.
 */
function fakeStopActions(...answers: Answer<StopActionOutcome>[]): {
  fakes: Pick<Api, 'moveStop' | 'collectStop' | 'markStopNotFound'>;
  calls: StopCall[];
} {
  const calls: StopCall[] = [];
  const answer = (call: StopCall) => {
    calls.push(call);
    return answerOf(answers, calls.length - 1, { kind: 'failed' as const });
  };
  return {
    calls,
    fakes: {
      moveStop: (roundId, orderId, direction) =>
        answer({ action: 'move', roundId, orderId, arg: direction }),
      collectStop: (roundId, orderId, bottlesCollected) =>
        answer({ action: 'collect', roundId, orderId, arg: bottlesCollected }),
      markStopNotFound: (roundId, orderId) => answer({ action: 'notFound', roundId, orderId }),
    },
  };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every client function the rounds tab calls: its own load, build and close, the route's stop
 * actions (RouteScreen) and the "שלח" rows' opening (SendList), each taken from useApi.
 */
type ScreenFakes = Pick<
  Api,
  | 'fetchRounds'
  | 'buildRoute'
  | 'closeRound'
  | 'moveStop'
  | 'collectStop'
  | 'markStopNotFound'
  | 'markMessageOpened'
>;

/**
 * Every function of {@link ScreenFakes} faked: rounds loaded as {@link LOADED}, a build and a close
 * that succeed, stop actions that fail, and openings that are marked. A test replaces the ones it
 * looks at; none falls through to the real client, which in jsdom would only answer `failed`.
 */
function defaultFakes(): ScreenFakes {
  return {
    fetchRounds: fakeLoad().load,
    buildRoute: fakeBuildRoute().buildRoute,
    closeRound: fakeCloseRound().closeRound,
    ...fakeStopActions().fakes,
    markMessageOpened: fakeMarkOpened().markMessageOpened,
  };
}

/**
 * Opens the rounds tab at /app/rounds under an ApiProvider: `fakes` over {@link defaultFakes}.
 * `strict` puts StrictMode around the whole tree, as in development.
 */
function renderScreen(
  fakes: Partial<ScreenFakes>,
  { strict = false, url = '/app/rounds' }: { strict?: boolean; url?: string } = {},
): { unmount: () => void } {
  window.history.replaceState(null, '', url);
  return renderWithApi(
    <RoundsScreen />,
    { ...defaultFakes(), ...fakes },
    { reactStrictMode: strict },
  );
}

/** The region of round r1 on 19/11. */
function roundRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'רמת בית שמש · 19/11' });
}

/** Renders the tab with `fakes` ({@link LOADED} by default), and waits for round r1. */
async function renderLoaded(fakes: Partial<ScreenFakes> = {}): Promise<HTMLElement> {
  renderScreen({ fetchRounds: fakeLoad(LOADED).load, ...fakes });
  return screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
}

/** A group of round r1 by its title. */
function groupRegion(name: string): HTMLElement {
  return within(roundRegion()).getByRole('region', { name });
}

/** The customers' names in a group, from their cards' headings, in order. */
function namesIn(group: HTMLElement): string[] {
  return within(group)
    .queryAllByRole('heading', { level: 4 })
    .map((heading) => heading.textContent ?? '');
}

/** The card (list item) of the customer named `name`, found by its heading. */
function cardOf(name: string): HTMLElement {
  const card = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByRole('heading', { level: 4, name }) !== null);
  if (card === undefined) throw new Error(`no card for ${name}`);
  return card;
}

/** The customers' names on round r1's route, from its stop cards' headings, in screen order. */
function stopNames(): string[] {
  // The route is three lists (current, upcoming, handled), but the cards are the region's h3s.
  return within(roundRegion())
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent ?? '');
}

/**
 * Opens the round picker through its button (named after the round on screen, dated
 * `shownDayMonth`) and taps the row of the round dated `dayMonth`; the sheet closes itself.
 */
function pickRound(shownDayMonth: string, dayMonth: string): void {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^${ROUND_PICKER_TRIGGER_PREFIX}${shownDayMonth}`),
    }),
  );
  const sheet = screen.getByRole('dialog', { name: ROUND_PICKER_TITLE });
  fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(dayMonth) }));
}

/** The page has exactly one h1, and it is the tab's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
}

describe('roundGroupsSummary', () => {
  it('counts each group in words, in screen order', () => {
    expect(roundGroupsSummary(VIEW.groups)).toBe('בסבב: 3 · ביקשו מועד אחר: 1');
  });

  it('keeps the screen order whatever the order given', () => {
    const groups = [
      { key: 'otherDate' as const, orders: [RACHEL] },
      { key: 'inRound' as const, orders: [DANA, MOSHE] },
    ];
    expect(roundGroupsSummary(groups)).toBe('בסבב: 2 · ביקשו מועד אחר: 1');
  });

  it('counts a missing group as none', () => {
    expect(roundGroupsSummary([{ key: 'otherDate', orders: [RACHEL] }])).toBe(
      'בסבב: 0 · ביקשו מועד אחר: 1',
    );
  });
});

describe('RoundsScreen', () => {
  // The selected round lives in the URL (`?round=`): do not let one test's query reach the next.
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('tells the notice the planning screen sent along, once', async () => {
    window.history.replaceState({ notice: 'הסבב נוצר.' }, '', '/app/rounds');
    // Not renderScreen: it would replace the history state that carries the notice.
    renderWithApi(<RoundsScreen />, defaultFakes());

    const notice = await screen.findByText('הסבב נוצר.');
    expect(notice.getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(window.history.state).toBeNull();
    await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
  });

  describe('while the rounds load', () => {
    it('shows the heading and a loading status, nothing else', () => {
      renderScreen({ fetchRounds: () => deferred<RoundsOutcome>().promise });

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('region')).toBeNull();
      expect(screen.queryByText(NO_OPEN_ROUND_TEXT)).toBeNull();
    });
  });

  describe('with no open round', () => {
    it('says so and links to the planning screen', async () => {
      renderScreen({ fetchRounds: fakeLoad(NO_ROUNDS).load });

      expect(await screen.findByText('אין סבב פתוח.')).toBeDefined();
      expectOneH1();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('region')).toBeNull();
      const plan = screen.getByRole('link', { name: 'תכנון סבב' });
      expect(plan.getAttribute('href')).toBe('/app/orders/plan');

      fireEvent.click(plan);

      expect(window.location.pathname).toBe('/app/orders/plan');
    });
  });

  describe('with an open round', () => {
    it('heads the round with its half of the city and its day, the day left to right', async () => {
      const round = await renderLoaded();

      expectOneH1();
      expect(screen.queryByRole('status')).toBeNull();
      const heading = within(round).getByRole('heading', { level: 2 });
      expect(heading.textContent).toBe('רמת בית שמש · 19/11');
      expect(within(heading).getByText('19/11').closest('[dir="ltr"]')).not.toBeNull();
      // No "plan a round" link while one is open.
      expect(screen.queryByText(NO_OPEN_ROUND_TEXT)).toBeNull();
    });

    it('shows the pickup time and the personal text that went into the messages', async () => {
      const round = await renderLoaded();

      const pickup = within(round).getByText(/^להוציא את הבקבוקים עד/);
      expect(pickup.textContent).toBe('להוציא את הבקבוקים עד 08:30');
      expect(within(pickup).getByText('08:30').closest('[dir="ltr"]')).not.toBeNull();
      expect(within(round).getByText(/^טקסט אישי:/).textContent).toBe('טקסט אישי: תודה רבה!\nיואל');
    });

    it('shows the start as the time to put the bottles out by, then the window Yoel comes in', async () => {
      const view = makeView({ round: { pickupFrom: '07:00' }, inRound: [MOSHE] });
      const round = await renderLoaded({
        fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load,
      });

      const pickup = within(round).getByText(/^להוציא את הבקבוקים עד/);
      expect(pickup.textContent).toBe('להוציא את הבקבוקים עד 07:00 · מגיעים בין 07:00 ל-08:30');
      const starts = within(pickup).getAllByText('07:00');
      expect(starts).toHaveLength(2);
      for (const start of starts) expect(start.closest('[dir="ltr"]')).not.toBeNull();
      expect(within(pickup).getByText('08:30').closest('[dir="ltr"]')).not.toBeNull();
    });

    it('leaves out the pickup time and the personal text when the round has none', async () => {
      const view = makeView({
        round: { pickupBy: undefined, personalText: undefined },
        inRound: [MOSHE],
      });
      const round = await renderLoaded({
        fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load,
      });

      expect(within(round).queryByText(/להוציא/)).toBeNull();
      expect(within(round).queryByText(/טקסט אישי/)).toBeNull();
    });

    it('says in words how many are in the round and how many asked for another date', async () => {
      const round = await renderLoaded();

      expect(within(round).getByText('בסבב: 3 · ביקשו מועד אחר: 1')).toBeDefined();
    });

    it('puts the details in one card with two count tiles, hidden from screen readers', async () => {
      const round = await renderLoaded();

      const details = round.querySelector('.card.round-details');
      if (details === null) throw new Error('no details card');
      expect(details.contains(within(round).getByRole('heading', { level: 2 }))).toBe(true);
      expect(within(details as HTMLElement).getByText(/טקסט אישי/)).toBeDefined();
      const tiles = details.querySelector('.round-tiles');
      expect(tiles?.getAttribute('aria-hidden')).toBe('true');
      expect(
        [...(tiles?.querySelectorAll('.round-tile') ?? [])].map((tile) => [
          tile.className,
          tile.querySelector('b')?.textContent,
          tile.querySelector('span')?.textContent,
        ]),
      ).toEqual([
        ['round-tile round-tile-green', '3', 'בסבב'],
        ['round-tile round-tile-gray', '1', 'ביקשו מועד אחר'],
      ]);
    });

    it("shows each group's count as a badge next to its title, 0 for an empty group", async () => {
      const view = makeView({ inRound: [DANA, MOSHE, YOSSI] });
      await renderLoaded({ fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load });

      const badgeOf = (name: string) => groupRegion(name).querySelector('.group-head .badge');
      expect(badgeOf('בסבב')?.textContent).toBe('3');
      expect(badgeOf('בסבב')?.className).toContain('badge-green');
      expect(badgeOf('ביקשו מועד אחר')?.textContent).toBe('0');
      expect(badgeOf('ביקשו מועד אחר')?.className).toContain('badge-gray');
      expect(badgeOf('בסבב')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('shows the two groups in order, each a region named by its title, with its count', async () => {
      const round = await renderLoaded();

      const groups = within(round).getAllByRole('region');
      expect(
        groups.map((group) => within(group).getByRole('heading', { level: 3 }).textContent),
      ).toEqual(['בסבב', 'ביקשו מועד אחר']);
      expect(within(groupRegion('בסבב')).getByText('3 הזמנות')).toBeDefined();
      expect(within(groupRegion('ביקשו מועד אחר')).getByText('הזמנה אחת')).toBeDefined();
    });

    it('puts each customer in the right group, a legacy pending one in "בסבב", in the order the api gave', async () => {
      await renderLoaded();

      expect(namesIn(groupRegion('בסבב'))).toEqual(['דנה כהן', 'משה לוי', 'יוסי מזרחי']);
      expect(namesIn(groupRegion('ביקשו מועד אחר'))).toEqual(['רחל אברהם']);
    });

    it('says "אין" in an empty group, with no list', async () => {
      const view = makeView({ inRound: [DANA, MOSHE] });
      await renderLoaded({ fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load });

      const otherDate = groupRegion('ביקשו מועד אחר');
      expect(within(otherDate).getByText('אין')).toBeDefined();
      expect(within(otherDate).queryByRole('list')).toBeNull();
    });

    it("shows a card's name, phone as a dialling link left to right, street and bottles", async () => {
      await renderLoaded();

      const card = cardOf('משה לוי');
      const phone = within(card).getByRole('link', { name: '052-7654321' });
      expect(phone.getAttribute('href')).toBe('tel:+972527654321');
      expect(phone.classList.contains('call-button')).toBe(true);
      expect(within(phone).getByText('052-7654321').closest('[dir="ltr"]')).not.toBeNull();
      expect(within(card).getByText("בית ג'מאל 5")).toBeDefined();
      expect(within(card).getByText('80 בקבוקים')).toBeDefined();
    });

    it('tags the card in "ביקשו מועד אחר" with the reason and the day, and "בלי מיקום" where due', async () => {
      await renderLoaded();

      expect(within(cardOf('רחל אברהם')).getByText('ביקש מועד אחר · 19/11')).toBeDefined();
      expect(screen.getAllByText('ביקש מועד אחר · 19/11')).toHaveLength(1);
      expect(within(cardOf('יוסי מזרחי')).getByText('בלי מיקום')).toBeDefined();
      expect(screen.getAllByText('בלי מיקום')).toHaveLength(1);
    });

    it('has no "אישר בשיחה או בהודעה" button: nobody confirms (ADR-0012)', async () => {
      await renderLoaded();

      expect(screen.queryByRole('button', { name: /אישר בשיחה או בהודעה/ })).toBeNull();
      for (const name of ['דנה כהן', 'משה לוי', 'יוסי מזרחי', 'רחל אברהם']) {
        expect(within(cardOf(name)).queryByRole('button')).toBeNull();
      }
    });

    it('has no round picker when only one round is open', async () => {
      await renderLoaded();

      expect(screen.queryByRole('button', { name: /^סבב: 19\/11/ })).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('with several open rounds', () => {
    it('shows only the nearest one, the first the api gave, and a picker for the rest', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load });

      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      const roundHeadings = screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      expect(roundHeadings).toEqual(['רמת בית שמש · 19/11']);
      expect(screen.queryByRole('region', { name: 'בית שמש · 26/11' })).toBeNull();
      expect(screen.getByRole('button', { name: /^סבב: 19\/11/ })).toBeDefined();
      // The default is not written to the URL: no query until Yoel picks.
      expect(window.location.search).toBe('');
    });

    it('shows the picked round alone and writes ?round= by replacing the history entry', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      const historyLength = window.history.length;

      pickRound('19/11', '26/11');

      expect(await screen.findByRole('region', { name: 'בית שמש · 26/11' })).toBeDefined();
      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
      expect(screen.getByRole('heading', { level: 4, name: 'שרה גולן' })).toBeDefined();
      expect(window.location.pathname).toBe('/app/rounds');
      expect(window.location.search).toBe('?round=r2');
      expect(window.history.length).toBe(historyLength);
      // The picker's button now names the round on screen.
      expect(screen.getByRole('button', { name: /^סבב: 26\/11/ })).toBeDefined();
    });

    it('keeps the path Yoel is on when it writes the query', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load }, { url: '/app/somewhere' });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });

      pickRound('19/11', '26/11');

      await screen.findByRole('region', { name: 'בית שמש · 26/11' });
      expect(window.location.pathname).toBe('/app/somewhere');
      expect(window.location.search).toBe('?round=r2');
    });

    it('opens on the round the URL names', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load }, { url: '/app/rounds?round=r2' });

      expect(await screen.findByRole('region', { name: 'בית שמש · 26/11' })).toBeDefined();
      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
    });

    it('falls back to the first round for an unknown ?round=, leaving the URL alone', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load }, { url: '/app/rounds?round=zzz' });

      expect(await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeDefined();
      expect(screen.queryByRole('region', { name: 'בית שמש · 26/11' })).toBeNull();
      expect(window.location.search).toBe('?round=zzz');
    });

    // The api answers one round; only that round is swapped, the other open round stays as loaded.
    it('swaps in only the round whose route was built, leaving the other open round as it was', async () => {
      const { buildRoute, calls } = fakeBuildRoute();
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load, buildRoute });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });

      fireEvent.click(screen.getByRole('button', { name: BUILD_ROUTE_LABEL }));
      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));
      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      expect(calls).toEqual(['r1']);

      pickRound('19/11', '26/11');

      const second = await screen.findByRole('region', { name: 'בית שמש · 26/11' });
      expect(within(second).getByRole('heading', { level: 4, name: 'שרה גולן' })).toBeDefined();
      expect(within(second).getByRole('button', { name: BUILD_ROUTE_LABEL })).toBeDefined();
    });

    it('follows a query that changes from outside, as the back button does', async () => {
      renderScreen({ fetchRounds: fakeLoad(LOADED_TWO).load });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });

      // The browser changed the URL (back or forward) and fires popstate; no navigate() call.
      window.history.pushState(null, '', '/app/rounds?round=r2');
      window.dispatchEvent(new PopStateEvent('popstate'));

      expect(await screen.findByRole('region', { name: 'בית שמש · 26/11' })).toBeDefined();
    });
  });

  describe('the "שלח" list', () => {
    it('has one "שלח" link per customer in the round, under "הודעות ללקוחות" and a hint', async () => {
      const round = await renderLoaded();

      expect(SEND_LIST_HEADING).toBe('הודעות ללקוחות');
      expect(
        within(round).getByRole('heading', { level: 3, name: SEND_LIST_HEADING }),
      ).toBeDefined();
      expect(within(round).queryByRole('heading', { name: 'בקשות אישור' })).toBeNull();
      expect(within(round).getByText(SEND_LIST_HINT)).toBeDefined();
      const sendLinks = within(round).getAllByRole('link', { name: /^שלח/ });
      expect(sendLinks.map((link) => link.getAttribute('href'))).toEqual([
        'https://wa.me/972501234567?text=x',
        'https://wa.me/972527654321?text=x',
        'https://wa.me/972501239999?text=x',
      ]);
      expect(screen.getByRole('link', { name: 'שלח לדנה כהן' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'שלח למשה לוי' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'שלח ליוסי מזרחי' })).toBeDefined();
    });

    it('stores the opening of a tapped row through markMessageOpened', async () => {
      const { markMessageOpened, calls } = fakeMarkOpened();
      await renderLoaded({ markMessageOpened });

      fireEvent.click(screen.getByRole('link', { name: 'שלח למשה לוי' }));

      expect(calls).toEqual([{ orderId: 'o2', messageIndex: 1 }]);
      expect(await screen.findByRole('link', { name: 'שלח שוב למשה לוי' })).toBeDefined();
    });

    it('says there is nothing to send, with no hint, when no customer is left in the round', async () => {
      const view = makeView({ otherDate: [RACHEL] });
      const round = await renderLoaded({
        fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load,
      });

      expect(within(round).getByText('אין הודעות לשליחה.')).toBeDefined();
      expect(within(round).queryByText(SEND_LIST_HINT)).toBeNull();
      expect(within(round).queryByRole('link', { name: /^שלח/ })).toBeNull();
    });
  });

  describe('"התחל מסלול"', () => {
    // VIEW has three customers in "בסבב": the route takes them all in.
    const QUESTION_OF_VIEW = 'המסלול יכלול 3 לקוחות. להתחיל מסלול?';

    /** Taps the button and returns the question that opens in its place. */
    function openQuestion(): HTMLElement {
      fireEvent.click(screen.getByRole('button', { name: BUILD_ROUTE_LABEL }));
      return screen.getByRole('group', { name: QUESTION_OF_VIEW });
    }

    it('ends a round in step 1, after its groups', async () => {
      const round = await renderLoaded();

      const button = within(round).getByRole('button', { name: 'התחל מסלול' });
      const lastGroup = groupRegion('ביקשו מועד אחר');
      // The button comes after the last group in the page.
      expect(lastGroup.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it('asks first, saying how many customers the route takes in, with the focus on the question', async () => {
      await renderLoaded();

      const question = openQuestion();

      expect(within(question).getByText(QUESTION_OF_VIEW)).toBe(document.activeElement);
      expect(within(question).getByRole('button', { name: 'כן, להתחיל' })).toBeDefined();
      expect(within(question).getByRole('button', { name: 'לא, עוד לא' })).toBeDefined();
      expect(screen.queryByRole('button', { name: BUILD_ROUTE_LABEL })).toBeNull();
    });

    it('closes on "לא, עוד לא" without building, the focus back on the button', async () => {
      const { buildRoute, calls } = fakeBuildRoute();
      await renderLoaded({ buildRoute });
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'לא, עוד לא' }));

      expect(screen.queryByRole('group')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: BUILD_ROUTE_LABEL }));
      expect(calls).toEqual([]);
    });

    it('builds once for a double tap, then shows the route in place of step 1', async () => {
      const answer = deferred<BuildRouteOutcome>();
      const { buildRoute, calls } = fakeBuildRoute(answer.promise);
      await renderLoaded({ buildRoute });
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));
      const busy = screen.getByRole('button', { name: 'מתחיל מסלול...' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByRole('button', { name: 'לא, עוד לא' }).getAttribute('aria-disabled')).toBe(
        'true',
      );
      fireEvent.click(busy);
      // "לא" does nothing while the build is on its way.
      fireEvent.click(screen.getByRole('button', { name: 'לא, עוד לא' }));

      expect(calls).toEqual(['r1']);

      answer.resolve({ kind: 'built', view: ROUTED });

      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      const round = roundRegion();
      expect(within(round).queryByRole('heading', { name: SEND_LIST_HEADING })).toBeNull();
      expect(within(round).queryByRole('region')).toBeNull();
      expect(within(round).queryByRole('button', { name: BUILD_ROUTE_LABEL })).toBeNull();
      expect(within(round).getByText('נאספו 0 מתוך 2 · נשארו 2')).toBeDefined();
      // The question Yoel answered is gone: the focus goes to the round's heading.
      expect(document.activeElement).toBe(within(round).getByRole('heading', { level: 2 }));
      expect(calls).toEqual(['r1']);
    });

    it('says the route was built already and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, { kind: 'loaded', rounds: [ROUTED] });
      await renderLoaded({
        fetchRounds: rounds.load,
        buildRoute: fakeBuildRoute({ kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed })
          .buildRoute,
      });
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.confirmationsClosed);
      await waitFor(() => expect(document.activeElement).toBe(notice));
      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      expect(rounds.calls()).toBe(2);
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    });

    it('says the round is gone and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, NO_ROUNDS);
      await renderLoaded({
        fetchRounds: rounds.load,
        buildRoute: fakeBuildRoute({ kind: 'notFound' }).buildRoute,
      });
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      expect((await screen.findByRole('alert')).textContent).toBe(ROUND_MESSAGES.roundNotFound);
      expect(await screen.findByText(NO_OPEN_ROUND_TEXT)).toBeDefined();
      expect(rounds.calls()).toBe(2);
    });

    it('says the build failed inside the question, which stays open for another try', async () => {
      const { buildRoute, calls } = fakeBuildRoute({ kind: 'failed' }, 'rejects', {
        kind: 'built',
        view: ROUTED,
      });
      const rounds = fakeLoad(LOADED);
      await renderLoaded({ fetchRounds: rounds.load, buildRoute });
      const question = openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      const alert = await within(question).findByRole('alert');
      expect(alert.textContent).toBe(BUILD_ROUTE_FAILED_MESSAGE);
      expect(BUILD_ROUTE_FAILED_MESSAGE).toBe('לא הצלחנו להתחיל את המסלול. נא לנסות שוב.');
      const yes = screen.getByRole('button', { name: 'כן, להתחיל' });
      expect(yes.getAttribute('aria-disabled')).toBeNull();
      expect(rounds.calls()).toBe(1);

      // A rejection is a failed build like any other.
      fireEvent.click(yes);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'כן, להתחיל' }).getAttribute('aria-disabled'),
        ).toBeNull(),
      );
      expect(within(screen.getByRole('group')).getByRole('alert').textContent).toBe(
        BUILD_ROUTE_FAILED_MESSAGE,
      );

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      expect(calls).toEqual(['r1', 'r1', 'r1']);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('clears the error when the question is closed and opened again', async () => {
      await renderLoaded({ buildRoute: fakeBuildRoute({ kind: 'failed' }).buildRoute });
      openQuestion();
      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));
      await screen.findByText(BUILD_ROUTE_FAILED_MESSAGE);

      fireEvent.click(screen.getByRole('button', { name: 'לא, עוד לא' }));
      openQuestion();

      expect(screen.queryByText(BUILD_ROUTE_FAILED_MESSAGE)).toBeNull();
    });

    it('goes to the login, replacing the screen, when the session ended', async () => {
      await renderLoaded({ buildRoute: fakeBuildRoute(LOGGED_OUT).buildRoute });
      const historyLength = window.history.length;
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });
  });

  describe('a routed round', () => {
    const LOADED_ROUTED: RoundsOutcome = { kind: 'loaded', rounds: [ROUTED] };

    it('shows its route in driving order, with no groups and no "שלח" list', async () => {
      const round = await renderLoaded({ fetchRounds: fakeLoad(LOADED_ROUTED).load });

      expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']);
      const card = screen.getByRole('heading', { level: 3, name: 'דנה כהן' }).closest('li');
      if (card === null) throw new Error('no card for דנה כהן');
      expect(within(card).getByRole('link', { name: 'נווט, דנה כהן' }).getAttribute('href')).toBe(
        wazeUrl(DANA.address),
      );
      // The round's heading and texts stay above the route.
      expect(within(round).getByRole('heading', { level: 2 }).textContent).toBe(
        'רמת בית שמש · 19/11',
      );
      expect(within(round).getByText(/^להוציא את הבקבוקים עד/)).toBeDefined();
      expect(within(round).queryByRole('heading', { name: SEND_LIST_HEADING })).toBeNull();
      expect(within(round).queryByRole('link', { name: /^שלח/ })).toBeNull();
      expect(within(round).queryByText(/^בסבב:/)).toBeNull();
      expect(within(round).queryByRole('button', { name: BUILD_ROUTE_LABEL })).toBeNull();
      // One live summary per round: the route's.
      expect(round.querySelectorAll('[aria-live]')).toHaveLength(1);
      // The route screen keeps its plain look: no details card, no count tiles.
      expect(round.querySelector('.round-details')).toBeNull();
      expect(round.querySelector('.round-tiles')).toBeNull();
      expect(round.querySelector('.round-pickup')).toBeNull();
      expectOneH1();
    });

    it('swaps in the round a stop action answers: "אספתי" shows its "שלח תודה" row', async () => {
      const saved = routedView([collected(stopOf(DANA)), stopOf(MOSHE)]);
      const { fakes, calls } = fakeStopActions({ kind: 'saved', view: saved });
      await renderLoaded({ fetchRounds: fakeLoad(LOADED_ROUTED).load, ...fakes });

      fireEvent.click(screen.getByRole('button', { name: 'אספתי, דנה כהן' }));
      fireEvent.click(screen.getByRole('button', { name: 'שמור' }));

      expect(
        await screen.findByRole('heading', { level: 4, name: SEND_THANKS_TITLE }),
      ).toBeDefined();
      // The field starts at the estimate, 40, and was saved as it was.
      expect(calls).toEqual([{ action: 'collect', roundId: 'r1', orderId: 'o1', arg: 40 }]);
      // Still to collect first, the handled stop at the end.
      expect(stopNames()).toEqual(['משה לוי', 'דנה כהן']);
      expect(screen.getByRole('link', { name: 'שלח לדנה כהן' })).toBeDefined();
      expect(within(roundRegion()).getByText('נאספו 1 מתוך 2 · נשארו 1')).toBeDefined();
    });

    it('says why and loads the rounds again when a stop action finds the screen out of date', async () => {
      const handledElsewhere = routedView([stopOf(DANA, { state: 'notFound' }), stopOf(MOSHE)]);
      const rounds = fakeLoad(LOADED_ROUTED, { kind: 'loaded', rounds: [handledElsewhere] });
      const { fakes } = fakeStopActions({ kind: 'stale', message: ROUND_MESSAGES.stopHandled });
      await renderLoaded({ fetchRounds: rounds.load, ...fakes });

      fireEvent.click(screen.getByRole('button', { name: 'עוד פעולות, דנה כהן' }));
      fireEvent.click(screen.getByRole('button', { name: 'לא נמצא' }));
      fireEvent.click(screen.getByRole('button', { name: 'כן, לא נמצא' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.stopHandled);
      await waitFor(() => expect(document.activeElement).toBe(notice));
      await waitFor(() => expect(stopNames()).toEqual(['משה לוי', 'דנה כהן']));
      expect(rounds.calls()).toBe(2);
    });

    it('does not reload on coming back while a quantity field is open, and does once it closes', async () => {
      const rounds = fakeLoad(LOADED_ROUTED);
      await renderLoaded({ fetchRounds: rounds.load });
      fireEvent.click(screen.getByRole('button', { name: 'אספתי, דנה כהן' }));
      fireEvent.change(screen.getByLabelText(BOTTLES_COLLECTED_LABEL), {
        target: { value: '35' },
      });

      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(1);
      // The field is still open with what Yoel typed.
      expect(screen.getByLabelText<HTMLInputElement>(BOTTLES_COLLECTED_LABEL).value).toBe('35');

      fireEvent.click(screen.getByRole('button', { name: 'ביטול' }));
      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(2);
    });

    it('reloads on coming back after Yoel switched rounds with a quantity field open', async () => {
      // The field belongs to the round that leaves the screen; it must not pause reloads for good.
      const routedSecond: RoundView = {
        ...routedView([stopOf(MOSHE)]),
        round: { ...ROUND, id: 'r2', date: '2026-11-26', region: 'old', phase: 'routed' },
      };
      const rounds = fakeLoad({ kind: 'loaded', rounds: [ROUTED, routedSecond] });
      renderScreen({ fetchRounds: rounds.load });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      fireEvent.click(screen.getByRole('button', { name: 'אספתי, דנה כהן' }));
      returnToApp();
      await settle();
      expect(rounds.calls()).toBe(1);

      pickRound('19/11', '26/11');
      await screen.findByRole('region', { name: 'בית שמש · 26/11' });
      expect(screen.queryByLabelText(BOTTLES_COLLECTED_LABEL)).toBeNull();
      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(2);
    });
  });

  // The close button reads "בטל את הסבב" while the round is confirming (VIEW) and "סיימתי את
  // הסבב" once it is routed (ROUTED); one api call behind both.
  describe('the close button', () => {
    /** The close texts of a round still confirming (VIEW) and of a routed one. */
    const CONFIRMING_TEXTS = CLOSE_ROUND_TEXTS.confirming;
    const ROUTED_TEXTS = CLOSE_ROUND_TEXTS.routed;
    const LOADED_ROUTED: RoundsOutcome = { kind: 'loaded', rounds: [ROUTED] };
    /**
     * Taps the close button of round r1 (confirming, "בטל את הסבב", unless `texts` says
     * otherwise) and returns the question that opens in its place.
     */
    function openCloseQuestion(texts = CONFIRMING_TEXTS): HTMLElement {
      fireEvent.click(within(roundRegion()).getByRole('button', { name: texts.label }));
      return screen.getByRole('group', {
        name: new RegExp(`${texts.question.replace('?', '\\?')}$`),
      });
    }

    /** True when `later` comes after `earlier` in the page. */
    function follows(earlier: Node, later: Node): boolean {
      return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    it('calls a round off in step 1, after "התחל מסלול"', async () => {
      const round = await renderLoaded();

      const close = within(round).getByRole('button', { name: 'בטל את הסבב' });
      expect(follows(within(round).getByRole('button', { name: BUILD_ROUTE_LABEL }), close)).toBe(
        true,
      );
    });

    it('ends a routed round, after its route', async () => {
      const round = await renderLoaded({ fetchRounds: fakeLoad(LOADED_ROUTED).load });

      const close = within(round).getByRole('button', { name: 'סיימתי את הסבב' });
      expect(follows(within(round).getByRole('list', { name: 'העצירה הנוכחית' }), close)).toBe(
        true,
      );
    });

    it('asks first, and closes once for a double tap, "מבטל סבב..." meanwhile', async () => {
      const answer = deferred<CloseRoundOutcome>();
      const { closeRound, calls } = fakeCloseRound(answer.promise);
      await renderLoaded({ closeRound });

      const question = openCloseQuestion();
      expect(within(question).getByText('3 לקוחות יחזרו לחכות לסבב הבא. לבטל את הסבב?')).toBe(
        document.activeElement,
      );
      expect(calls).toEqual([]);

      fireEvent.click(within(question).getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));
      const busy = within(question).getByRole('button', { name: CONFIRMING_TEXTS.busyLabel });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);

      expect(calls).toEqual(['r1']);
      answer.resolve({ kind: 'closed', view: closedView(VIEW) });
      await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
      expect(calls).toEqual(['r1']);
    });

    it('takes the closed round off the tab, says so with the focus there, and does not reload', async () => {
      const rounds = fakeLoad(LOADED_TWO);
      const { closeRound } = fakeCloseRound();
      renderScreen({ fetchRounds: rounds.load, closeRound });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      openCloseQuestion();

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_CLOSED_MESSAGE);
      expect(ROUND_CLOSED_MESSAGE).toBe('הסבב נסגר.');
      await waitFor(() => expect(document.activeElement).toBe(notice));
      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
      // The selection falls back to the round left, as it was, and the picker is gone: one round.
      const other = screen.getByRole('region', { name: 'בית שמש · 26/11' });
      expect(within(other).getByRole('heading', { level: 4, name: 'שרה גולן' })).toBeDefined();
      expect(screen.queryByRole('button', { name: /^סבב: 26\/11/ })).toBeNull();
      expect(screen.queryByText(NO_OPEN_ROUND_TEXT)).toBeNull();
      await settle();
      expect(rounds.calls()).toBe(1);
    });

    it('shows the other round after closing the one picked with ?round=', async () => {
      // r2 is the selected round; r1 is the one left when it closes, by the same fallback.
      const { closeRound, calls } = fakeCloseRound({ kind: 'closed', view: closedView(SECOND) });
      renderScreen(
        { fetchRounds: fakeLoad(LOADED_TWO).load, closeRound },
        { url: '/app/rounds?round=r2' },
      );
      await screen.findByRole('region', { name: 'בית שמש · 26/11' });
      // Round r2 is still confirming, so its close button is the "call off" one.
      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.label }));

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      expect((await screen.findByRole('alert')).textContent).toBe(ROUND_CLOSED_MESSAGE);
      expect(calls).toEqual(['r2']);
      expect(screen.getByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeDefined();
      expect(screen.queryByRole('region', { name: 'בית שמש · 26/11' })).toBeNull();
    });

    it('says no round is open, with the planning link, when the last one closed', async () => {
      await renderLoaded({ fetchRounds: fakeLoad(LOADED_ROUTED).load });
      openCloseQuestion(ROUTED_TEXTS);

      fireEvent.click(screen.getByRole('button', { name: ROUTED_TEXTS.yesLabel }));

      expect(await screen.findByText(NO_OPEN_ROUND_TEXT)).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe(ROUND_CLOSED_MESSAGE);
      expect(screen.getByRole('link', { name: 'תכנון סבב' })).toBeDefined();
      expect(screen.queryByRole('region')).toBeNull();
    });

    it('does not bring the round back when a reload that set out before the close answers', async () => {
      const reload = deferred<RoundsOutcome>();
      const rounds = fakeLoad(LOADED_TWO, reload.promise);
      renderScreen({ fetchRounds: rounds.load, closeRound: fakeCloseRound().closeRound });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      returnToApp();
      expect(rounds.calls()).toBe(2);
      openCloseQuestion();
      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));
      await screen.findByText(ROUND_CLOSED_MESSAGE);

      // Its answer was read before the close: round r1 is still in it.
      reload.resolve(LOADED_TWO);
      await settle();

      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
      expect(screen.getByRole('region', { name: 'בית שמש · 26/11' })).toBeDefined();
      // Nor does the next reload.
      returnToApp();
      await settle();
      expect(rounds.calls()).toBe(3);
      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
    });

    it('says the close failed inside the question, which stays open for another "כן"', async () => {
      const { closeRound, calls } = fakeCloseRound({ kind: 'failed' }, 'rejects', {
        kind: 'closed',
        view: closedView(VIEW),
      });
      const rounds = fakeLoad(LOADED);
      await renderLoaded({ fetchRounds: rounds.load, closeRound });
      const question = openCloseQuestion();

      fireEvent.click(within(question).getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      expect((await within(question).findByRole('alert')).textContent).toBe(
        CONFIRMING_TEXTS.failedMessage,
      );
      const yes = within(question).getByRole('button', { name: CONFIRMING_TEXTS.yesLabel });
      expect(yes.getAttribute('aria-disabled')).toBeNull();
      expect(roundRegion()).toBeDefined();
      expect(rounds.calls()).toBe(1);

      // A rejection is a failed close like any other.
      fireEvent.click(yes);
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: CONFIRMING_TEXTS.yesLabel })
            .getAttribute('aria-disabled'),
        ).toBeNull(),
      );
      expect(within(screen.getByRole('group')).getByRole('alert').textContent).toBe(
        CONFIRMING_TEXTS.failedMessage,
      );

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      expect(await screen.findByText(NO_OPEN_ROUND_TEXT)).toBeDefined();
      expect(calls).toEqual(['r1', 'r1', 'r1']);
    });

    it('says the round is gone and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, NO_ROUNDS);
      await renderLoaded({
        fetchRounds: rounds.load,
        closeRound: fakeCloseRound({ kind: 'notFound' }).closeRound,
      });
      openCloseQuestion();

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.roundNotFound);
      await waitFor(() => expect(document.activeElement).toBe(notice));
      expect(await screen.findByText(NO_OPEN_ROUND_TEXT)).toBeDefined();
      expect(rounds.calls()).toBe(2);
    });

    it('goes to the login, replacing the screen, when the session ended', async () => {
      await renderLoaded({ closeRound: fakeCloseRound(LOGGED_OUT).closeRound });
      const historyLength = window.history.length;
      openCloseQuestion();

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<CloseRoundOutcome>();
      const { unmount } = renderScreen({
        fetchRounds: fakeLoad(LOADED).load,
        closeRound: fakeCloseRound(answer.promise).closeRound,
      });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      openCloseQuestion();
      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));
      unmount();
      window.history.replaceState(null, '', '/app/orders');

      answer.resolve(LOGGED_OUT);
      await settle();

      expect(window.location.pathname).toBe('/app/orders');
    });

    it('lists the unsent thank-yous of a routed round above its question', async () => {
      const view = routedView([collected(stopOf(DANA)), stopOf(MOSHE)]);
      await renderLoaded({ fetchRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load });

      const question = openCloseQuestion(ROUTED_TEXTS);

      const title = within(question).getByRole('heading', { name: UNSENT_THANK_YOUS_TITLE });
      expect(document.activeElement).toBe(title);
      expect(
        within(question).getByRole('link', { name: 'שלח לדנה כהן' }).getAttribute('href'),
      ).toBe('https://wa.me/972501234567?text=thanks');
      expect(
        within(question).getByText(
          'לקוח אחד שעוד לא אספנו ממנו יחזור לחכות לסבב הבא. לסיים את הסבב?',
        ),
      ).toBeDefined();
    });

    it('keeps an open question, and its focus, when a reload shows the round routed', async () => {
      const reload = deferred<RoundsOutcome>();
      await renderLoaded({ fetchRounds: fakeLoad(LOADED, reload.promise).load });
      openCloseQuestion();
      returnToApp();

      // The route was built on another phone meanwhile.
      reload.resolve(LOADED_ROUTED);

      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      const question = screen.getByRole('group', { name: /לסיים את הסבב\?$/ });
      // The question now counts the route's stops, and keeps the focus Yoel left there.
      const text = within(question).getByText(
        '2 לקוחות שעוד לא אספנו מהם יחזרו לחכות לסבב הבא. לסיים את הסבב?',
      );
      expect(document.activeElement).toBe(text);
    });
  });

  describe('logged out', () => {
    it('goes to the login in place of the rounds tab', async () => {
      const historyLength = window.history.length;
      renderScreen({ fetchRounds: fakeLoad(LOGGED_OUT).load });

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      // Replaced, not pushed: "back" from the login does not bounce off the tab again.
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<RoundsOutcome>();
      const { unmount } = renderScreen({ fetchRounds: () => answer.promise });
      unmount();
      window.history.replaceState(null, '', '/app/orders');

      answer.resolve(LOGGED_OUT);
      await settle();

      expect(window.location.pathname).toBe('/app/orders');
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, and stays on the tab', async () => {
      renderScreen({ fetchRounds: fakeLoad(FAILED).load });

      expect((await screen.findByRole('alert')).textContent).toBe(ROUNDS_LOAD_FAILED_MESSAGE);
      expect(ROUNDS_LOAD_FAILED_MESSAGE).toBe(
        'לא הצלחנו לטעון את הסבבים. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expectOneH1();
      expect(screen.getByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(screen.queryByRole('region')).toBeNull();
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('treats a rejected load like a failed one', async () => {
      renderScreen({ fetchRounds: fakeLoad('rejects').load });

      expect((await screen.findByRole('alert')).textContent).toBe(ROUNDS_LOAD_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('loads again on "לנסות שוב", and shows the rounds when that load succeeds', async () => {
      const second = deferred<RoundsOutcome>();
      const rounds = fakeLoad(FAILED, second.promise);
      renderScreen({ fetchRounds: rounds.load });
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(rounds.calls()).toBe(2);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();
      expectOneH1();

      second.resolve(LOADED);

      expect(await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לנסות שוב' })).toBeNull();
    });
  });

  describe('coming back to the app', () => {
    it('loads the rounds again, keeping them on screen until the answer replaces them', async () => {
      const reload = deferred<RoundsOutcome>();
      const rounds = fakeLoad(LOADED, reload.promise);
      await renderLoaded({ fetchRounds: rounds.load });

      returnToApp();

      expect(rounds.calls()).toBe(2);
      // No "טוען..." in place of the rounds while the new answer is on its way.
      expect(screen.queryByRole('status')).toBeNull();
      expect(namesIn(groupRegion('בסבב'))).toEqual(['דנה כהן', 'משה לוי', 'יוסי מזרחי']);

      // משה tapped "לא מתאים הפעם" through his WhatsApp link meanwhile.
      reload.resolve({ kind: 'loaded', rounds: [VIEW_MOSHE_DECLINED] });

      await waitFor(() =>
        expect(namesIn(groupRegion('ביקשו מועד אחר'))).toEqual(['רחל אברהם', 'משה לוי']),
      );
      expect(namesIn(groupRegion('בסבב'))).toEqual(['דנה כהן', 'יוסי מזרחי']);
      expect(screen.queryByRole('link', { name: /למשה לוי$/ })).toBeNull();
    });

    it('keeps the "שלח" rows Yoel opened marked when he is back from WhatsApp', async () => {
      const rounds = fakeLoad(LOADED);
      await renderLoaded({ fetchRounds: rounds.load });
      fireEvent.click(screen.getByRole('link', { name: 'שלח למשה לוי' }));
      await screen.findByRole('link', { name: 'שלח שוב למשה לוי' });

      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(2);
      // LOADED's row for משה has no openedAt: the mark is the list's own state, kept.
      expect(screen.getByRole('link', { name: 'שלח שוב למשה לוי' })).toBeDefined();
    });

    it('keeps the notice of a refused "התחל מסלול"', async () => {
      const rounds = fakeLoad(LOADED);
      await renderLoaded({
        fetchRounds: rounds.load,
        buildRoute: fakeBuildRoute({ kind: 'notFound' }).buildRoute,
      });
      fireEvent.click(screen.getByRole('button', { name: BUILD_ROUTE_LABEL }));
      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));
      await screen.findByText(ROUND_MESSAGES.roundNotFound);
      await settle();

      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(3);
      expect(screen.getByRole('alert').textContent).toBe(ROUND_MESSAGES.roundNotFound);
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const rounds = fakeLoad(LOGGED_OUT, LOADED);
      renderScreen({ fetchRounds: rounds.load }, { strict: true });

      expect(await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeDefined();
      expect(rounds.calls()).toBe(2);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('still shows the answer of "התחל מסלול"', async () => {
      const { buildRoute, calls } = fakeBuildRoute();
      renderScreen({ fetchRounds: fakeLoad(LOADED).load, buildRoute }, { strict: true });

      fireEvent.click(await screen.findByRole('button', { name: BUILD_ROUTE_LABEL }));
      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      expect(calls).toHaveLength(1);
    });
  });
});
