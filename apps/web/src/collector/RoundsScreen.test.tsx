import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ROUND_MESSAGES,
  type CollectorOrder,
  type CollectorRound,
  type MessageLink,
  type RoundView,
  type RouteStopView,
} from '@bottlerun/shared';
import type {
  BuildRouteOutcome,
  CloseRoundOutcome,
  ConfirmByPhoneOutcome,
  MarkMessageOpenedOutcome,
  RoundsOutcome,
  StopActionOutcome,
} from '../api.ts';
import { BUILD_ROUTE_FAILED_MESSAGE, BUILD_ROUTE_LABEL } from './BuildRouteConfirm.tsx';
import { CLOSE_ROUND_TEXTS, UNSENT_THANK_YOUS_TITLE } from './CloseRoundConfirm.tsx';
import {
  CONFIRM_FAILED_MESSAGE,
  NO_OPEN_ROUND_TEXT,
  ORDER_LEFT_ROUND_MESSAGE,
  ROUNDS_LOAD_FAILED_MESSAGE,
  ROUND_CLOSED_MESSAGE,
  RoundsScreen,
  SEND_LIST_HINT,
  confirmationSummary,
  type RoundsScreenProps,
} from './RoundsScreen.tsx';
import { wazeUrl } from './routeStops.ts';
import { BOTTLES_COLLECTED_LABEL, SEND_THANKS_TITLE } from './StopCard.tsx';
import { returnToApp } from './visibilityTestHelper.ts';

/** An order in round r1 still waiting for its confirmation, in רמת בית שמש; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
    },
    bottlesEstimated: 40,
    status: 'pending',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

/** Confirmed already. */
const DANA = makeOrder({ status: 'confirmed' });
/** Not confirmed yet. */
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
/** Not confirmed yet, and no map point: its card has "בלי מיקום". */
const YOSSI = makeOrder({
  id: 'o4',
  contact: { name: 'יוסי מזרחי', phone: '+972501239999' },
  address: { streetCode: 101, streetName: 'הרצל', houseNumber: '3', bottlesSpot: 'privateHouse' },
  bottlesEstimated: 50,
  hasLocation: false,
});
/** Asked for another date: out of the round, waiting again, with the miss of this round. */
const RACHEL = makeOrder({
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

/** The "שלח" row of `order`'s confirmation request. */
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
 * A round's view as the api builds it: the three groups in order, and by default one "שלח" row
 * per order not confirmed yet.
 */
function makeView({
  round = {},
  confirmed = [],
  pending = [],
  otherDate = [],
  sendList = pending.map(sendRowOf),
}: {
  round?: Partial<CollectorRound>;
  confirmed?: CollectorOrder[];
  pending?: CollectorOrder[];
  otherDate?: CollectorOrder[];
  sendList?: MessageLink[];
}): RoundView {
  return {
    round: { ...ROUND, ...round },
    groups: [
      { key: 'confirmed', orders: confirmed },
      { key: 'pending', orders: pending },
      { key: 'otherDate', orders: otherDate },
    ],
    sendList,
    stops: [],
  };
}

/** Round r1 with a customer in each group, two not confirmed yet. */
const VIEW = makeView({ confirmed: [DANA], pending: [MOSHE, YOSSI], otherDate: [RACHEL] });
/** VIEW after "אישר בשיחה או בהודעה" for משה: he is in "אישרו" and has no "שלח" row any more. */
const VIEW_MOSHE_CONFIRMED = makeView({
  confirmed: [DANA, { ...MOSHE, status: 'confirmed' }],
  pending: [YOSSI],
  otherDate: [RACHEL],
});

const LOADED: RoundsOutcome = { kind: 'loaded', rounds: [VIEW] };
const NO_ROUNDS: RoundsOutcome = { kind: 'loaded', rounds: [] };
const LOGGED_OUT = { kind: 'loggedOut' } as const;
const FAILED = { kind: 'failed' } as const;

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

/** A fake `loadRounds` (answers {@link LOADED} when given nothing). */
function fakeLoad(...answers: Answer<RoundsOutcome>[]): {
  load: () => Promise<RoundsOutcome>;
  calls: () => number;
} {
  let calls = 0;
  const load = (): Promise<RoundsOutcome> => answerOf(answers, calls++, LOADED);
  return { load, calls: () => calls };
}

/** A fake `confirmByPhone` that records its calls (answers {@link VIEW_MOSHE_CONFIRMED}). */
function fakeConfirm(...answers: Answer<ConfirmByPhoneOutcome>[]): {
  confirmByPhone: NonNullable<RoundsScreenProps['confirmByPhone']>;
  calls: { roundId: string; orderId: string }[];
} {
  const calls: { roundId: string; orderId: string }[] = [];
  const confirmByPhone = (roundId: string, orderId: string) => {
    calls.push({ roundId, orderId });
    return answerOf(answers, calls.length - 1, {
      kind: 'confirmed' as const,
      view: VIEW_MOSHE_CONFIRMED,
    });
  };
  return { confirmByPhone, calls };
}

/** A fake `markOpened` that records its calls and answers `marked` on 20/10. */
function fakeMarkOpened(): {
  markOpened: NonNullable<RoundsScreenProps['markOpened']>;
  calls: { orderId: string; messageIndex: number }[];
} {
  const calls: { orderId: string; messageIndex: number }[] = [];
  const markOpened = (orderId: string, messageIndex: number) => {
    calls.push({ orderId, messageIndex });
    const outcome: MarkMessageOpenedOutcome = {
      kind: 'marked',
      openedAt: new Date('2026-10-20T07:30:00Z'),
    };
    return Promise.resolve(outcome);
  };
  return { markOpened, calls };
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

/** VIEW after "התחל מסלול": משה and יוסי went back to waiting; דנה is the route. */
const ROUTED = routedView([stopOf(DANA), stopOf(MOSHE)]);

/** A fake `buildRoute` that records its calls (answers built {@link ROUTED}). */
function fakeBuildRoute(...answers: Answer<BuildRouteOutcome>[]): {
  buildRoute: NonNullable<RoundsScreenProps['buildRoute']>;
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
  closeRound: NonNullable<RoundsScreenProps['closeRound']>;
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
  props: Pick<RoundsScreenProps, 'moveStop' | 'collectStop' | 'markStopNotFound'>;
  calls: StopCall[];
} {
  const calls: StopCall[] = [];
  const answer = (call: StopCall) => {
    calls.push(call);
    return answerOf(answers, calls.length - 1, { kind: 'failed' as const });
  };
  return {
    calls,
    props: {
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
 * Opens the rounds tab at /app/rounds. The fakes not given are ones that would fail the test if
 * the screen used them by mistake through the real api (jsdom has no server).
 */
function renderScreen(
  props: RoundsScreenProps,
  { strict = false }: { strict?: boolean } = {},
): { unmount: () => void } {
  window.history.replaceState(null, '', '/app/rounds');
  const stopActions = fakeStopActions().props;
  const screenElement = (
    <RoundsScreen
      loadRounds={props.loadRounds ?? fakeLoad().load}
      confirmByPhone={props.confirmByPhone ?? fakeConfirm().confirmByPhone}
      buildRoute={props.buildRoute ?? fakeBuildRoute().buildRoute}
      closeRound={props.closeRound ?? fakeCloseRound().closeRound}
      moveStop={props.moveStop ?? stopActions.moveStop}
      collectStop={props.collectStop ?? stopActions.collectStop}
      markStopNotFound={props.markStopNotFound ?? stopActions.markStopNotFound}
      markOpened={props.markOpened ?? fakeMarkOpened().markOpened}
    />
  );
  return render(strict ? <StrictMode>{screenElement}</StrictMode> : screenElement);
}

/** The region of round r1 on 19/11. */
function roundRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'רמת בית שמש · 19/11' });
}

/** Renders `props` with {@link LOADED} by default, and waits for round r1. */
async function renderLoaded(props: RoundsScreenProps = {}): Promise<HTMLElement> {
  renderScreen({ loadRounds: fakeLoad(LOADED).load, ...props });
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
  const route = within(roundRegion()).getByRole('list', { name: 'עצירות המסלול' });
  return within(route)
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent ?? '');
}

/** The page has exactly one h1, and it is the tab's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
}

describe('confirmationSummary', () => {
  it('counts each group in words, in screen order', () => {
    expect(confirmationSummary(VIEW.groups)).toBe('אישרו: 1 · עוד לא אישרו: 2 · ביקשו מועד אחר: 1');
  });

  it('counts a missing group as none, and keeps the order whatever the order given', () => {
    const groups = [
      { key: 'pending' as const, orders: [MOSHE] },
      { key: 'confirmed' as const, orders: [DANA, YOSSI] },
    ];
    expect(confirmationSummary(groups)).toBe('אישרו: 2 · עוד לא אישרו: 1 · ביקשו מועד אחר: 0');
  });
});

describe('RoundsScreen', () => {
  it('tells the notice the planning screen sent along, once', async () => {
    window.history.replaceState({ notice: 'הסבב נוצר.' }, '', '/app/rounds');
    render(
      <RoundsScreen
        loadRounds={fakeLoad(LOADED).load}
        confirmByPhone={fakeConfirm().confirmByPhone}
        markOpened={fakeMarkOpened().markOpened}
      />,
    );

    const notice = await screen.findByText('הסבב נוצר.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(notice);
    expect(window.history.state).toBeNull();
    await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
  });

  describe('while the rounds load', () => {
    it('shows the heading and a loading status, nothing else', () => {
      renderScreen({ loadRounds: () => deferred<RoundsOutcome>().promise });

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('region')).toBeNull();
      expect(screen.queryByText(NO_OPEN_ROUND_TEXT)).toBeNull();
    });
  });

  describe('with no open round', () => {
    it('says so and links to the planning screen', async () => {
      renderScreen({ loadRounds: fakeLoad(NO_ROUNDS).load });

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

    it('shows the pickup time and the personal text that went into the requests', async () => {
      const round = await renderLoaded();

      const pickup = within(round).getByText(/^להוציא את הבקבוקים עד/);
      expect(pickup.textContent).toBe('להוציא את הבקבוקים עד 08:30');
      expect(within(pickup).getByText('08:30').closest('[dir="ltr"]')).not.toBeNull();
      expect(within(round).getByText(/^טקסט אישי:/).textContent).toBe('טקסט אישי: תודה רבה!\nיואל');
    });

    it('leaves out the pickup time and the personal text when the round has none', async () => {
      const view = makeView({
        round: { pickupBy: undefined, personalText: undefined },
        pending: [MOSHE],
      });
      const round = await renderLoaded({
        loadRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load,
      });

      expect(within(round).queryByText(/להוציא/)).toBeNull();
      expect(within(round).queryByText(/טקסט אישי/)).toBeNull();
    });

    it('says in words how many confirmed, did not yet, and asked for another date', async () => {
      const round = await renderLoaded();

      expect(
        within(round).getByText('אישרו: 1 · עוד לא אישרו: 2 · ביקשו מועד אחר: 1'),
      ).toBeDefined();
    });

    it('shows the three groups in order, each a region named by its title, with its count', async () => {
      const round = await renderLoaded();

      const groups = within(round).getAllByRole('region');
      expect(
        groups.map((group) => within(group).getByRole('heading', { level: 3 }).textContent),
      ).toEqual(['אישרו', 'עוד לא אישרו', 'ביקשו מועד אחר']);
      expect(within(groupRegion('אישרו')).getByText('הזמנה אחת')).toBeDefined();
      expect(within(groupRegion('עוד לא אישרו')).getByText('2 הזמנות')).toBeDefined();
      expect(within(groupRegion('ביקשו מועד אחר')).getByText('הזמנה אחת')).toBeDefined();
    });

    it('puts each customer in the right group, in the order the api gave', async () => {
      await renderLoaded();

      expect(namesIn(groupRegion('אישרו'))).toEqual(['דנה כהן']);
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['משה לוי', 'יוסי מזרחי']);
      expect(namesIn(groupRegion('ביקשו מועד אחר'))).toEqual(['רחל אברהם']);
    });

    it('says "אין" in an empty group, with no list', async () => {
      const view = makeView({ confirmed: [DANA], pending: [MOSHE] });
      await renderLoaded({ loadRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load });

      const otherDate = groupRegion('ביקשו מועד אחר');
      expect(within(otherDate).getByText('אין')).toBeDefined();
      expect(within(otherDate).queryByRole('list')).toBeNull();
    });

    it("shows a card's name, phone as a dialling link left to right, street and bottles", async () => {
      await renderLoaded();

      const card = cardOf('משה לוי');
      const phone = within(card).getByRole('link', { name: '052-7654321' });
      expect(phone.getAttribute('href')).toBe('tel:+972527654321');
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

    it('has "אישר בשיחה או בהודעה" on the cards not confirmed yet only, each named after its customer', async () => {
      await renderLoaded();

      const buttons = screen.getAllByRole('button', { name: /^אישר בשיחה או בהודעה/ });
      expect(buttons.map((button) => button.textContent)).toEqual([
        'אישר בשיחה או בהודעה, משה לוי',
        'אישר בשיחה או בהודעה, יוסי מזרחי',
      ]);
      for (const button of buttons) {
        expect(groupRegion('עוד לא אישרו').contains(button)).toBe(true);
      }
      expect(within(cardOf('דנה כהן')).queryByRole('button')).toBeNull();
      expect(within(cardOf('רחל אברהם')).queryByRole('button')).toBeNull();
    });

    it('shows each open round, in the order the api gave', async () => {
      const second = makeView({ round: { id: 'r2', date: '2026-11-26', region: 'old' } });
      renderScreen({ loadRounds: fakeLoad({ kind: 'loaded', rounds: [VIEW, second] }).load });

      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      const roundHeadings = screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      expect(roundHeadings).toEqual(['רמת בית שמש · 19/11', 'בית שמש · 26/11']);
    });
  });

  describe('the "שלח" list', () => {
    it('has one "שלח" link per customer not confirmed yet, under "בקשות אישור" and a hint', async () => {
      const round = await renderLoaded();

      expect(within(round).getByRole('heading', { level: 3, name: 'בקשות אישור' })).toBeDefined();
      expect(within(round).getByText(SEND_LIST_HINT)).toBeDefined();
      const sendLinks = within(round).getAllByRole('link', { name: /^שלח/ });
      expect(sendLinks.map((link) => link.getAttribute('href'))).toEqual([
        'https://wa.me/972527654321?text=x',
        'https://wa.me/972501239999?text=x',
      ]);
      expect(screen.getByRole('link', { name: 'שלח למשה לוי' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'שלח ליוסי מזרחי' })).toBeDefined();
    });

    it('stores the opening of a tapped row through markOpened', async () => {
      const { markOpened, calls } = fakeMarkOpened();
      await renderLoaded({ markOpened });

      fireEvent.click(screen.getByRole('link', { name: 'שלח למשה לוי' }));

      expect(calls).toEqual([{ orderId: 'o2', messageIndex: 1 }]);
      expect(await screen.findByRole('link', { name: 'שלח שוב למשה לוי' })).toBeDefined();
    });

    it('says there is nothing to send, with no hint, when everyone confirmed', async () => {
      const view = makeView({ confirmed: [DANA] });
      const round = await renderLoaded({
        loadRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load,
      });

      expect(within(round).getByText('אין הודעות לשליחה.')).toBeDefined();
      expect(within(round).queryByText(SEND_LIST_HINT)).toBeNull();
      expect(within(round).queryByRole('link', { name: /^שלח/ })).toBeNull();
    });
  });

  describe('"אישר בשיחה או בהודעה"', () => {
    it('confirms the order of the round, and moves the customer to "אישרו" out of the "שלח" list', async () => {
      const { confirmByPhone, calls } = fakeConfirm();
      await renderLoaded({ confirmByPhone });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      expect(calls).toEqual([{ roundId: 'r1', orderId: 'o2' }]);
      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toEqual(['דנה כהן', 'משה לוי']));
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['יוסי מזרחי']);
      expect(screen.queryByRole('link', { name: /למשה לוי$/ })).toBeNull();
      expect(screen.getByRole('link', { name: 'שלח ליוסי מזרחי' })).toBeDefined();
      expect(
        within(roundRegion()).getByText('אישרו: 2 · עוד לא אישרו: 1 · ביקשו מועד אחר: 1'),
      ).toBeDefined();
      expect(screen.queryByRole('button', { name: /משה לוי$/ })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says "שומר..." while saving and sends one request for a double tap', async () => {
      const answer = deferred<ConfirmByPhoneOutcome>();
      const { confirmByPhone, calls } = fakeConfirm(answer.promise);
      await renderLoaded({ confirmByPhone });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));
      const busy = screen.getByRole('button', { name: 'שומר..., משה לוי' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);

      expect(calls).toHaveLength(1);
      // Only that card is busy: another customer can be confirmed meanwhile.
      const yossi = screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, יוסי מזרחי' });
      expect(yossi.getAttribute('aria-disabled')).toBeNull();

      answer.resolve({ kind: 'confirmed', view: VIEW_MOSHE_CONFIRMED });

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      expect(calls).toHaveLength(1);
    });

    it('keeps the "שלח" rows Yoel opened marked when the round is swapped in', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('link', { name: 'שלח ליוסי מזרחי' }));
      await screen.findByRole('link', { name: 'שלח שוב ליוסי מזרחי' });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      // VIEW_MOSHE_CONFIRMED's row for יוסי has no openedAt: the mark is the list's own state.
      expect(screen.getByRole('link', { name: 'שלח שוב ליוסי מזרחי' })).toBeDefined();
    });

    it('swaps in only the round the api answered', async () => {
      const second = makeView({
        round: { id: 'r2', date: '2026-11-26', region: 'old' },
        pending: [makeOrder({ id: 'o9', contact: { name: 'שרה גולן', phone: '+972509998877' } })],
      });
      renderScreen({ loadRounds: fakeLoad({ kind: 'loaded', rounds: [VIEW, second] }).load });
      await screen.findByRole('region', { name: 'בית שמש · 26/11' });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      const other = screen.getByRole('region', { name: 'בית שמש · 26/11' });
      expect(
        within(other).getByRole('button', { name: 'אישר בשיחה או בהודעה, שרה גולן' }),
      ).toBeDefined();
    });

    it('says the confirmations closed, moves the focus there and loads the rounds again', async () => {
      const reload = deferred<RoundsOutcome>();
      const rounds = fakeLoad(LOADED, reload.promise);
      const closed: ConfirmByPhoneOutcome = {
        kind: 'closed',
        message: ROUND_MESSAGES.confirmationsClosed,
      };
      await renderLoaded({
        loadRounds: rounds.load,
        confirmByPhone: fakeConfirm(closed).confirmByPhone,
      });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe('האישורים לסבב הזה כבר נסגרו.');
      expect(document.activeElement).toBe(notice);
      expect(rounds.calls()).toBe(2);
      // The rounds stay on screen while they load again.
      expect(screen.queryByRole('status')).toBeNull();
      expect(roundRegion()).toBeDefined();

      // The round as it is now: its route built (on another phone), so משה left it and the
      // section shows the route in place of the confirmations.
      reload.resolve({ kind: 'loaded', rounds: [routedView([stopOf(DANA)])] });

      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן']));
      expect(screen.queryByRole('button', { name: /^אישר בשיחה או בהודעה/ })).toBeNull();
      // The notice Yoel was sent to keeps the focus: the round's heading does not take it.
      expect(document.activeElement).toBe(screen.getByRole('alert'));
      // The notice stays until Yoel does something else.
      expect(screen.getByRole('alert').textContent).toBe(ROUND_MESSAGES.confirmationsClosed);
    });

    it('says the order is no longer in the round and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, { kind: 'loaded', rounds: [makeView({ pending: [YOSSI] })] });
      await renderLoaded({
        loadRounds: rounds.load,
        confirmByPhone: fakeConfirm({ kind: 'notFound' }).confirmByPhone,
      });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LEFT_ROUND_MESSAGE);
      expect(ORDER_LEFT_ROUND_MESSAGE).toBe('ההזמנה כבר לא בסבב.');
      await waitFor(() => expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['יוסי מזרחי']));
      expect(rounds.calls()).toBe(2);
    });

    it('clears the notice at the next "אישר בשיחה או בהודעה"', async () => {
      const { confirmByPhone } = fakeConfirm({ kind: 'notFound' }, { kind: 'failed' });
      await renderLoaded({ confirmByPhone });
      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));
      await screen.findByText(ORDER_LEFT_ROUND_MESSAGE);
      await settle();

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, יוסי מזרחי' }));

      expect(screen.queryByText(ORDER_LEFT_ROUND_MESSAGE)).toBeNull();
    });

    it('says the save failed next to the card, and the button works again', async () => {
      const { confirmByPhone, calls } = fakeConfirm({ kind: 'failed' }, 'rejects');
      await renderLoaded({ confirmByPhone });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      const alert = await within(cardOf('משה לוי')).findByRole('alert');
      expect(alert.textContent).toBe(CONFIRM_FAILED_MESSAGE);
      expect(CONFIRM_FAILED_MESSAGE).toBe('לא הצלחנו לשמור. נא לנסות שוב.');
      expect(within(cardOf('יוסי מזרחי')).queryByRole('alert')).toBeNull();
      const button = screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' });
      expect(button.getAttribute('aria-disabled')).toBeNull();
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['משה לוי', 'יוסי מזרחי']);

      // A rejection is a failed save like any other.
      fireEvent.click(button);

      expect(calls).toHaveLength(2);
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' })
            .getAttribute('aria-disabled'),
        ).toBeNull(),
      );
      expect(within(cardOf('משה לוי')).getByRole('alert').textContent).toBe(CONFIRM_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('goes to the login, replacing the screen, when the session ended', async () => {
      await renderLoaded({ confirmByPhone: fakeConfirm(LOGGED_OUT).confirmByPhone });
      const historyLength = window.history.length;

      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<ConfirmByPhoneOutcome>();
      const { unmount } = renderScreen({
        loadRounds: fakeLoad(LOADED).load,
        confirmByPhone: fakeConfirm(answer.promise).confirmByPhone,
      });
      fireEvent.click(await screen.findByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));
      unmount();
      window.history.replaceState(null, '', '/app/orders');

      answer.resolve(LOGGED_OUT);
      await settle();

      expect(window.location.pathname).toBe('/app/orders');
    });
  });

  describe('"התחל מסלול"', () => {
    const QUESTION_OF_VIEW = '2 לקוחות שעוד לא אישרו יחזרו לחכות לסבב הבא. להתחיל מסלול?';

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

    it('asks first, saying how many go back to waiting, with the focus on the question', async () => {
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

    it('builds once for a double tap, then shows the route in place of the confirmations', async () => {
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
      expect(within(round).queryByRole('heading', { name: 'בקשות אישור' })).toBeNull();
      expect(within(round).queryByRole('region')).toBeNull();
      expect(within(round).queryByRole('button', { name: /^אישר בשיחה או בהודעה/ })).toBeNull();
      expect(within(round).queryByRole('button', { name: BUILD_ROUTE_LABEL })).toBeNull();
      expect(within(round).getByText('נאספו 0 מתוך 2 · נשארו 2')).toBeDefined();
      // The question Yoel answered is gone: the focus goes to the round's heading.
      expect(document.activeElement).toBe(within(round).getByRole('heading', { level: 2 }));
      expect(calls).toEqual(['r1']);
    });

    it('says the confirmations closed already and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, { kind: 'loaded', rounds: [ROUTED] });
      await renderLoaded({
        loadRounds: rounds.load,
        buildRoute: fakeBuildRoute({ kind: 'closed', message: ROUND_MESSAGES.confirmationsClosed })
          .buildRoute,
      });
      openQuestion();

      fireEvent.click(screen.getByRole('button', { name: 'כן, להתחיל' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.confirmationsClosed);
      expect(document.activeElement).toBe(notice);
      await waitFor(() => expect(stopNames()).toEqual(['דנה כהן', 'משה לוי']));
      expect(rounds.calls()).toBe(2);
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    });

    it('says the round is gone and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, NO_ROUNDS);
      await renderLoaded({
        loadRounds: rounds.load,
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
      await renderLoaded({ loadRounds: rounds.load, buildRoute });
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

    it('shows its route in driving order, with no confirmations and no "שלח" list', async () => {
      const round = await renderLoaded({ loadRounds: fakeLoad(LOADED_ROUTED).load });

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
      expect(within(round).queryByRole('heading', { name: 'בקשות אישור' })).toBeNull();
      expect(within(round).queryByRole('link', { name: /^שלח/ })).toBeNull();
      expect(within(round).queryByText(/^אישרו:/)).toBeNull();
      expect(within(round).queryByRole('button', { name: BUILD_ROUTE_LABEL })).toBeNull();
      // One live summary per round: the route's.
      expect(round.querySelectorAll('[aria-live]')).toHaveLength(1);
      expectOneH1();
    });

    it('swaps in the round a stop action answers: "אספתי" shows its "שלח תודה" row', async () => {
      const saved = routedView([collected(stopOf(DANA)), stopOf(MOSHE)]);
      const { props, calls } = fakeStopActions({ kind: 'saved', view: saved });
      await renderLoaded({ loadRounds: fakeLoad(LOADED_ROUTED).load, ...props });

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
      const { props } = fakeStopActions({ kind: 'stale', message: ROUND_MESSAGES.stopHandled });
      await renderLoaded({ loadRounds: rounds.load, ...props });

      fireEvent.click(screen.getByRole('button', { name: 'לא נמצא, דנה כהן' }));
      fireEvent.click(screen.getByRole('button', { name: 'כן, לא נמצא' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.stopHandled);
      expect(document.activeElement).toBe(notice);
      await waitFor(() => expect(stopNames()).toEqual(['משה לוי', 'דנה כהן']));
      expect(rounds.calls()).toBe(2);
    });

    it('does not reload on coming back while a quantity field is open, and does once it closes', async () => {
      const rounds = fakeLoad(LOADED_ROUTED);
      await renderLoaded({ loadRounds: rounds.load });
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
  });

  // The close button reads "בטל את הסבב" while the round is confirming (VIEW) and "סיימתי את
  // הסבב" once it is routed (ROUTED); one api call behind both.
  describe('the close button', () => {
    /** The close texts of a round still confirming (VIEW) and of a routed one. */
    const CONFIRMING_TEXTS = CLOSE_ROUND_TEXTS.confirming;
    const ROUTED_TEXTS = CLOSE_ROUND_TEXTS.routed;
    const LOADED_ROUTED: RoundsOutcome = { kind: 'loaded', rounds: [ROUTED] };
    /** Round r2, in the other half of the city, still confirming. */
    const SECOND = makeView({
      round: { id: 'r2', date: '2026-11-26', region: 'old' },
      pending: [makeOrder({ id: 'o9', contact: { name: 'שרה גולן', phone: '+972509998877' } })],
    });

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
      const round = await renderLoaded({ loadRounds: fakeLoad(LOADED_ROUTED).load });

      const close = within(round).getByRole('button', { name: 'סיימתי את הסבב' });
      expect(follows(within(round).getByRole('list', { name: 'עצירות המסלול' }), close)).toBe(true);
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
      const rounds = fakeLoad({ kind: 'loaded', rounds: [VIEW, SECOND] });
      const { closeRound } = fakeCloseRound();
      renderScreen({ loadRounds: rounds.load, closeRound });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      openCloseQuestion();

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_CLOSED_MESSAGE);
      expect(ROUND_CLOSED_MESSAGE).toBe('הסבב נסגר.');
      expect(document.activeElement).toBe(notice);
      expect(screen.queryByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeNull();
      // The other round stays as it was.
      const other = screen.getByRole('region', { name: 'בית שמש · 26/11' });
      expect(
        within(other).getByRole('button', { name: 'אישר בשיחה או בהודעה, שרה גולן' }),
      ).toBeDefined();
      expect(screen.queryByText(NO_OPEN_ROUND_TEXT)).toBeNull();
      await settle();
      expect(rounds.calls()).toBe(1);
    });

    it('says no round is open, with the planning link, when the last one closed', async () => {
      await renderLoaded({ loadRounds: fakeLoad(LOADED_ROUTED).load });
      openCloseQuestion(ROUTED_TEXTS);

      fireEvent.click(screen.getByRole('button', { name: ROUTED_TEXTS.yesLabel }));

      expect(await screen.findByText(NO_OPEN_ROUND_TEXT)).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe(ROUND_CLOSED_MESSAGE);
      expect(screen.getByRole('link', { name: 'תכנון סבב' })).toBeDefined();
      expect(screen.queryByRole('region')).toBeNull();
    });

    it('does not bring the round back when a reload that set out before the close answers', async () => {
      const reload = deferred<RoundsOutcome>();
      const rounds = fakeLoad({ kind: 'loaded', rounds: [VIEW, SECOND] }, reload.promise);
      renderScreen({ loadRounds: rounds.load, closeRound: fakeCloseRound().closeRound });
      await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' });
      returnToApp();
      expect(rounds.calls()).toBe(2);
      openCloseQuestion();
      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));
      await screen.findByText(ROUND_CLOSED_MESSAGE);

      // Its answer was read before the close: round r1 is still in it.
      reload.resolve({ kind: 'loaded', rounds: [VIEW, SECOND] });
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
      await renderLoaded({ loadRounds: rounds.load, closeRound });
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
        loadRounds: rounds.load,
        closeRound: fakeCloseRound({ kind: 'notFound' }).closeRound,
      });
      openCloseQuestion();

      fireEvent.click(screen.getByRole('button', { name: CONFIRMING_TEXTS.yesLabel }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe(ROUND_MESSAGES.roundNotFound);
      expect(document.activeElement).toBe(notice);
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
        loadRounds: fakeLoad(LOADED).load,
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
      await renderLoaded({ loadRounds: fakeLoad({ kind: 'loaded', rounds: [view] }).load });

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
      await renderLoaded({ loadRounds: fakeLoad(LOADED, reload.promise).load });
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
      renderScreen({ loadRounds: fakeLoad(LOGGED_OUT).load });

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      // Replaced, not pushed: "back" from the login does not bounce off the tab again.
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<RoundsOutcome>();
      const { unmount } = renderScreen({ loadRounds: () => answer.promise });
      unmount();
      window.history.replaceState(null, '', '/app/orders');

      answer.resolve(LOGGED_OUT);
      await settle();

      expect(window.location.pathname).toBe('/app/orders');
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, and stays on the tab', async () => {
      renderScreen({ loadRounds: fakeLoad(FAILED).load });

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
      renderScreen({ loadRounds: fakeLoad('rejects').load });

      expect((await screen.findByRole('alert')).textContent).toBe(ROUNDS_LOAD_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('loads again on "לנסות שוב", and shows the rounds when that load succeeds', async () => {
      const second = deferred<RoundsOutcome>();
      const rounds = fakeLoad(FAILED, second.promise);
      renderScreen({ loadRounds: rounds.load });
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
      await renderLoaded({ loadRounds: rounds.load });

      returnToApp();

      expect(rounds.calls()).toBe(2);
      // No "טוען..." in place of the rounds while the new answer is on its way.
      expect(screen.queryByRole('status')).toBeNull();
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['משה לוי', 'יוסי מזרחי']);

      // משה confirmed through his WhatsApp link meanwhile.
      reload.resolve({ kind: 'loaded', rounds: [VIEW_MOSHE_CONFIRMED] });

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toEqual(['דנה כהן', 'משה לוי']));
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['יוסי מזרחי']);
    });

    it('keeps the "שלח" rows Yoel opened marked when he is back from WhatsApp', async () => {
      const rounds = fakeLoad(LOADED);
      await renderLoaded({ loadRounds: rounds.load });
      fireEvent.click(screen.getByRole('link', { name: 'שלח למשה לוי' }));
      await screen.findByRole('link', { name: 'שלח שוב למשה לוי' });

      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(2);
      // LOADED's row for משה has no openedAt: the mark is the list's own state, kept.
      expect(screen.getByRole('link', { name: 'שלח שוב למשה לוי' })).toBeDefined();
    });

    it('keeps the notice of a refused "אישר בשיחה או בהודעה"', async () => {
      const rounds = fakeLoad(LOADED);
      await renderLoaded({
        loadRounds: rounds.load,
        confirmByPhone: fakeConfirm({ kind: 'notFound' }).confirmByPhone,
      });
      fireEvent.click(screen.getByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));
      await screen.findByText(ORDER_LEFT_ROUND_MESSAGE);
      await settle();

      returnToApp();
      await settle();

      expect(rounds.calls()).toBe(3);
      expect(screen.getByRole('alert').textContent).toBe(ORDER_LEFT_ROUND_MESSAGE);
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const rounds = fakeLoad(LOGGED_OUT, LOADED);
      renderScreen({ loadRounds: rounds.load }, { strict: true });

      expect(await screen.findByRole('region', { name: 'רמת בית שמש · 19/11' })).toBeDefined();
      expect(rounds.calls()).toBe(2);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('still shows the answer of "אישר בשיחה או בהודעה"', async () => {
      const { confirmByPhone, calls } = fakeConfirm();
      renderScreen({ loadRounds: fakeLoad(LOADED).load, confirmByPhone }, { strict: true });

      fireEvent.click(await screen.findByRole('button', { name: 'אישר בשיחה או בהודעה, משה לוי' }));

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      expect(calls).toHaveLength(1);
    });
  });
});
