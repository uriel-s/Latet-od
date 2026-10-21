import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ROUND_ORDERS,
  ROUND_MESSAGES,
  ROUND_PLAN_ERRORS,
  groupWaitingOrders,
  type CollectorOrder,
  type PlanRoundRequest,
  type RoundView,
} from '@bottlerun/shared';
import {
  NETWORK_ERROR_MESSAGE,
  type PlanRoundOutcome,
  type RoundsOutcome,
  type WaitingOrdersOutcome,
} from '../api.ts';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { ORDERS_LOAD_FAILED_MESSAGE } from './OrdersScreen.tsx';
import {
  NO_REGION_ORDERS_TEXT,
  PERSONAL_TEXT_HINT,
  PlanRoundScreen,
  UNASSIGNED_ORDERS_HINT,
} from './PlanRoundScreen.tsx';
import { returnToApp } from './visibilityTestHelper.ts';

/** A waiting order on a listed street in רמת בית שמש, with a map point; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
    },
    bottlesEstimated: 40,
    status: 'waiting',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

const DANA = makeOrder();
/** Back from a round the customer did not confirm in time: its card has the miss tag. */
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
  lastMiss: { date: '2026-11-12', reason: 'notConfirmed', roundId: 'r0' },
});
/** In בית שמש, with no map point: its card has "בלי מיקום". */
const YOSSI = makeOrder({
  id: 'o4',
  contact: { name: 'יוסי מזרחי', phone: '+972501239999' },
  address: { streetCode: 101, streetName: 'הרצל', houseNumber: '3', bottlesSpot: 'privateHouse' },
  bottlesEstimated: 50,
  region: 'old',
  hasLocation: false,
});
/** A street written by hand: no region yet ("בלי אזור"), so never offered for a round. */
const RACHEL = makeOrder({
  id: 'o3',
  contact: { name: 'רחל אברהם', phone: '+972541112233' },
  address: { streetName: 'סמטת הגפנים', houseNumber: '7', bottlesSpot: 'buildingEntrance' },
  bottlesEstimated: 30,
  region: undefined,
  hasLocation: false,
});

/** The waiting orders: two in רמת בית שמש, one in בית שמש, one without a region. */
const ORDERS_LOADED: WaitingOrdersOutcome = {
  kind: 'loaded',
  groups: groupWaitingOrders([DANA, MOSHE, YOSSI, RACHEL]),
};
const ROUNDS_LOADED: RoundsOutcome = { kind: 'loaded', rounds: [], previousPickupBy: '08:30' };
const ROUNDS_WITHOUT_TIME: RoundsOutcome = { kind: 'loaded', rounds: [] };
const LOGGED_OUT = { kind: 'loggedOut' } as const;
const FAILED = { kind: 'failed' } as const;

/** What the api answers a plan with: the round as stored (its contents do not matter here). */
const ROUND_VIEW: RoundView = {
  round: {
    id: 'r1',
    date: '2026-11-19',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    createdAt: new Date('2026-10-20T07:00:00Z'),
  },
  groups: [
    { key: 'confirmed', orders: [] },
    { key: 'pending', orders: [] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [],
  stops: [],
};
const PLANNED: PlanRoundOutcome = { kind: 'planned', view: ROUND_VIEW };

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One answer of a fake: an outcome, a promise of one (a `deferred` the test settles), or a
 * function called at the time of the call, for a rejection that must not exist (unhandled)
 * before the screen asks.
 */
type Answer<T> = T | Promise<T> | (() => Promise<T>);

/** A rejection, made only when the fake is called. */
function rejects<T>(): () => Promise<T> {
  return () => Promise.reject(new Error('boom'));
}

/** A fake that answers each call with the next answer given (the last one repeats). */
function answersInTurn<T extends object>(
  answers: readonly Answer<T>[],
): {
  next: () => Promise<T>;
  calls: () => number;
} {
  let calls = 0;
  return {
    next: () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer === undefined) throw new Error('no answer given');
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
    calls: () => calls,
  };
}

interface RenderOptions {
  /** The answers of loadOrders, in turn. Default: the four orders above. */
  orders?: readonly Answer<WaitingOrdersOutcome>[];
  /** The answers of loadRounds, in turn. Default: no open round, last pickup time 08:30. */
  rounds?: readonly Answer<RoundsOutcome>[];
  /** The answers of submitPlan, in turn. Default: planned. */
  plan?: readonly Answer<PlanRoundOutcome>[];
  strict?: boolean;
}

/** What the fakes recorded. */
interface Recorded {
  ordersCalls: () => number;
  roundsCalls: () => number;
  plans: PlanRoundRequest[];
  unmount: () => void;
}

/** Opens the planning screen at /app/orders/plan, with fakes that record every call. */
function renderScreen({ orders, rounds, plan, strict = false }: RenderOptions = {}): Recorded {
  window.history.replaceState(null, '', '/app/orders/plan');
  const loadOrders = answersInTurn(orders ?? [ORDERS_LOADED]);
  const loadRounds = answersInTurn(rounds ?? [ROUNDS_LOADED]);
  const submit = answersInTurn(plan ?? [PLANNED]);
  const plans: PlanRoundRequest[] = [];
  const element = (
    <PlanRoundScreen
      loadOrders={loadOrders.next}
      loadRounds={loadRounds.next}
      submitPlan={(request) => {
        plans.push(request);
        return submit.next();
      }}
    />
  );
  const { unmount } = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return { ordersCalls: loadOrders.calls, roundsCalls: loadRounds.calls, plans, unmount };
}

/** Opens the screen and waits for its form. */
async function renderLoaded(options: RenderOptions = {}): Promise<Recorded> {
  const recorded = renderScreen(options);
  await screen.findByRole('button', { name: 'שלח בקשות אישור' });
  return recorded;
}

function dateInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('תאריך הסבב');
}

function timeInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('עד איזו שעה להוציא את הבקבוקים (לא חובה)');
}

function textInput(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('טקסט אישי (לא חובה)');
}

function setDate(value: string): void {
  fireEvent.change(dateInput(), { target: { value } });
}

/** The radio of a region, found by its label without the count. */
function regionRadio(label: 'רמת בית שמש' | 'בית שמש'): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(`^${label} \\(\\d+\\)$`) });
}

function chooseRegion(label: 'רמת בית שמש' | 'בית שמש'): void {
  fireEvent.click(regionRadio(label));
}

/** The checkbox of the customer named `name` (the checkbox is named by the name alone). */
function orderBox(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name });
}

/**
 * The names of the order checkboxes on screen, in order, and whether each is marked. The name is
 * the element that labels the checkbox (aria-labelledby): the customer's name.
 */
function orderBoxes(): [name: string, checked: boolean][] {
  return screen.queryAllByRole<HTMLInputElement>('checkbox').map((box) => {
    const labelId = box.getAttribute('aria-labelledby') ?? '';
    return [document.getElementById(labelId)?.textContent ?? '', box.checked];
  });
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /שלח בקשות אישור|שולח\.\.\./ });
}

function send(): void {
  fireEvent.click(sendButton());
}

/** Fills a valid plan of רמת בית שמש: the date and the region; both orders stay marked. */
function fillValidPlan(): void {
  setDate('2026-11-19');
  chooseRegion('רמת בית שמש');
}

/** The page has exactly one h1, and it is the screen's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'תכנון סבב' })).toBeDefined();
}

describe('PlanRoundScreen', () => {
  describe('while it loads', () => {
    it('shows the heading, the way back and a loading status, and loads orders and rounds at once', () => {
      const pendingOrders = deferred<WaitingOrdersOutcome>();
      const pendingRounds = deferred<RoundsOutcome>();
      const recorded = renderScreen({
        orders: [pendingOrders.promise],
        rounds: [pendingRounds.promise],
      });

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.getByRole('link', { name: 'חזרה להזמנות' }).getAttribute('href')).toBe(
        '/app/orders',
      );
      expect(screen.queryByRole('button', { name: 'שלח בקשות אישור' })).toBeNull();
      // Both asked before either answered: in parallel, not one after the other.
      expect(recorded.ordersCalls()).toBe(1);
      expect(recorded.roundsCalls()).toBe(1);
    });

    it('waits for both answers before it shows the form', async () => {
      const pendingRounds = deferred<RoundsOutcome>();
      renderScreen({ rounds: [pendingRounds.promise] });
      await new Promise((settle) => setTimeout(settle, 0));

      expect(screen.getByRole('status').textContent).toBe('טוען...');

      pendingRounds.resolve(ROUNDS_LOADED);

      expect(await screen.findByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('loaded', () => {
    it('shows the form in order: date, region, pickup time, personal text, send', async () => {
      await renderLoaded();

      expectOneH1();
      expect(dateInput().type).toBe('date');
      expect(dateInput().value).toBe('');
      expect(screen.getByRole('group', { name: 'אזור' })).toBeDefined();
      expect(timeInput().type).toBe('time');
      expect(textInput().tagName).toBe('TEXTAREA');
      const order = [
        dateInput(),
        regionRadio('רמת בית שמש'),
        timeInput(),
        textInput(),
        sendButton(),
      ];
      for (let index = 1; index < order.length; index += 1) {
        const before = order[index - 1];
        const after = order[index];
        if (before === undefined || after === undefined) throw new Error('missing field');
        expect(
          before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it('reads the date and the time left to right', async () => {
      await renderLoaded();

      expect(dateInput().getAttribute('dir')).toBe('ltr');
      expect(timeInput().getAttribute('dir')).toBe('ltr');
    });

    it('offers the two regions with their waiting-order counts, none chosen, and no list yet', async () => {
      await renderLoaded();

      const ramat = screen.getByRole<HTMLInputElement>('radio', { name: 'רמת בית שמש (2)' });
      const old = screen.getByRole<HTMLInputElement>('radio', { name: 'בית שמש (1)' });
      expect(ramat.checked).toBe(false);
      expect(old.checked).toBe(false);
      expect(screen.getAllByRole('radio')).toHaveLength(2);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('says orders without a region are not offered, only while there are some', async () => {
      await renderLoaded();
      expect(screen.getByText(UNASSIGNED_ORDERS_HINT)).toBeDefined();
      expect(UNASSIGNED_ORDERS_HINT).toBe(
        'הזמנות בלי אזור לא מופיעות כאן. קודם בוחרים להן אזור בעריכה.',
      );
    });

    it('has no such hint when every waiting order has a region', async () => {
      await renderLoaded({
        orders: [{ kind: 'loaded', groups: groupWaitingOrders([DANA, MOSHE, YOSSI]) }],
      });

      expect(screen.queryByText(UNASSIGNED_ORDERS_HINT)).toBeNull();
    });

    it("shows the region's waiting orders once it is chosen, all marked", async () => {
      await renderLoaded();

      chooseRegion('רמת בית שמש');

      expect(regionRadio('רמת בית שמש').checked).toBe(true);
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', true],
      ]);
      expect(screen.getByText('מסומנות: 2 מתוך 2')).toBeDefined();
      expect(screen.getByRole('group', { name: 'הזמנות לסבב' })).toBeDefined();
    });

    it('never offers an order without a region, in either region', async () => {
      await renderLoaded();

      chooseRegion('רמת בית שמש');
      expect(screen.queryByText('רחל אברהם')).toBeNull();
      chooseRegion('בית שמש');
      expect(orderBoxes()).toEqual([['יוסי מזרחי', true]]);
      expect(screen.queryByText('רחל אברהם')).toBeNull();
    });

    it("shows each order's street and number, bottles and tags in its row", async () => {
      await renderLoaded();

      chooseRegion('רמת בית שמש');
      const moshe = orderBox('משה לוי').closest('label');
      if (moshe === null) throw new Error('no row for משה לוי');
      expect(within(moshe).getByText("בית ג'מאל 5")).toBeDefined();
      expect(within(moshe).getByText('80 בקבוקים')).toBeDefined();
      expect(within(moshe).getByText('לא אישר בזמן · 12/11')).toBeDefined();
      const dana = orderBox('דנה כהן').closest('label');
      if (dana === null) throw new Error('no row for דנה כהן');
      expect(within(dana).queryByText(/12\/11|בלי מיקום/)).toBeNull();

      chooseRegion('בית שמש');
      const yossi = orderBox('יוסי מזרחי').closest('label');
      if (yossi === null) throw new Error('no row for יוסי מזרחי');
      expect(within(yossi).getByText('הרצל 3')).toBeDefined();
      expect(within(yossi).getByText('בלי מיקום')).toBeDefined();
      // The details describe the checkbox, so a screen reader reads them after the name.
      expect(orderBox('יוסי מזרחי').getAttribute('aria-describedby')).toBeTruthy();
    });

    it('says so when the chosen region has no waiting orders', async () => {
      await renderLoaded({
        orders: [{ kind: 'loaded', groups: groupWaitingOrders([DANA, MOSHE]) }],
      });

      chooseRegion('בית שמש');

      expect(regionRadio('בית שמש').labels?.[0]?.textContent).toBe('בית שמש (0)');
      expect(screen.getByText(NO_REGION_ORDERS_TEXT)).toBeDefined();
      expect(NO_REGION_ORDERS_TEXT).toBe('אין הזמנות שממתינות באזור הזה');
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('counts the marked orders as Yoel unmarks one', async () => {
      await renderLoaded();
      chooseRegion('רמת בית שמש');

      fireEvent.click(orderBox('דנה כהן'));

      expect(orderBoxes()).toEqual([
        ['דנה כהן', false],
        ['משה לוי', true],
      ]);
      expect(screen.getByText('מסומנות: 1 מתוך 2')).toBeDefined();
    });

    it('marks all of the new region when the region changes, and all again on coming back', async () => {
      const recorded = await renderLoaded();
      chooseRegion('רמת בית שמש');
      fireEvent.click(orderBox('דנה כהן'));

      chooseRegion('בית שמש');
      expect(orderBoxes()).toEqual([['יוסי מזרחי', true]]);

      chooseRegion('רמת בית שמש');
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', true],
      ]);

      setDate('2026-11-19');
      send();
      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]?.orderIds).toEqual(['o1', 'o2']);
      expect(recorded.plans[0]?.region).toBe('ramat');
    });

    it('pre-fills the pickup time from the previous round', async () => {
      await renderLoaded();

      expect(timeInput().value).toBe('08:30');
    });

    it('leaves the pickup time empty when the previous round had none', async () => {
      await renderLoaded({ rounds: [ROUNDS_WITHOUT_TIME] });

      expect(timeInput().value).toBe('');
    });

    it('says the personal text goes into every request, and caps its length', async () => {
      await renderLoaded();

      expect(screen.getByText(PERSONAL_TEXT_HINT)).toBeDefined();
      expect(textInput().maxLength).toBe(500);
    });
  });

  describe('sending', () => {
    it('sends the date, the region, exactly the orders left marked, the time and the trimmed text', async () => {
      const recorded = await renderLoaded();
      fillValidPlan();
      fireEvent.click(orderBox('דנה כהן'));
      fireEvent.change(timeInput(), { target: { value: '09:15' } });
      fireEvent.change(textInput(), { target: { value: '  תודה רבה!\nיואל  ' } });

      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]).toEqual({
        date: '2026-11-19',
        region: 'ramat',
        orderIds: ['o2'],
        pickupBy: '09:15',
        personalText: 'תודה רבה!\nיואל',
      });
    });

    it('sends the pickup time pre-filled from the previous round when left as it is', async () => {
      const recorded = await renderLoaded();
      fillValidPlan();

      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]).toEqual({
        date: '2026-11-19',
        region: 'ramat',
        orderIds: ['o1', 'o2'],
        pickupBy: '08:30',
      });
    });

    it('leaves out an emptied pickup time and a blank personal text', async () => {
      const recorded = await renderLoaded();
      fillValidPlan();
      fireEvent.change(timeInput(), { target: { value: '' } });
      fireEvent.change(textInput(), { target: { value: '   ' } });

      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]?.pickupBy).toBeUndefined();
      expect(recorded.plans[0]?.personalText).toBeUndefined();
    });

    it('sends the marked orders in list order, whatever order they were marked in', async () => {
      const recorded = await renderLoaded();
      fillValidPlan();
      fireEvent.click(orderBox('דנה כהן'));
      fireEvent.click(orderBox('דנה כהן'));

      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]?.orderIds).toEqual(['o1', 'o2']);
    });

    it('goes to the rounds tab once planned, in place of the planning screen', async () => {
      const historyLength = window.history.length;
      await renderLoaded();
      fillValidPlan();

      send();

      await waitFor(() => expect(window.location.pathname).toBe('/app/rounds'));
      // The new round is the one shown, even when an earlier round is open.
      expect(window.location.search).toBe('?round=r1');
      // Replaced: "back" from the rounds returns to the orders, not to this sent form.
      expect(window.history.length).toBe(historyLength);
      expect(window.history.state).toEqual({ notice: 'הסבב נוצר.' });
    });

    it('offers no round date before today by the Israeli calendar, not the UTC one', async () => {
      // 00:30 on 12/11 in Israel (UTC+2 in winter) is still 11/11 in UTC.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T22:30:00Z'));
      try {
        await renderLoaded();

        expect(dateInput().min).toBe('2026-11-12');
      } finally {
        vi.useRealTimers();
      }
    });

    it('says "שולח..." while sending, and a second tap sends nothing more', async () => {
      const answer = deferred<PlanRoundOutcome>();
      const recorded = await renderLoaded({ plan: [answer.promise] });
      fillValidPlan();

      send();
      send();

      const busy = screen.getByRole('button', { name: 'שולח...' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      expect(recorded.plans).toHaveLength(1);

      answer.resolve(PLANNED);

      await waitFor(() => expect(window.location.pathname).toBe('/app/rounds'));
      expect(recorded.plans).toHaveLength(1);
    });
  });

  describe('checks before sending', () => {
    it('asks for a date next to its field, focuses it, and sends nothing', async () => {
      const recorded = await renderLoaded();
      chooseRegion('רמת בית שמש');

      send();

      expect(screen.getByText(ROUND_PLAN_ERRORS.dateRequired)).toBeDefined();
      expect(ROUND_PLAN_ERRORS.dateRequired).toBe('נא לבחור תאריך');
      expect(dateInput().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(dateInput());
      expect(recorded.plans).toHaveLength(0);
    });

    it('asks for a region, and says nothing about the orders before one is chosen', async () => {
      const recorded = await renderLoaded();
      setDate('2026-11-19');

      send();

      expect(screen.getByText('נא לבחור אזור')).toBeDefined();
      expect(screen.queryByText(ROUND_PLAN_ERRORS.noOrders)).toBeNull();
      expect(regionRadio('רמת בית שמש').getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(regionRadio('רמת בית שמש'));
      expect(recorded.plans).toHaveLength(0);
    });

    it('shows every error at once, and focuses the first field', async () => {
      const recorded = await renderLoaded();

      send();

      expect(screen.getByText(ROUND_PLAN_ERRORS.dateRequired)).toBeDefined();
      expect(screen.getByText(ROUND_PLAN_ERRORS.regionRequired)).toBeDefined();
      expect(document.activeElement).toBe(dateInput());
      expect(recorded.plans).toHaveLength(0);
    });

    it('asks for at least one marked order', async () => {
      const recorded = await renderLoaded();
      fillValidPlan();
      fireEvent.click(orderBox('דנה כהן'));
      fireEvent.click(orderBox('משה לוי'));

      send();

      expect(screen.getByText('נא לסמן לפחות הזמנה אחת')).toBeDefined();
      expect(orderBox('דנה כהן').getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(orderBox('דנה כהן'));
      expect(recorded.plans).toHaveLength(0);

      // Marking one again clears the message.
      fireEvent.click(orderBox('משה לוי'));
      expect(screen.queryByText(ROUND_PLAN_ERRORS.noOrders)).toBeNull();
    });

    it('asks for an order in a region that has none waiting', async () => {
      const recorded = await renderLoaded({
        orders: [{ kind: 'loaded', groups: groupWaitingOrders([DANA]) }],
      });
      setDate('2026-11-19');
      chooseRegion('בית שמש');

      send();

      expect(screen.getByText(ROUND_PLAN_ERRORS.noOrders)).toBeDefined();
      expect(recorded.plans).toHaveLength(0);
    });

    it(`refuses more than ${MAX_ROUND_ORDERS} marked orders, and sends once one is unmarked`, async () => {
      const many = Array.from({ length: MAX_ROUND_ORDERS + 1 }, (_, index) =>
        makeOrder({
          id: `m${index + 1}`,
          contact: { name: `לקוח ${index + 1}`, phone: '+972501234567' },
        }),
      );
      const recorded = await renderLoaded({
        orders: [{ kind: 'loaded', groups: groupWaitingOrders(many) }],
      });
      fillValidPlan();
      expect(screen.getByText('מסומנות: 26 מתוך 26')).toBeDefined();

      send();

      expect(screen.getByText('אפשר לסמן עד 25 הזמנות בסבב')).toBeDefined();
      expect(recorded.plans).toHaveLength(0);

      fireEvent.click(orderBox('לקוח 26'));
      expect(screen.queryByText(ROUND_PLAN_ERRORS.tooManyOrders)).toBeNull();
      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(1));
      expect(recorded.plans[0]?.orderIds).toHaveLength(MAX_ROUND_ORDERS);
      expect(recorded.plans[0]?.orderIds).not.toContain('m26');
    });

    it("clears a field's error when its value changes, and only that one", async () => {
      await renderLoaded();
      send();
      expect(screen.getByText(ROUND_PLAN_ERRORS.dateRequired)).toBeDefined();

      setDate('2026-11-19');

      expect(screen.queryByText(ROUND_PLAN_ERRORS.dateRequired)).toBeNull();
      expect(dateInput().getAttribute('aria-invalid')).toBeNull();
      expect(screen.getByText(ROUND_PLAN_ERRORS.regionRequired)).toBeDefined();
    });
  });

  describe("the api's answer", () => {
    it('shows a refused field next to it, and a key no field shows above the button', async () => {
      await renderLoaded({
        plan: [
          {
            kind: 'invalid',
            fieldErrors: { pickupBy: ROUND_PLAN_ERRORS.pickupByInvalid, website: 'x' },
          },
        ],
      });
      fillValidPlan();

      send();

      expect(await screen.findByText('נא לכתוב שעה, למשל 08:00')).toBeDefined();
      expect(timeInput().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(timeInput());
      expect(screen.getByRole('alert').textContent).toBe(UNKNOWN_FIELD_ERROR);
      expect(window.location.pathname).toBe('/app/orders/plan');
    });

    it('shows a 400 without field errors as a message above the button', async () => {
      await renderLoaded({ plan: [{ kind: 'invalid', fieldErrors: {} }] });
      fillValidPlan();

      send();

      expect((await screen.findByRole('alert')).textContent).toBe(UNKNOWN_FIELD_ERROR);
    });

    it('says some orders are no longer waiting, loads the list again and marks all its orders', async () => {
      const fresh: WaitingOrdersOutcome = {
        kind: 'loaded',
        groups: groupWaitingOrders([
          DANA,
          makeOrder({ id: 'o5', contact: { name: 'שרה גולן', phone: '+972509998877' } }),
          YOSSI,
        ]),
      };
      const recorded = await renderLoaded({
        orders: [ORDERS_LOADED, fresh],
        plan: [
          { kind: 'ordersNotWaiting', message: ROUND_MESSAGES.ordersNotWaiting, orderIds: ['o2'] },
        ],
      });
      fillValidPlan();
      fireEvent.click(orderBox('דנה כהן'));
      fireEvent.change(timeInput(), { target: { value: '07:45' } });
      fireEvent.change(textInput(), { target: { value: 'תודה!' } });

      send();

      expect((await screen.findByRole('alert')).textContent).toBe(
        'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
      );
      expect(recorded.ordersCalls()).toBe(2);
      // The fresh list, all marked again (also the one Yoel had unmarked); the gone order left.
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['שרה גולן', true],
      ]);
      expect(regionRadio('רמת בית שמש').labels?.[0]?.textContent).toBe('רמת בית שמש (2)');
      // Everything typed stays.
      expect(dateInput().value).toBe('2026-11-19');
      expect(regionRadio('רמת בית שמש').checked).toBe(true);
      expect(timeInput().value).toBe('07:45');
      expect(textInput().value).toBe('תודה!');
      expect(screen.getByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
      expect(window.location.pathname).toBe('/app/orders/plan');
    });

    it('keeps "שולח..." until the list has loaded again', async () => {
      const reload = deferred<WaitingOrdersOutcome>();
      await renderLoaded({
        orders: [ORDERS_LOADED, reload.promise],
        plan: [
          { kind: 'ordersNotWaiting', message: ROUND_MESSAGES.ordersNotWaiting, orderIds: [] },
        ],
      });
      fillValidPlan();

      send();
      await new Promise((settle) => setTimeout(settle, 0));

      expect(screen.getByRole('button', { name: 'שולח...' })).toBeDefined();

      reload.resolve(ORDERS_LOADED);

      expect(await screen.findByRole('alert')).toBeDefined();
      expect(screen.getByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
    });

    it('keeps the old list with the refused orders unmarked when it cannot load again', async () => {
      const recorded = await renderLoaded({
        orders: [ORDERS_LOADED, FAILED],
        plan: [
          { kind: 'ordersNotWaiting', message: ROUND_MESSAGES.ordersNotWaiting, orderIds: ['o2'] },
          PLANNED,
        ],
      });
      fillValidPlan();

      send();

      expect((await screen.findByRole('alert')).textContent).toBe(ROUND_MESSAGES.ordersNotWaiting);
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', false],
      ]);

      send();

      await waitFor(() => expect(recorded.plans).toHaveLength(2));
      expect(recorded.plans[1]?.orderIds).toEqual(['o1']);
    });

    it('goes to the login when the list, loaded again, says the session ended', async () => {
      await renderLoaded({
        orders: [ORDERS_LOADED, LOGGED_OUT],
        plan: [
          { kind: 'ordersNotWaiting', message: ROUND_MESSAGES.ordersNotWaiting, orderIds: [] },
        ],
      });
      fillValidPlan();

      send();

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
    });

    it('says the send failed in plain words, and keeps the form as it was', async () => {
      const recorded = await renderLoaded({ plan: [FAILED, PLANNED] });
      fillValidPlan();
      fireEvent.click(orderBox('משה לוי'));
      fireEvent.change(textInput(), { target: { value: 'תודה!' } });

      send();

      expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
      expect(NETWORK_ERROR_MESSAGE).toBe(
        'לא הצלחנו לשלוח. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expect(dateInput().value).toBe('2026-11-19');
      expect(regionRadio('רמת בית שמש').checked).toBe(true);
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', false],
      ]);
      expect(textInput().value).toBe('תודה!');
      expect(window.location.pathname).toBe('/app/orders/plan');

      // Another tap sends the same plan again.
      send();

      await waitFor(() => expect(window.location.pathname).toBe('/app/rounds'));
      expect(recorded.plans).toHaveLength(2);
      expect(recorded.plans[1]).toEqual(recorded.plans[0]);
    });

    it('treats a rejected send like a failed one', async () => {
      await renderLoaded({ plan: [rejects()] });
      fillValidPlan();

      send();

      expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
      expect(screen.getByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
    });

    it('goes to the login in place of the screen when the session ended', async () => {
      const historyLength = window.history.length;
      await renderLoaded({ plan: [LOGGED_OUT] });
      fillValidPlan();

      send();

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the screen', async () => {
      const answer = deferred<PlanRoundOutcome>();
      const recorded = await renderLoaded({ plan: [answer.promise] });
      fillValidPlan();
      send();
      recorded.unmount();
      window.history.replaceState(null, '', '/app/history');

      answer.resolve(PLANNED);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/history');
    });
  });

  describe('when the load fails', () => {
    it.each([
      ['the orders', { orders: [FAILED] }],
      ['the rounds', { rounds: [FAILED] }],
    ] as const)('says so in plain words with a retry when %s fail', async (_, options) => {
      renderScreen(options);

      expect((await screen.findByRole('alert')).textContent).toBe(ORDERS_LOAD_FAILED_MESSAGE);
      expectOneH1();
      expect(screen.getByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'חזרה להזמנות' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'שלח בקשות אישור' })).toBeNull();
      expect(window.location.pathname).toBe('/app/orders/plan');
    });

    it('treats a rejected load like a failed one', async () => {
      renderScreen({ rounds: [rejects()] });

      expect((await screen.findByRole('alert')).textContent).toBe(ORDERS_LOAD_FAILED_MESSAGE);
    });

    it('loads both again on "לנסות שוב", and shows the form when that load succeeds', async () => {
      const recorded = renderScreen({ orders: [FAILED, ORDERS_LOADED] });
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(await screen.findByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
      expect(recorded.ordersCalls()).toBe(2);
      expect(recorded.roundsCalls()).toBe(2);
      expect(timeInput().value).toBe('08:30');
    });

    it.each([
      ['the orders', { orders: [LOGGED_OUT] }],
      ['the rounds', { rounds: [LOGGED_OUT] }],
    ] as const)('goes to the login when %s say the session ended', async (_, options) => {
      const historyLength = window.history.length;
      renderScreen(options);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the load answers after he left', async () => {
      const answer = deferred<WaitingOrdersOutcome>();
      const recorded = renderScreen({ orders: [answer.promise] });
      recorded.unmount();
      window.history.replaceState(null, '', '/app/rounds');

      answer.resolve(LOGGED_OUT);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/rounds');
    });
  });

  describe('coming back to the app', () => {
    it('does not load again, and keeps the plan Yoel started', async () => {
      // Only the list screens reload on return: here a reload would wipe the plan.
      const recorded = await renderLoaded();
      fillValidPlan();
      fireEvent.change(textInput(), { target: { value: 'תודה רבה!' } });
      fireEvent.click(orderBox('משה לוי'));

      returnToApp();
      await new Promise((settle) => setTimeout(settle, 0));

      expect(recorded.ordersCalls()).toBe(1);
      expect(recorded.roundsCalls()).toBe(1);
      expect(dateInput().value).toBe('2026-11-19');
      expect(regionRadio('רמת בית שמש').checked).toBe(true);
      expect(textInput().value).toBe('תודה רבה!');
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', false],
      ]);
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load, and still sends once', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const recorded = renderScreen({ orders: [LOGGED_OUT, ORDERS_LOADED], strict: true });

      expect(await screen.findByRole('button', { name: 'שלח בקשות אישור' })).toBeDefined();
      expect(recorded.ordersCalls()).toBe(2);
      expect(window.location.pathname).toBe('/app/orders/plan');

      fillValidPlan();
      expect(orderBoxes()).toEqual([
        ['דנה כהן', true],
        ['משה לוי', true],
      ]);
      send();

      await waitFor(() => expect(window.location.pathname).toBe('/app/rounds'));
      expect(recorded.plans).toHaveLength(1);
    });
  });
});
