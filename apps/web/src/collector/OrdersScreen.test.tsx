import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupWaitingOrders, type CollectorOrder } from '@bottlerun/shared';
import type { WaitingOrdersOutcome } from '../api.ts';
import { ORDERS_LOAD_FAILED_MESSAGE, OrdersScreen, groupSummary } from './OrdersScreen.tsx';

/** A waiting order on a listed street in רמת בית שמש, with a map point; overrides change it. */
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
      note: 'לדפוק חזק',
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

/** Two orders in רמת בית שמש (one back from a round), none in בית שמש, one without a region. */
const ORDERS: CollectorOrder[] = [
  makeOrder(),
  makeOrder({
    id: 'o2',
    contact: { name: 'משה לוי', phone: '+972527654321' },
    address: {
      streetCode: 130,
      streetName: "בית ג'מאל",
      houseNumber: '5',
      bottlesSpot: 'privateHouse',
    },
    bottlesEstimated: 80,
    lastMiss: { date: '2026-11-12', reason: 'notConfirmed', roundId: 'r1' },
  }),
  makeOrder({
    id: 'o3',
    contact: { name: 'רחל אברהם', phone: '+972541112233' },
    address: { streetName: 'סמטת הגפנים', houseNumber: '7', bottlesSpot: 'buildingEntrance' },
    bottlesEstimated: 30,
    region: undefined,
    hasLocation: false,
  }),
];

const LOADED: WaitingOrdersOutcome = { kind: 'loaded', groups: groupWaitingOrders(ORDERS) };
const LOGGED_OUT: WaitingOrdersOutcome = { kind: 'loggedOut' };
const FAILED: WaitingOrdersOutcome = { kind: 'failed' };

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A fake `loadOrders`: answers each call with the next answer given (the last one repeats). */
function fakeLoad(...answers: (WaitingOrdersOutcome | Promise<WaitingOrdersOutcome>)[]): {
  load: () => Promise<WaitingOrdersOutcome>;
  calls: () => number;
} {
  let calls = 0;
  const load = (): Promise<WaitingOrdersOutcome> => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? LOADED;
    calls += 1;
    return Promise.resolve(answer);
  };
  return { load, calls: () => calls };
}

/** Opens the orders tab at /app/orders with `loadOrders`. */
function renderScreen(
  loadOrders: () => Promise<WaitingOrdersOutcome>,
  { strict = false }: { strict?: boolean } = {},
): { unmount: () => void } {
  window.history.replaceState(null, '', '/app/orders');
  const screenElement = <OrdersScreen loadOrders={loadOrders} />;
  return render(strict ? <StrictMode>{screenElement}</StrictMode> : screenElement);
}

/** Renders the loaded list of {@link ORDERS} and waits for it. */
async function renderLoaded(): Promise<void> {
  renderScreen(fakeLoad(LOADED).load);
  await screen.findByRole('region', { name: 'רמת בית שמש' });
}

/** The card (list item) of the customer named `name`, found by its heading. */
function cardOf(name: string): HTMLElement {
  const card = screen
    .getAllByRole('listitem')
    .find((item) => within(item).queryByRole('heading', { level: 3, name }) !== null);
  if (card === undefined) throw new Error(`no card for ${name}`);
  return card;
}

/** The page has exactly one h1, and it is the tab's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'הזמנות' })).toBeDefined();
}

describe('groupSummary', () => {
  it.each([
    [1, 30, 'הזמנה אחת · 30 בקבוקים'],
    [2, 120, '2 הזמנות · 120 בקבוקים'],
    [3, 1, '3 הזמנות · בקבוק אחד'],
    [12, 1500, '12 הזמנות · 1500 בקבוקים'],
  ])('says %i orders and %i bottles in Hebrew', (orderCount, bottlesTotal, expected) => {
    expect(groupSummary({ orderCount, bottlesTotal })).toBe(expected);
  });

  it('says there are no waiting orders for an empty group', () => {
    expect(groupSummary({ orderCount: 0, bottlesTotal: 0 })).toBe('אין הזמנות שממתינות');
  });
});

describe('OrdersScreen', () => {
  describe('the notice from the screen Yoel just left', () => {
    it('tells it under the heading, once', async () => {
      window.history.replaceState({ notice: 'ההזמנה נוספה.' }, '', '/app/orders');
      render(<OrdersScreen loadOrders={fakeLoad(LOADED).load} />);

      expect((await screen.findByText('ההזמנה נוספה.')).getAttribute('role')).toBe('status');
      // Cleared from the history entry, so a reload or the back button does not show it again.
      expect(window.history.state).toBeNull();
    });

    it('shows no notice on a plain visit', async () => {
      renderScreen(fakeLoad(LOADED).load);

      await screen.findByRole('region', { name: /רמת בית שמש/ });
      expect(screen.queryByText('ההזמנה נוספה.')).toBeNull();
    });
  });

  describe('while the orders load', () => {
    it('shows the heading, the add and plan links and a loading status', () => {
      renderScreen(() => deferred<WaitingOrdersOutcome>().promise);

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.getByRole('link', { name: 'הוספת הזמנה' }).getAttribute('href')).toBe(
        '/app/orders/new',
      );
      expect(screen.getByRole('link', { name: 'תכנון סבב' }).getAttribute('href')).toBe(
        '/app/orders/plan',
      );
      expect(screen.queryByRole('region')).toBeNull();
    });
  });

  describe('loaded', () => {
    it('shows the three groups in order, each a region named by its title', async () => {
      await renderLoaded();

      expectOneH1();
      expect(screen.queryByRole('status')).toBeNull();
      const regionTitles = screen
        .getAllByRole('region')
        .map((region) => within(region).getByRole('heading', { level: 2 }).textContent);
      expect(regionTitles).toEqual(['רמת בית שמש', 'בית שמש', 'בלי אזור']);
      // Each region's accessible name is its title (aria-labelledby), not just a heading inside.
      for (const name of regionTitles) {
        expect(screen.getByRole('region', { name: name ?? '' })).toBeDefined();
      }
    });

    it('shows each group its order count and bottle total', async () => {
      await renderLoaded();

      const ramat = screen.getByRole('region', { name: 'רמת בית שמש' });
      expect(within(ramat).getByText('2 הזמנות · 120 בקבוקים')).toBeDefined();
      expect(within(ramat).getAllByRole('listitem')).toHaveLength(2);

      const none = screen.getByRole('region', { name: 'בלי אזור' });
      expect(within(none).getByText('הזמנה אחת · 30 בקבוקים')).toBeDefined();
      expect(within(none).getAllByRole('listitem')).toHaveLength(1);
    });

    it('says an empty group has no waiting orders, with no list', async () => {
      await renderLoaded();

      const old = screen.getByRole('region', { name: 'בית שמש' });
      expect(within(old).getByText('אין הזמנות שממתינות')).toBeDefined();
      expect(within(old).queryByRole('list')).toBeNull();
    });

    it('lists the orders of a group in the order the api gave them', async () => {
      await renderLoaded();

      const ramat = screen.getByRole('region', { name: 'רמת בית שמש' });
      expect(
        within(ramat)
          .getAllByRole('heading', { level: 3 })
          .map((heading) => heading.textContent),
      ).toEqual(['דנה כהן', 'משה לוי']);
    });

    it("shows a card's name, phone left to right, address, spot, note and bottles", async () => {
      await renderLoaded();

      const card = cardOf('דנה כהן');
      const phone = within(card).getByText('050-1234567');
      expect(phone.closest('[dir="ltr"]')).not.toBeNull();
      expect(within(card).getByText('שד נהר הדן 12')).toBeDefined();
      expect(within(card).getByText('ליד דלת הדירה · קומה 3, דירה 12')).toBeDefined();
      expect(within(card).getByText('הערה: לדפוק חזק')).toBeDefined();
      expect(within(card).getByText('40 בקבוקים')).toBeDefined();
    });

    it('leaves out the floor and the note when the order has none', async () => {
      await renderLoaded();

      const card = cardOf('משה לוי');
      expect(within(card).getByText('בכניסה לבית פרטי')).toBeDefined();
      expect(within(card).queryByText(/הערה/)).toBeNull();
      expect(within(card).queryByText(/רחוב קרוב/)).toBeNull();
    });

    it('tags the order back from a round with its reason and day, and only that order', async () => {
      await renderLoaded();

      expect(within(cardOf('משה לוי')).getByText('לא אישר בזמן · 12/11')).toBeDefined();
      expect(screen.getAllByText('לא אישר בזמן · 12/11')).toHaveLength(1);
      expect(within(cardOf('משה לוי')).queryByText('בלי מיקום')).toBeNull();
    });

    it('tags "בלי מיקום" on the order without a location, and only that order', async () => {
      await renderLoaded();

      const none = screen.getByRole('region', { name: 'בלי אזור' });
      expect(within(cardOf('רחל אברהם')).getByText('בלי מיקום')).toBeDefined();
      expect(within(none).getByText('בלי מיקום')).toBeDefined();
      expect(screen.getAllByText('בלי מיקום')).toHaveLength(1);
      expect(within(cardOf('רחל אברהם')).getByText('סמטת הגפנים 7')).toBeDefined();
    });

    it('shows no tag on an order with a location that was never in a round', async () => {
      await renderLoaded();

      const card = cardOf('דנה כהן');
      // A miss tag ends with the round's day as DD/MM; no text of this card does.
      expect(within(card).queryByText(/\d\d\/\d\d$/)).toBeNull();
      expect(within(card).queryByText('בלי מיקום')).toBeNull();
    });

    it('shows the near street Yoel picked by its official name', async () => {
      const order = makeOrder({
        id: 'o4',
        contact: { name: 'יוסי מזרחי', phone: '+972501239999' },
        address: {
          streetName: 'הבית ליד המכולת',
          nearStreetCode: 101,
          houseNumber: '3',
          bottlesSpot: 'privateHouse',
        },
        region: 'old',
      });
      renderScreen(fakeLoad({ kind: 'loaded', groups: groupWaitingOrders([order]) }).load);

      const old = await screen.findByRole('region', { name: 'בית שמש' });
      expect(within(old).getByText('הזמנה אחת · 40 בקבוקים')).toBeDefined();
      expect(within(cardOf('יוסי מזרחי')).getByText('רחוב קרוב: הרצל')).toBeDefined();
    });

    it("links each card's edit to its order, named after the customer", async () => {
      await renderLoaded();

      const edit = within(cardOf('משה לוי')).getByRole('link', {
        name: 'עריכה, ההזמנה של משה לוי',
      });
      expect(edit.getAttribute('href')).toBe('/app/orders/o2');
      expect(edit.textContent).toContain('עריכה');

      fireEvent.click(edit);

      expect(window.location.pathname).toBe('/app/orders/o2');
    });

    it('encodes an order id in its edit link', async () => {
      const order = makeOrder({ id: 'a/b?c' });
      renderScreen(fakeLoad({ kind: 'loaded', groups: groupWaitingOrders([order]) }).load);

      const edit = await screen.findByRole('link', { name: 'עריכה, ההזמנה של דנה כהן' });
      expect(edit.getAttribute('href')).toBe('/app/orders/a%2Fb%3Fc');
    });

    it('links "הוספת הזמנה" to the add screen', async () => {
      await renderLoaded();

      const add = screen.getByRole('link', { name: 'הוספת הזמנה' });
      expect(add.getAttribute('href')).toBe('/app/orders/new');

      fireEvent.click(add);

      expect(window.location.pathname).toBe('/app/orders/new');
    });

    it('links "תכנון סבב" to the planning screen, right after "הוספת הזמנה"', async () => {
      await renderLoaded();

      const links = screen.getAllByRole('link').map((link) => link.textContent);
      expect(links.slice(0, 2)).toEqual(['הוספת הזמנה', 'תכנון סבב']);
      const plan = screen.getByRole('link', { name: 'תכנון סבב' });
      expect(plan.getAttribute('href')).toBe('/app/orders/plan');

      fireEvent.click(plan);

      expect(window.location.pathname).toBe('/app/orders/plan');
    });
  });

  describe('logged out', () => {
    it('goes to the login in place of the orders tab', async () => {
      const historyLength = window.history.length;
      renderScreen(fakeLoad(LOGGED_OUT).load);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      // Replaced, not pushed: "back" from the login does not bounce off the tab again.
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the tab', async () => {
      const answer = deferred<WaitingOrdersOutcome>();
      const { unmount } = renderScreen(() => answer.promise);
      unmount();
      window.history.replaceState(null, '', '/app/rounds');

      answer.resolve(LOGGED_OUT);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/rounds');
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, and stays on the tab', async () => {
      renderScreen(fakeLoad(FAILED).load);

      expect((await screen.findByRole('alert')).textContent).toBe(ORDERS_LOAD_FAILED_MESSAGE);
      expect(ORDERS_LOAD_FAILED_MESSAGE).toBe(
        'לא הצלחנו לטעון את ההזמנות. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expectOneH1();
      expect(screen.getByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'הוספת הזמנה' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'תכנון סבב' })).toBeDefined();
      expect(screen.queryByRole('region')).toBeNull();
      expect(window.location.pathname).toBe('/app/orders');
    });

    it('treats a rejected load like a failed one', async () => {
      renderScreen(() => Promise.reject(new Error('boom')));

      expect((await screen.findByRole('alert')).textContent).toBe(ORDERS_LOAD_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/orders');
    });

    it('loads again on "לנסות שוב", and shows the orders when that load succeeds', async () => {
      const second = deferred<WaitingOrdersOutcome>();
      const orders = fakeLoad(FAILED, second.promise);
      renderScreen(orders.load);
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(orders.calls()).toBe(2);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();
      expectOneH1();

      second.resolve(LOADED);

      expect(await screen.findByRole('region', { name: 'רמת בית שמש' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לנסות שוב' })).toBeNull();
      expectOneH1();
    });

    it('shows the retry again when the second load fails too', async () => {
      const orders = fakeLoad(FAILED, FAILED);
      renderScreen(orders.load);
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(await screen.findByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(orders.calls()).toBe(2);
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const orders = fakeLoad(LOGGED_OUT, LOADED);
      renderScreen(orders.load, { strict: true });

      expect(await screen.findByRole('region', { name: 'רמת בית שמש' })).toBeDefined();
      expect(orders.calls()).toBe(2);
      expect(window.location.pathname).toBe('/app/orders');
    });
  });
});
