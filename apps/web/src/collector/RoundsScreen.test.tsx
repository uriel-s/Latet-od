import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ROUND_MESSAGES,
  type CollectorOrder,
  type CollectorRound,
  type MessageLink,
  type RoundView,
} from '@bottlerun/shared';
import type { ConfirmByPhoneOutcome, MarkMessageOpenedOutcome, RoundsOutcome } from '../api.ts';
import {
  CONFIRM_FAILED_MESSAGE,
  NO_OPEN_ROUND_TEXT,
  ORDER_LEFT_ROUND_MESSAGE,
  ROUNDS_LOAD_FAILED_MESSAGE,
  RoundsScreen,
  SEND_LIST_HINT,
  confirmationSummary,
  type RoundsScreenProps,
} from './RoundsScreen.tsx';
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
  };
}

/** Round r1 with a customer in each group, two not confirmed yet. */
const VIEW = makeView({ confirmed: [DANA], pending: [MOSHE, YOSSI], otherDate: [RACHEL] });
/** VIEW after "אישר בטלפון" for משה: he is in "אישרו" and has no "שלח" row any more. */
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
  const screenElement = (
    <RoundsScreen
      loadRounds={props.loadRounds ?? fakeLoad().load}
      confirmByPhone={props.confirmByPhone ?? fakeConfirm().confirmByPhone}
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

    it('has "אישר בטלפון" on the cards not confirmed yet only, each named after its customer', async () => {
      await renderLoaded();

      const buttons = screen.getAllByRole('button', { name: /^אישר בטלפון/ });
      expect(buttons.map((button) => button.textContent)).toEqual([
        'אישר בטלפון, משה לוי',
        'אישר בטלפון, יוסי מזרחי',
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

  describe('"אישר בטלפון"', () => {
    it('confirms the order of the round, and moves the customer to "אישרו" out of the "שלח" list', async () => {
      const { confirmByPhone, calls } = fakeConfirm();
      await renderLoaded({ confirmByPhone });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

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

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));
      const busy = screen.getByRole('button', { name: 'שומר..., משה לוי' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);

      expect(calls).toHaveLength(1);
      // Only that card is busy: another customer can be confirmed meanwhile.
      const yossi = screen.getByRole('button', { name: 'אישר בטלפון, יוסי מזרחי' });
      expect(yossi.getAttribute('aria-disabled')).toBeNull();

      answer.resolve({ kind: 'confirmed', view: VIEW_MOSHE_CONFIRMED });

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      expect(calls).toHaveLength(1);
    });

    it('keeps the "שלח" rows Yoel opened marked when the round is swapped in', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByRole('link', { name: 'שלח ליוסי מזרחי' }));
      await screen.findByRole('link', { name: 'שלח שוב ליוסי מזרחי' });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

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

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      const other = screen.getByRole('region', { name: 'בית שמש · 26/11' });
      expect(within(other).getByRole('button', { name: 'אישר בטלפון, שרה גולן' })).toBeDefined();
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

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      const notice = await screen.findByRole('alert');
      expect(notice.textContent).toBe('האישורים לסבב הזה כבר נסגרו.');
      expect(document.activeElement).toBe(notice);
      expect(rounds.calls()).toBe(2);
      // The rounds stay on screen while they load again.
      expect(screen.queryByRole('status')).toBeNull();
      expect(roundRegion()).toBeDefined();

      // The round as it is now: its confirmations closed, so משה left it.
      const routed = makeView({
        round: { phase: 'routed' },
        confirmed: [DANA],
        otherDate: [RACHEL, { ...MOSHE, status: 'waiting' }],
      });
      reload.resolve({ kind: 'loaded', rounds: [routed] });

      await waitFor(() =>
        expect(namesIn(groupRegion('ביקשו מועד אחר'))).toEqual(['רחל אברהם', 'משה לוי']),
      );
      expect(screen.queryByRole('button', { name: /^אישר בטלפון/ })).toBeNull();
      // The notice stays until Yoel does something else.
      expect(screen.getByRole('alert').textContent).toBe(ROUND_MESSAGES.confirmationsClosed);
    });

    it('says the order is no longer in the round and loads the rounds again', async () => {
      const rounds = fakeLoad(LOADED, { kind: 'loaded', rounds: [makeView({ pending: [YOSSI] })] });
      await renderLoaded({
        loadRounds: rounds.load,
        confirmByPhone: fakeConfirm({ kind: 'notFound' }).confirmByPhone,
      });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LEFT_ROUND_MESSAGE);
      expect(ORDER_LEFT_ROUND_MESSAGE).toBe('ההזמנה כבר לא בסבב.');
      await waitFor(() => expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['יוסי מזרחי']));
      expect(rounds.calls()).toBe(2);
    });

    it('clears the notice at the next "אישר בטלפון"', async () => {
      const { confirmByPhone } = fakeConfirm({ kind: 'notFound' }, { kind: 'failed' });
      await renderLoaded({ confirmByPhone });
      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));
      await screen.findByText(ORDER_LEFT_ROUND_MESSAGE);
      await settle();

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, יוסי מזרחי' }));

      expect(screen.queryByText(ORDER_LEFT_ROUND_MESSAGE)).toBeNull();
    });

    it('says the save failed next to the card, and the button works again', async () => {
      const { confirmByPhone, calls } = fakeConfirm({ kind: 'failed' }, 'rejects');
      await renderLoaded({ confirmByPhone });

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      const alert = await within(cardOf('משה לוי')).findByRole('alert');
      expect(alert.textContent).toBe(CONFIRM_FAILED_MESSAGE);
      expect(CONFIRM_FAILED_MESSAGE).toBe('לא הצלחנו לשמור. נא לנסות שוב.');
      expect(within(cardOf('יוסי מזרחי')).queryByRole('alert')).toBeNull();
      const button = screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' });
      expect(button.getAttribute('aria-disabled')).toBeNull();
      expect(namesIn(groupRegion('עוד לא אישרו'))).toEqual(['משה לוי', 'יוסי מזרחי']);

      // A rejection is a failed save like any other.
      fireEvent.click(button);

      expect(calls).toHaveLength(2);
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: 'אישר בטלפון, משה לוי' })
            .getAttribute('aria-disabled'),
        ).toBeNull(),
      );
      expect(within(cardOf('משה לוי')).getByRole('alert').textContent).toBe(CONFIRM_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('goes to the login, replacing the screen, when the session ended', async () => {
      await renderLoaded({ confirmByPhone: fakeConfirm(LOGGED_OUT).confirmByPhone });
      const historyLength = window.history.length;

      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<ConfirmByPhoneOutcome>();
      const { unmount } = renderScreen({
        loadRounds: fakeLoad(LOADED).load,
        confirmByPhone: fakeConfirm(answer.promise).confirmByPhone,
      });
      fireEvent.click(await screen.findByRole('button', { name: 'אישר בטלפון, משה לוי' }));
      unmount();
      window.history.replaceState(null, '', '/app/orders');

      answer.resolve(LOGGED_OUT);
      await settle();

      expect(window.location.pathname).toBe('/app/orders');
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

    it('keeps the notice of a refused "אישר בטלפון"', async () => {
      const rounds = fakeLoad(LOADED);
      await renderLoaded({
        loadRounds: rounds.load,
        confirmByPhone: fakeConfirm({ kind: 'notFound' }).confirmByPhone,
      });
      fireEvent.click(screen.getByRole('button', { name: 'אישר בטלפון, משה לוי' }));
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

    it('still shows the answer of "אישר בטלפון"', async () => {
      const { confirmByPhone, calls } = fakeConfirm();
      renderScreen({ loadRounds: fakeLoad(LOADED).load, confirmByPhone }, { strict: true });

      fireEvent.click(await screen.findByRole('button', { name: 'אישר בטלפון, משה לוי' }));

      await waitFor(() => expect(namesIn(groupRegion('אישרו'))).toContain('משה לוי'));
      expect(calls).toHaveLength(1);
    });
  });
});
