import { StrictMode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_ORDER_MESSAGES, type CustomerOrder } from '@bottlerun/shared';
import {
  NETWORK_ERROR_MESSAGE,
  type CustomerOrderOutcome,
  type CustomerOrderWriteOutcome,
} from '../api.ts';
import { prefillFromNavigationState } from '../orderForm/savedDetails.ts';
import {
  CANCELLED_TEXT,
  COLLECTED_TEXT,
  ORDER_LOAD_FAILED_MESSAGE,
  OrderPage,
  SAVED_MESSAGES,
  WAITING_TEXT,
} from './OrderPage.tsx';

/** A token as the api hands it out: 43 base64url characters. */
const TOKEN = 'Q'.repeat(43);

/** The round of a pending or confirmed order: 12/11, bottles out by 18:00. */
const ROUND = { date: '2026-11-12', pickupBy: '18:00' };

/** A waiting order, as GET /api/o/:token answers it; overrides change it. */
function makeOrder(overrides: Partial<CustomerOrder> = {}): CustomerOrder {
  return {
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'ליד העגלה הכחולה',
    },
    bottlesEstimated: 40,
    status: 'waiting',
    ...overrides,
  };
}

/** A pending order: in a round, its confirmation asked for. */
function pendingOrder(): CustomerOrder {
  return makeOrder({ status: 'pending', round: ROUND });
}

/** A confirmed order: in a round, confirmed. */
function confirmedOrder(): CustomerOrder {
  return makeOrder({ status: 'confirmed', round: ROUND });
}

/** A promise the test settles by hand, to look at the page while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type Answer<T> = T | Promise<T>;

/** A fake that answers each call with the next answer given (the last one repeats). */
function answersInTurn<T>(answers: Answer<T>[]): () => Promise<T> {
  let calls = 0;
  return () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer === undefined) throw new Error('no answer given');
    return Promise.resolve(answer);
  };
}

interface RenderOptions {
  /** The answers of loadOrder, in turn. Default: the order loads. */
  load?: Answer<CustomerOrderOutcome>[];
  /** The answer of confirmOrder. Default: saved, confirmed. */
  confirm?: Answer<CustomerOrderWriteOutcome>;
  /** The answer of declineOrder. Default: saved, back to waiting with no round. */
  decline?: Answer<CustomerOrderWriteOutcome>;
  /** The answer of cancelOrder. Default: saved, cancelled with no round. */
  cancel?: Answer<CustomerOrderWriteOutcome>;
  strict?: boolean;
}

/** The token each fake was called with, in order. */
interface Calls {
  loads: string[];
  confirms: string[];
  declines: string[];
  cancels: string[];
  unmount: () => void;
}

/** Opens the page of `order` at /o/<token>, with fakes that record every call. */
function renderPage(
  order: CustomerOrder = makeOrder(),
  { load, confirm, decline, cancel, strict = false }: RenderOptions = {},
): Calls {
  window.history.replaceState(null, '', `/o/${TOKEN}`);
  const calls: Omit<Calls, 'unmount'> = { loads: [], confirms: [], declines: [], cancels: [] };
  const nextLoad = answersInTurn(load ?? [{ kind: 'loaded', order }]);
  // The order without its round, as the api answers once it left the round or was cancelled.
  const outOfRound = { ...order };
  delete outOfRound.round;
  const element = (
    <OrderPage
      token={TOKEN}
      loadOrder={(token) => {
        calls.loads.push(token);
        return nextLoad();
      }}
      confirmOrder={(token) => {
        calls.confirms.push(token);
        return Promise.resolve(
          confirm ?? { kind: 'saved', order: { ...order, status: 'confirmed' } },
        );
      }}
      declineOrder={(token) => {
        calls.declines.push(token);
        return Promise.resolve(
          decline ?? { kind: 'saved', order: { ...outOfRound, status: 'waiting' } },
        );
      }}
      cancelOrder={(token) => {
        calls.cancels.push(token);
        return Promise.resolve(
          cancel ?? { kind: 'saved', order: { ...outOfRound, status: 'cancelled' } },
        );
      }}
    />
  );
  const { unmount } = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return { ...calls, unmount };
}

/** Renders the page of `order` and waits for its details. */
async function renderLoaded(
  order: CustomerOrder = makeOrder(),
  options: RenderOptions = {},
): Promise<Calls> {
  const calls = renderPage(order, options);
  await screen.findByRole('heading', { level: 2, name: 'פרטי ההזמנה' });
  return calls;
}

/** The page has exactly one h1, and it is "ההזמנה שלך". */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'ההזמנה שלך' })).toBeDefined();
}

/** The element whose whole text is `text`, across the `<bdi>` inside it. */
function getByWholeText(text: string): HTMLElement {
  return screen.getByText((_content, element) => element?.textContent === text);
}

/** The order's status as the page says it ("מצב ההזמנה: ..."). */
function statusLabel(): string {
  return screen.getByText('מצב ההזמנה:', { exact: false }).textContent ?? '';
}

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function click(name: string): void {
  fireEvent.click(button(name));
}

describe('OrderPage', () => {
  describe('while the order loads', () => {
    it('shows the heading and a loading status, and no button', () => {
      renderPage(makeOrder(), { load: [deferred<CustomerOrderOutcome>().promise] });

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('loads the order of its token', async () => {
      const calls = await renderLoaded();

      expect(calls.loads).toEqual([TOKEN]);
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, and loads again on "לנסות שוב"', async () => {
      const second = deferred<CustomerOrderOutcome>();
      const calls = renderPage(makeOrder(), { load: [{ kind: 'failed' }, second.promise] });

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LOAD_FAILED_MESSAGE);
      expect(ORDER_LOAD_FAILED_MESSAGE).toBe(
        'לא הצלחנו לטעון את ההזמנה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expectOneH1();

      click('לנסות שוב');

      expect(calls.loads).toEqual([TOKEN, TOKEN]);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();

      second.resolve({ kind: 'loaded', order: makeOrder() });

      expect(await screen.findByText('דנה כהן')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לנסות שוב' })).toBeNull();
      expectOneH1();
    });

    it('treats a rejected load like a failed one', async () => {
      render(<OrderPage token={TOKEN} loadOrder={() => Promise.reject(new Error('boom'))} />);

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LOAD_FAILED_MESSAGE);
    });
  });

  describe('when no order has the token', () => {
    it('says the link may be cut short, with a way to the booking form', async () => {
      renderPage(makeOrder(), { load: [{ kind: 'notFound' }] });

      expect((await screen.findByRole('alert')).textContent).toBe(
        CUSTOMER_ORDER_MESSAGES.orderNotFound,
      );
      expect(screen.getByRole('link', { name: 'לטופס ההזמנה' }).getAttribute('href')).toBe('/');
      expect(screen.queryByRole('button')).toBeNull();
      expectOneH1();
    });
  });

  describe('a waiting order', () => {
    it('says it waits for a round, and what comes next', async () => {
      await renderLoaded();

      expectOneH1();
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
      expect(screen.getByText(WAITING_TEXT)).toBeDefined();
      expect(WAITING_TEXT).toBe('נשלח לך הודעת WhatsApp לפני הסבב באזור שלך.');
    });

    it("shows the order's details: name, phone, address, spot, note and bottles", async () => {
      await renderLoaded();

      const details = within(screen.getByRole('region', { name: 'פרטי ההזמנה' }));
      expect(details.getByText('דנה כהן')).toBeDefined();
      expect(details.getByText('050-1234567')).toBeDefined();
      expect(details.getByText('דרך רבין יצחק 12')).toBeDefined();
      expect(details.getByText('ליד דלת הדירה · קומה 3, דירה 12')).toBeDefined();
      expect(details.getByText('ליד העגלה הכחולה')).toBeDefined();
      expect(details.getByText('40')).toBeDefined();
    });

    it('renders the phone left to right inside the right-to-left page', async () => {
      await renderLoaded();

      expect(screen.getByText('050-1234567').closest('[dir="ltr"]')).not.toBeNull();
    });

    it('leaves out the note when there is none', async () => {
      const order = makeOrder();
      delete order.address.note;
      await renderLoaded(order);

      expect(screen.queryByText('הערה')).toBeNull();
    });

    it('offers the cancel, and neither the confirm nor a new order', async () => {
      await renderLoaded();

      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'מאשר/ת איסוף' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'הזמנה חדשה עם אותם פרטים' })).toBeNull();
    });
  });

  describe('a pending order', () => {
    it("shows the round's day and the time to put the bottles out by, left to right", async () => {
      await renderLoaded(pendingOrder());

      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לאישור');
      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
      expect(screen.getByText('12/11').getAttribute('dir')).toBe('ltr');
      expect(getByWholeText('נא להוציא את הבקבוקים עד השעה 18:00.')).toBeDefined();
      expect(screen.getByText('18:00').getAttribute('dir')).toBe('ltr');
    });

    it('leaves out the time when the round has none', async () => {
      await renderLoaded(makeOrder({ status: 'pending', round: { date: '2026-11-12' } }));

      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
      expect(screen.queryByText('נא להוציא את הבקבוקים', { exact: false })).toBeNull();
    });

    it('offers "מאשר/ת איסוף", "לא מתאים הפעם" and the cancel', async () => {
      await renderLoaded(pendingOrder());

      expect(button('מאשר/ת איסוף')).toBeDefined();
      expect(button('לא מתאים הפעם')).toBeDefined();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'הזמנה חדשה עם אותם פרטים' })).toBeNull();
    });

    it('confirms on "מאשר/ת איסוף" and shows the confirmed order, with thanks', async () => {
      const calls = await renderLoaded(pendingOrder());

      click('מאשר/ת איסוף');

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe('תודה! האיסוף אושר.');
      expect(document.activeElement).toBe(notice);
      expect(statusLabel()).toBe('מצב ההזמנה: אושרה');
      expect(getByWholeText('נתראה ב-12/11.')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'מאשר/ת איסוף' })).toBeNull();
      expect(calls.confirms).toEqual([TOKEN]);
    });

    it('sends one request for a double tap, saying "שולח..." meanwhile', async () => {
      const answer = deferred<CustomerOrderWriteOutcome>();
      const calls = await renderLoaded(pendingOrder(), { confirm: answer.promise });

      click('מאשר/ת איסוף');

      const busy = button('שולח...');
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      expect(button('לא מתאים הפעם').getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      click('לא מתאים הפעם');
      expect(calls.confirms).toEqual([TOKEN]);
      expect(calls.declines).toEqual([]);

      answer.resolve({ kind: 'saved', order: confirmedOrder() });

      expect(await screen.findByText('תודה! האיסוף אושר.')).toBeDefined();
      expect(calls.confirms).toEqual([TOKEN]);
    });

    it('takes the order out of the round on "לא מתאים הפעם"', async () => {
      const calls = await renderLoaded(pendingOrder());

      click('לא מתאים הפעם');

      expect((await screen.findByRole('status')).textContent).toBe(
        'קיבלנו. נחזור אליך עם מועד חדש.',
      );
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
      expect(screen.getByText(WAITING_TEXT)).toBeDefined();
      expect(screen.queryByRole('button', { name: 'מאשר/ת איסוף' })).toBeNull();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(calls.declines).toEqual([TOKEN]);
      expect(calls.confirms).toEqual([]);
    });

    it('says the confirmations closed, and loads the order again keeping the message', async () => {
      const reload = deferred<CustomerOrderOutcome>();
      const calls = await renderLoaded(pendingOrder(), {
        load: [{ kind: 'loaded', order: pendingOrder() }, reload.promise],
        confirm: { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.confirmationsClosed },
      });

      click('מאשר/ת איסוף');

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('האישור נסגר. נחזור אליך עם מועד חדש.');
      expect(document.activeElement).toBe(alert);
      expect(calls.loads).toEqual([TOKEN, TOKEN]);
      expect(screen.getByRole('status').textContent).toBe('טוען...');

      reload.resolve({ kind: 'loaded', order: makeOrder() });

      expect(await screen.findByText(WAITING_TEXT)).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe('האישור נסגר. נחזור אליך עם מועד חדש.');
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
      expectOneH1();
    });

    it.each([
      ['failed', { kind: 'failed' }],
      ['invalid', { kind: 'invalid', errors: { byField: {} } }],
    ] as const)(
      'asks to check the connection when the confirm answers %s, and keeps the page',
      async (_kind, outcome) => {
        const calls = await renderLoaded(pendingOrder(), { confirm: outcome });

        click('מאשר/ת איסוף');

        expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
        expect(NETWORK_ERROR_MESSAGE).toBe(
          'לא הצלחנו לשלוח. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
        );
        expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לאישור');
        expect(button('מאשר/ת איסוף').getAttribute('aria-disabled')).toBeNull();
        expect(calls.loads).toEqual([TOKEN]);
      },
    );

    it('treats a rejected confirm like a failed one', async () => {
      render(
        <OrderPage
          token={TOKEN}
          loadOrder={() => Promise.resolve({ kind: 'loaded', order: pendingOrder() })}
          confirmOrder={() => Promise.reject(new Error('boom'))}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'מאשר/ת איסוף' }));

      expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
      expect(button('מאשר/ת איסוף')).toBeDefined();
    });

    it('says the order was not found when the confirm answers so', async () => {
      await renderLoaded(pendingOrder(), { confirm: { kind: 'notFound' } });

      click('מאשר/ת איסוף');

      expect((await screen.findByRole('alert')).textContent).toBe(
        CUSTOMER_ORDER_MESSAGES.orderNotFound,
      );
      expect(screen.getByRole('link', { name: 'לטופס ההזמנה' })).toBeDefined();
    });
  });

  describe('a confirmed order', () => {
    it('says "נתראה ב-<date>" with the time, and offers the cancel only', async () => {
      await renderLoaded(confirmedOrder());

      expect(statusLabel()).toBe('מצב ההזמנה: אושרה');
      expect(getByWholeText('נתראה ב-12/11.')).toBeDefined();
      expect(getByWholeText('נא להוציא את הבקבוקים עד השעה 18:00.')).toBeDefined();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'מאשר/ת איסוף' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
    });
  });

  describe('a collected order', () => {
    it('thanks the customer, with the details and no cancel', async () => {
      await renderLoaded(makeOrder({ status: 'collected' }));

      expect(statusLabel()).toBe('מצב ההזמנה: נאספה');
      expect(screen.getByText(COLLECTED_TEXT)).toBeDefined();
      expect(COLLECTED_TEXT).toBe('ההזמנה נאספה. תודה רבה שלקחתם חלק בלתת עוד!');
      expect(screen.getByText('דנה כהן')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
    });
  });

  describe('a cancelled order', () => {
    it('says so with thanks, with the details and no cancel', async () => {
      await renderLoaded(makeOrder({ status: 'cancelled' }));

      expect(statusLabel()).toBe('מצב ההזמנה: בוטלה');
      expect(screen.getByText(CANCELLED_TEXT)).toBeDefined();
      expect(screen.getByText('דנה כהן')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
    });
  });

  describe.each(['collected', 'cancelled'] as const)(
    '"הזמנה חדשה עם אותם פרטים" on a %s order',
    (status) => {
      it('opens the booking form with the same contact and address, not the bottles', async () => {
        const order = makeOrder({ status });
        await renderLoaded(order);
        const historyLength = window.history.length;

        click('הזמנה חדשה עם אותם פרטים');

        expect(window.location.pathname).toBe('/');
        // A new entry, so "back" returns to this page.
        expect(window.history.length).toBe(historyLength + 1);
        const state: unknown = window.history.state;
        expect(prefillFromNavigationState(state)).toEqual({
          contact: order.contact,
          address: order.address,
        });
        expect(JSON.stringify(state)).not.toContain('bottlesEstimated');
      });
    },
  );

  describe('cancelling', () => {
    it('asks first, in plain words, with focus on the question', async () => {
      const calls = await renderLoaded();

      click('ביטול ההזמנה');

      const question = screen.getByText('לבטל את ההזמנה?');
      expect(document.activeElement).toBe(question);
      expect(screen.getByRole('group', { name: 'לבטל את ההזמנה?' })).toBeDefined();
      expect(button('כן, לבטל')).toBeDefined();
      expect(button('לא, להשאיר')).toBeDefined();
      expect(calls.cancels).toEqual([]);
    });

    it('sends nothing on "לא, להשאיר", with focus back on "ביטול ההזמנה"', async () => {
      const calls = await renderLoaded();
      click('ביטול ההזמנה');

      click('לא, להשאיר');

      expect(screen.queryByText('לבטל את ההזמנה?')).toBeNull();
      expect(document.activeElement).toBe(button('ביטול ההזמנה'));
      expect(calls.cancels).toEqual([]);
    });

    it('cancels once on "כן, לבטל" and shows the cancelled order', async () => {
      const answer = deferred<CustomerOrderWriteOutcome>();
      const calls = await renderLoaded(pendingOrder(), { cancel: answer.promise });
      click('ביטול ההזמנה');

      click('כן, לבטל');
      const busy = button('מבטל...');
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      click('מאשר/ת איסוף');
      expect(calls.cancels).toEqual([TOKEN]);
      expect(calls.confirms).toEqual([]);

      answer.resolve({ kind: 'saved', order: makeOrder({ status: 'cancelled' }) });

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe(SAVED_MESSAGES.cancel);
      expect(SAVED_MESSAGES.cancel).toBe('ההזמנה בוטלה.');
      expect(document.activeElement).toBe(notice);
      expect(statusLabel()).toBe('מצב ההזמנה: בוטלה');
      expect(button('הזמנה חדשה עם אותם פרטים')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
      expect(calls.cancels).toEqual([TOKEN]);
    });

    it('keeps the question open with the network message when the cancel fails', async () => {
      await renderLoaded(makeOrder(), { cancel: { kind: 'failed' } });
      click('ביטול ההזמנה');

      click('כן, לבטל');

      const question = screen.getByRole('group', { name: 'לבטל את ההזמנה?' });
      expect((await within(question).findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
      expect(within(question).getByRole('button', { name: 'כן, לבטל' })).toBeDefined();
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
    });

    it('says the order closed, and loads it again, when it was collected meanwhile', async () => {
      const calls = await renderLoaded(makeOrder(), {
        load: [
          { kind: 'loaded', order: makeOrder() },
          { kind: 'loaded', order: makeOrder({ status: 'collected' }) },
        ],
        cancel: { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed },
      });
      click('ביטול ההזמנה');

      click('כן, לבטל');

      expect(await screen.findByText(COLLECTED_TEXT)).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe(CUSTOMER_ORDER_MESSAGES.orderClosed);
      expect(calls.loads).toEqual([TOKEN, TOKEN]);
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const calls = renderPage(makeOrder(), {
        load: [{ kind: 'notFound' }, { kind: 'loaded', order: makeOrder() }],
        strict: true,
      });

      expect(await screen.findByText('דנה כהן')).toBeDefined();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(calls.loads).toHaveLength(2);
    });
  });
});
