import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
  customerOrderSchema,
  t,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
} from '@bottlerun/shared';
import { deferred } from '@bottlerun/shared/testing';
import { NETWORK_ERROR_MESSAGE } from '../api/request.ts';
import type { CustomerOrderOutcome, CustomerOrderWriteOutcome } from '../api/customerOrderApi.ts';
import { renderWithApi } from '../api/renderWithApi.tsx';
import { SAVE_FAILED_MESSAGE, UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { prefillFromNavigationState } from '../orderForm/savedDetails.ts';
import { OrderPage } from './OrderPage.tsx';

/** A token as the api hands it out: 43 base64url characters. */
const TOKEN = 'Q'.repeat(43);

/** The round of an order in a round (confirmed, or a legacy pending): 12/11, out by 18:00. */
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
    lang: 'he',
    ...overrides,
  };
}

/** A legacy pending order: planned before ADR-0012, when the customer was asked to confirm. */
function pendingOrder(): CustomerOrder {
  return makeOrder({ status: 'pending', round: ROUND });
}

/** An order in a round: since ADR-0012 planning moves it straight to confirmed. */
function confirmedOrder(): CustomerOrder {
  return makeOrder({ status: 'confirmed', round: ROUND });
}

/**
 * The order as the api answers a change that keeps it where it is: the request's address and
 * bottles in place of the stored ones. Parsed, so a request the page built wrong fails here.
 */
function withChange(order: CustomerOrder, request: CustomerUpdateOrderRequest): CustomerOrder {
  return customerOrderSchema.parse({ ...order, ...request });
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
  /** The answers of fetchCustomerOrder, in turn. Default: the order loads. */
  load?: Answer<CustomerOrderOutcome>[];
  /** The answer of declineCustomerOrder. Default: saved, back to waiting with no round. */
  decline?: Answer<CustomerOrderWriteOutcome>;
  /** The answer of cancelCustomerOrder. Default: saved, cancelled with no round. */
  cancel?: Answer<CustomerOrderWriteOutcome>;
  /** The answer of updateCustomerOrder. Default: saved, the order with the change applied. */
  update?: Answer<CustomerOrderWriteOutcome>;
  strict?: boolean;
}

/** The token each fake was called with, in order. */
interface Calls {
  loads: string[];
  declines: string[];
  cancels: string[];
  updates: { token: string; request: CustomerUpdateOrderRequest }[];
  unmount: () => void;
}

/** Opens the page of `order` at /o/<token>, with fakes (through the ApiProvider) that record every call. */
function renderPage(
  order: CustomerOrder = makeOrder(),
  { load, decline, cancel, update, strict = false }: RenderOptions = {},
): Calls {
  window.history.replaceState(null, '', `/o/${TOKEN}`);
  const calls: Omit<Calls, 'unmount'> = {
    loads: [],
    declines: [],
    cancels: [],
    updates: [],
  };
  const nextLoad = answersInTurn(load ?? [{ kind: 'loaded', order }]);
  // The order without its round, as the api answers once it left the round or was cancelled.
  const outOfRound = { ...order };
  delete outOfRound.round;
  // StrictMode goes around the whole tree, provider included (`reactStrictMode`): nested under the
  // provider, it did not run the load's effect twice.
  const { unmount } = renderWithApi(
    <OrderPage token={TOKEN} />,
    {
      fetchCustomerOrder: (token) => {
        calls.loads.push(token);
        return nextLoad();
      },
      declineCustomerOrder: (token) => {
        calls.declines.push(token);
        return Promise.resolve(
          decline ?? { kind: 'saved', order: { ...outOfRound, status: 'waiting' } },
        );
      },
      cancelCustomerOrder: (token) => {
        calls.cancels.push(token);
        return Promise.resolve(
          cancel ?? { kind: 'saved', order: { ...outOfRound, status: 'cancelled' } },
        );
      },
      updateCustomerOrder: (token, request) => {
        calls.updates.push({ token, request });
        return Promise.resolve(update ?? { kind: 'saved', order: withChange(order, request) });
      },
    },
    { reactStrictMode: strict },
  );
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

/** The input labelled `label`. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

/** Types `value` into the input labelled `label`. */
function fillIn(label: string, value: string): void {
  fireEvent.change(input(label), { target: { value } });
}

/** The text of everything `element` is described by (aria-describedby): its hint and error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** The warning that a new address takes the order out of its round of 12/11. */
const LEAVE_ROUND_WARNING = 'שינוי הכתובת יוציא את ההזמנה מהסבב ב-12/11, ונחזור אליך עם מועד חדש.';

/** The leave-round warning, or null when the page shows none. */
function queryLeaveRoundWarning(): HTMLElement | null {
  return screen.queryByText((_content, element) =>
    (element?.textContent ?? '').startsWith('שינוי הכתובת יוציא את ההזמנה מהסבב'),
  );
}

/** Renders the page of `order`, waits for it, and opens "שינוי". */
async function openChange(
  order: CustomerOrder = makeOrder(),
  options: RenderOptions = {},
): Promise<Calls> {
  const calls = await renderLoaded(order, options);
  click('שינוי');
  return calls;
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

      expect((await screen.findByRole('alert')).textContent).toBe(t('he', 'orderPage.loadFailed'));
      expect(t('he', 'orderPage.loadFailed')).toBe(
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
      renderWithApi(<OrderPage token={TOKEN} />, {
        fetchCustomerOrder: () => Promise.reject(new Error('boom')),
      });

      expect((await screen.findByRole('alert')).textContent).toBe(t('he', 'orderPage.loadFailed'));
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
      expect(screen.getByText(t('he', 'orderPage.waiting'))).toBeDefined();
      expect(t('he', 'orderPage.waiting')).toBe('נשלח לך הודעת WhatsApp לפני הסבב באזור שלך.');
      // The status is a badge with the status in words (not colour alone), inside a card.
      expect(screen.getByText('ממתינה לסבב').closest('.badge')).not.toBeNull();
    });

    it('puts the status and the sentence that explains it in one card', async () => {
      await renderLoaded();

      const card = screen.getByText('מצב ההזמנה:', { exact: false }).closest('.card');
      expect(card).not.toBeNull();
      expect(card?.contains(screen.getByText(t('he', 'orderPage.waiting')))).toBe(true);
    });

    it('draws each detail as one row: its name, then its value', async () => {
      await renderLoaded();

      const details = screen.getByRole('region', { name: 'פרטי ההזמנה' });
      const rows = Array.from(details.querySelectorAll('dl > div')).map((row) =>
        Array.from(row.children).map((cell) => `${cell.tagName}:${cell.textContent}`),
      );
      expect(rows).toEqual([
        ['DT:שם', 'DD:דנה כהן'],
        ['DT:טלפון', 'DD:050-1234567'],
        ['DT:כתובת', 'DD:דרך רבין יצחק 12'],
        ['DT:איפה הבקבוקים', 'DD:בבניין - ליד דלת הדירה · קומה 3, דירה 12'],
        ['DT:הערה', 'DD:ליד העגלה הכחולה'],
        ['DT:כמות בקבוקים', 'DD:40'],
      ]);
    });

    it('sets "ביטול ההזמנה" apart from "שינוי", in the red outline', async () => {
      await renderLoaded();

      const cancel = button('ביטול ההזמנה');
      expect(cancel.className).toContain('button-danger-outline');
      // Its own block under a line (.cancel-order), which "שינוי" is not part of.
      const cancelBlock = cancel.closest('.cancel-order');
      expect(cancelBlock).not.toBeNull();
      expect(cancelBlock?.contains(button('שינוי'))).toBe(false);
    });

    it("shows the order's details: name, phone, address, spot, note and bottles", async () => {
      await renderLoaded();

      const details = within(screen.getByRole('region', { name: 'פרטי ההזמנה' }));
      expect(details.getByText('דנה כהן')).toBeDefined();
      expect(details.getByText('050-1234567')).toBeDefined();
      expect(details.getByText('דרך רבין יצחק 12')).toBeDefined();
      expect(details.getByText('בבניין - ליד דלת הדירה · קומה 3, דירה 12')).toBeDefined();
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

    it('offers the cancel, and neither "לא מתאים הפעם" nor a new order', async () => {
      await renderLoaded();

      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'הזמנה חדשה עם אותם פרטים' })).toBeNull();
    });
  });

  describe('an order in a round', () => {
    it("shows the round's day and the time to put the bottles out by, left to right", async () => {
      await renderLoaded(confirmedOrder());

      expect(statusLabel()).toBe('מצב ההזמנה: בסבב');
      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
      expect(screen.getByText('12/11').getAttribute('dir')).toBe('ltr');
      expect(getByWholeText('נא להוציא את הבקבוקים החוצה עד השעה 18:00.')).toBeDefined();
      expect(screen.getByText('18:00').getAttribute('dir')).toBe('ltr');
    });

    it('says the start twice when the round has a window: out by it, and when Yoel comes', async () => {
      await renderLoaded(
        makeOrder({
          status: 'confirmed',
          round: { date: '2026-11-12', pickupFrom: '16:00', pickupBy: '18:00' },
        }),
      );

      expect(
        getByWholeText(
          'נא להוציא את הבקבוקים החוצה עד השעה 16:00. נגיע לאסוף בין השעות 16:00 עד 18:00.',
        ),
      ).toBeDefined();
      const starts = screen.getAllByText('16:00');
      expect(starts).toHaveLength(2);
      for (const start of starts) expect(start.getAttribute('dir')).toBe('ltr');
      expect(screen.getByText('18:00').getAttribute('dir')).toBe('ltr');
    });

    it('leaves out the time when the round has none', async () => {
      await renderLoaded(makeOrder({ status: 'confirmed', round: { date: '2026-11-12' } }));

      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
      expect(screen.queryByText('נא להוציא את הבקבוקים', { exact: false })).toBeNull();
    });

    it('offers "לא מתאים הפעם", the change and the cancel, and nothing to confirm', async () => {
      await renderLoaded(confirmedOrder());

      expect(button('לא מתאים הפעם')).toBeDefined();
      expect(button('שינוי')).toBeDefined();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: /כן, אוציא את הבקבוקים/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'הזמנה חדשה עם אותם פרטים' })).toBeNull();
    });

    it('takes the order out of the round on "לא מתאים הפעם"', async () => {
      const calls = await renderLoaded(confirmedOrder());

      click('לא מתאים הפעם');
      click('כן, לא מתאים');

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe('קיבלנו. נחזור אליך עם מועד חדש.');
      // The button just tapped is gone, so the focus goes to the notice that says what happened.
      expect(document.activeElement).toBe(notice);
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
      expect(screen.getByText(t('he', 'orderPage.waiting'))).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(calls.declines).toEqual([TOKEN]);
    });

    it('asks first on "לא מתאים הפעם", and sends nothing on "לא, להשאיר"', async () => {
      const calls = await renderLoaded(confirmedOrder());

      click('לא מתאים הפעם');

      const question = screen.getByText('לא מתאים לך הפעם? ההזמנה תחכה לסבב הבא.');
      expect(document.activeElement).toBe(question);
      expect(calls.declines).toEqual([]);

      click('לא, להשאיר');

      expect(screen.queryByText('לא מתאים לך הפעם? ההזמנה תחכה לסבב הבא.')).toBeNull();
      expect(document.activeElement).toBe(button('לא מתאים הפעם'));
      expect(calls.declines).toEqual([]);
    });

    it('sends one request for a double tap on "כן, לא מתאים", saying "שולח..." meanwhile', async () => {
      const answer = deferred<CustomerOrderWriteOutcome>();
      const calls = await renderLoaded(confirmedOrder(), { decline: answer.promise });
      click('לא מתאים הפעם');

      click('כן, לא מתאים');

      // Announced as unavailable while on its way, yet still focusable (aria-disabled, not disabled).
      expect(button('שולח...').getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button('שולח...'));
      expect(calls.declines).toEqual([TOKEN]);

      answer.resolve({ kind: 'saved', order: makeOrder() });

      expect(await screen.findByText('קיבלנו. נחזור אליך עם מועד חדש.')).toBeDefined();
      expect(calls.declines).toEqual([TOKEN]);
    });

    it.each([
      ['failed', { kind: 'failed' }],
      ['invalid', { kind: 'invalid', errors: { byField: {} } }],
    ] as const)(
      'keeps the question open with the network message when "לא מתאים הפעם" answers %s',
      async (_kind, outcome) => {
        const calls = await renderLoaded(confirmedOrder(), { decline: outcome });
        click('לא מתאים הפעם');

        click('כן, לא מתאים');

        const question = screen.getByRole('group', {
          name: 'לא מתאים לך הפעם? ההזמנה תחכה לסבב הבא.',
        });
        expect((await within(question).findByRole('alert')).textContent).toBe(
          NETWORK_ERROR_MESSAGE,
        );
        expect(NETWORK_ERROR_MESSAGE).toBe(
          'לא הצלחנו לשלוח. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
        );
        expect(statusLabel()).toBe('מצב ההזמנה: בסבב');
        expect(calls.loads).toEqual([TOKEN]);
      },
    );

    it('treats a rejected "לא מתאים הפעם" like a failed one', async () => {
      renderWithApi(<OrderPage token={TOKEN} />, {
        fetchCustomerOrder: () => Promise.resolve({ kind: 'loaded', order: confirmedOrder() }),
        declineCustomerOrder: () => Promise.reject(new Error('boom')),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'לא מתאים הפעם' }));

      click('כן, לא מתאים');

      expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
      expect(button('כן, לא מתאים')).toBeDefined();
    });

    it('says the order closed, and loads it again keeping the message, when it was collected meanwhile', async () => {
      const reload = deferred<CustomerOrderOutcome>();
      const calls = await renderLoaded(confirmedOrder(), {
        load: [{ kind: 'loaded', order: confirmedOrder() }, reload.promise],
        decline: { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed },
      });
      click('לא מתאים הפעם');

      click('כן, לא מתאים');

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.');
      expect(document.activeElement).toBe(alert);
      expect(calls.loads).toEqual([TOKEN, TOKEN]);

      reload.resolve({ kind: 'loaded', order: makeOrder({ status: 'collected' }) });

      expect(await screen.findByText(t('he', 'orderPage.collected'))).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe('ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.');
      expectOneH1();
    });

    it('says the order was not found when "לא מתאים הפעם" answers so', async () => {
      await renderLoaded(confirmedOrder(), { decline: { kind: 'notFound' } });
      click('לא מתאים הפעם');

      click('כן, לא מתאים');

      expect((await screen.findByRole('alert')).textContent).toBe(
        CUSTOMER_ORDER_MESSAGES.orderNotFound,
      );
      expect(screen.getByRole('link', { name: 'לטופס ההזמנה' })).toBeDefined();
    });
  });

  describe('a legacy pending order (planned before ADR-0012)', () => {
    it('shows the round like a confirmed one, with "לא מתאים הפעם" and nothing to confirm', async () => {
      const calls = await renderLoaded(pendingOrder());

      expect(statusLabel()).toBe('מצב ההזמנה: בסבב');
      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
      expect(getByWholeText('נא להוציא את הבקבוקים החוצה עד השעה 18:00.')).toBeDefined();
      expect(button('ביטול ההזמנה')).toBeDefined();
      expect(screen.queryByRole('button', { name: /כן, אוציא את הבקבוקים/ })).toBeNull();

      click('לא מתאים הפעם');
      click('כן, לא מתאים');

      expect(await screen.findByText('קיבלנו. נחזור אליך עם מועד חדש.')).toBeDefined();
      expect(calls.declines).toEqual([TOKEN]);
    });
  });

  describe('a collected order', () => {
    it('thanks the customer, with the details and no cancel', async () => {
      await renderLoaded(makeOrder({ status: 'collected' }));

      expect(statusLabel()).toBe('מצב ההזמנה: נאספה');
      expect(screen.getByText(t('he', 'orderPage.collected'))).toBeDefined();
      expect(t('he', 'orderPage.collected')).toBe('ההזמנה נאספה. תודה רבה שלקחתם חלק בלתת עוד!');
      expect(screen.getByText('דנה כהן')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
    });
  });

  describe('a cancelled order', () => {
    it('says so with thanks, with the details and no cancel', async () => {
      await renderLoaded(makeOrder({ status: 'cancelled' }));

      expect(statusLabel()).toBe('מצב ההזמנה: בוטלה');
      expect(screen.getByText(t('he', 'orderPage.cancelled'))).toBeDefined();
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
      const calls = await renderLoaded(confirmedOrder(), { cancel: answer.promise });
      click('ביטול ההזמנה');

      click('כן, לבטל');
      const busy = button('מבטל...');
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      // "לא מתאים הפעם" only opens its question; even its "כן" sends nothing while one is on its way.
      click('לא מתאים הפעם');
      click('כן, לא מתאים');
      expect(calls.cancels).toEqual([TOKEN]);
      expect(calls.declines).toEqual([]);

      answer.resolve({ kind: 'saved', order: makeOrder({ status: 'cancelled' }) });

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe(t('he', 'orderPage.saved.cancel'));
      expect(t('he', 'orderPage.saved.cancel')).toBe('ההזמנה בוטלה.');
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

      expect(await screen.findByText(t('he', 'orderPage.collected'))).toBeDefined();
      expect(screen.getByRole('alert').textContent).toBe(CUSTOMER_ORDER_MESSAGES.orderClosed);
      expect(calls.loads).toEqual([TOKEN, TOKEN]);
    });
  });

  describe('changing the order ("שינוי")', () => {
    it.each([
      ['waiting', makeOrder()],
      ['pending', pendingOrder()],
      ['confirmed', confirmedOrder()],
    ] as const)('offers "שינוי" on a %s order', async (_status, order) => {
      await renderLoaded(order);

      expect(button('שינוי')).toBeDefined();
    });

    it.each(['collected', 'cancelled'] as const)(
      'offers no "שינוי" on a %s order',
      async (status) => {
        await renderLoaded(makeOrder({ status }));

        expect(screen.queryByRole('button', { name: 'שינוי' })).toBeNull();
      },
    );

    it("opens a form filled with the order's details, with no name or phone field", async () => {
      await openChange();

      const heading = screen.getByRole('heading', { level: 2, name: 'שינוי פרטי ההזמנה' });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByText(t('he', 'orderPage.phoneNotChanged'))).toBeDefined();
      expect(t('he', 'orderPage.phoneNotChanged')).toBe('את מספר הטלפון אי אפשר לשנות כאן.');
      expect(input('רחוב').value).toBe('דרך רבין יצחק');
      expect(input('מספר בית').value).toBe('12');
      expect(input('בבניין - ליד דלת הדירה').checked).toBe(true);
      expect(input('קומה ודירה').value).toBe('קומה 3, דירה 12');
      expect(input('הערה (לא חובה)').value).toBe('ליד העגלה הכחולה');
      expect(input('כמות בקבוקים').value).toBe('40');
      expect(screen.queryByLabelText('שם')).toBeNull();
      expect(screen.queryByLabelText('טלפון נייד')).toBeNull();
      expect(document.querySelector('input[type="tel"]')).toBeNull();
      expect(screen.queryByDisplayValue('050-1234567')).toBeNull();
      expectOneH1();
    });

    it("shows the form in place of the order's details and buttons", async () => {
      await openChange(confirmedOrder());

      expect(screen.queryByRole('region', { name: 'פרטי ההזמנה' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'שינוי' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
      expect(button('שמירת השינויים')).toBeDefined();
      expect(button('בלי לשנות')).toBeDefined();
      // The status and the round's date stay above the form.
      expect(statusLabel()).toBe('מצב ההזמנה: בסבב');
      expect(getByWholeText('נעבור לאסוף ב-12/11.')).toBeDefined();
    });

    it('saves a new note with the address and the bottles, never the contact', async () => {
      const calls = await openChange();

      fillIn('הערה (לא חובה)', ' קוד 1234 ');
      click('שמירת השינויים');

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe('השינויים נשמרו.');
      expect(t('he', 'orderPage.saved.change')).toBe('השינויים נשמרו.');
      expect(document.activeElement).toBe(notice);
      expect(calls.updates).toEqual([
        {
          token: TOKEN,
          request: {
            address: {
              streetCode: 247,
              streetName: 'דרך רבין יצחק',
              houseNumber: '12',
              bottlesSpot: 'apartmentDoor',
              floorApt: 'קומה 3, דירה 12',
              note: 'קוד 1234',
            },
            bottlesEstimated: 40,
          },
        },
      ]);
      expect(calls.updates[0]?.request).not.toHaveProperty('contact');
      // The form closed, and the page draws the order the api answered with.
      expect(screen.queryByRole('button', { name: 'שמירת השינויים' })).toBeNull();
      const details = within(screen.getByRole('region', { name: 'פרטי ההזמנה' }));
      expect(details.getByText('קוד 1234')).toBeDefined();
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
    });

    it('says "שומר..." while saving, and sends one request for a double tap', async () => {
      const answer = deferred<CustomerOrderWriteOutcome>();
      const calls = await openChange(makeOrder(), { update: answer.promise });

      click('שמירת השינויים');

      const busy = button('שומר...');
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      expect(button('בלי לשנות').getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      // "בלי לשנות" waits for the answer on its way.
      click('בלי לשנות');
      expect(button('שומר...')).toBeDefined();
      expect(calls.updates).toHaveLength(1);

      answer.resolve({ kind: 'saved', order: makeOrder({ bottlesEstimated: 40 }) });

      expect(await screen.findByText('השינויים נשמרו.')).toBeDefined();
      expect(calls.updates).toHaveLength(1);
    });

    it('refuses fewer than 20 bottles next to the field, and sends nothing', async () => {
      const calls = await openChange();

      fillIn('כמות בקבוקים', '19');
      click('שמירת השינויים');

      const bottles = input('כמות בקבוקים');
      expect(bottles.getAttribute('aria-invalid')).toBe('true');
      expect(descriptionOf(bottles)).toContain('צריך לפחות 20 בקבוקים');
      expect(document.activeElement).toBe(bottles);
      expect(calls.updates).toEqual([]);
    });

    it('warns before saving that a new house number takes an order out of its round', async () => {
      const calls = await openChange(confirmedOrder(), {
        update: {
          kind: 'saved',
          order: makeOrder({ address: { ...makeOrder().address, houseNumber: '14' } }),
        },
      });
      expect(queryLeaveRoundWarning()).toBeNull();

      fillIn('מספר בית', '14');

      expect(getByWholeText(LEAVE_ROUND_WARNING)).toBeDefined();
      expect(screen.getAllByText('12/11').at(-1)?.getAttribute('dir')).toBe('ltr');
      expect(descriptionOf(button('שמירת השינויים'))).toBe(LEAVE_ROUND_WARNING);

      click('שמירת השינויים');

      const notice = await screen.findByRole('status');
      expect(notice.textContent).toBe(t('he', 'orderPage.leftRound'));
      expect(t('he', 'orderPage.leftRound')).toBe(
        'הכתובת עודכנה. ההזמנה יצאה מהסבב, ונחזור אליך עם מועד חדש.',
      );
      expect(statusLabel()).toBe('מצב ההזמנה: ממתינה לסבב');
      expect(screen.getByText(t('he', 'orderPage.waiting'))).toBeDefined();
      expect(screen.queryByRole('button', { name: 'לא מתאים הפעם' })).toBeNull();
      expect(screen.getByText('דרך רבין יצחק 14')).toBeDefined();
      expect(calls.updates[0]?.request.address?.houseNumber).toBe('14');
    });

    it('takes the warning back when the house number is the stored one again', async () => {
      await openChange(confirmedOrder());

      fillIn('מספר בית', '14');
      expect(queryLeaveRoundWarning()).not.toBeNull();
      fillIn('מספר בית', ' 12 ');

      expect(queryLeaveRoundWarning()).toBeNull();
      expect(button('שמירת השינויים').getAttribute('aria-describedby')).toBeNull();
    });

    it('warns about a new street of a legacy pending order too', async () => {
      await openChange(pendingOrder());

      click('הרחוב שלי לא ברשימה');
      fillIn('שם הרחוב', 'הרימון');

      expect(getByWholeText(LEAVE_ROUND_WARNING)).toBeDefined();
    });

    it('never warns on a waiting order, which is in no round', async () => {
      await openChange();

      fillIn('מספר בית', '14');

      expect(queryLeaveRoundWarning()).toBeNull();
    });

    it('shows no warning when only the note, the spot or the bottles of an order in a round change', async () => {
      const calls = await openChange(confirmedOrder());

      fillIn('הערה (לא חובה)', 'קוד 1234');
      fireEvent.click(input('למטה בכניסה לבניין'));
      fillIn('כמות בקבוקים', '60');

      expect(queryLeaveRoundWarning()).toBeNull();

      click('שמירת השינויים');

      expect((await screen.findByRole('status')).textContent).toBe('השינויים נשמרו.');
      expect(statusLabel()).toBe('מצב ההזמנה: בסבב');
      expect(button('לא מתאים הפעם')).toBeDefined();
      expect(calls.updates[0]?.request.bottlesEstimated).toBe(60);
    });

    it('shows a field the api refused next to that field, keeping the form', async () => {
      const message = 'מספר הבית צריך להתחיל בספרה, למשל 12 או 12א';
      await openChange(makeOrder(), {
        update: { kind: 'invalid', errors: { byField: { houseNumber: message } } },
      });

      click('שמירת השינויים');

      await screen.findByText(message);
      const houseNumber = input('מספר בית');
      expect(houseNumber.getAttribute('aria-invalid')).toBe('true');
      expect(descriptionOf(houseNumber)).toContain(message);
      expect(document.activeElement).toBe(houseNumber);
      expect(button('שמירת השינויים')).toBeDefined();
    });

    it('shows a change refused as a whole above the save button', async () => {
      await openChange(makeOrder(), {
        update: { kind: 'invalid', errors: { byField: {}, other: UNKNOWN_FIELD_ERROR } },
      });

      click('שמירת השינויים');

      expect((await screen.findByRole('alert')).textContent).toBe(UNKNOWN_FIELD_ERROR);
      expect(button('שמירת השינויים')).toBeDefined();
    });

    it('keeps the form as typed, with the save-failed message, when the save fails', async () => {
      await openChange(makeOrder(), { update: { kind: 'failed' } });

      fillIn('הערה (לא חובה)', 'קוד 1234');
      click('שמירת השינויים');

      expect((await screen.findByRole('alert')).textContent).toBe(SAVE_FAILED_MESSAGE);
      expect(SAVE_FAILED_MESSAGE).toBe('לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.');
      expect(input('הערה (לא חובה)').value).toBe('קוד 1234');
      expect(button('שמירת השינויים').getAttribute('aria-disabled')).toBeNull();
    });

    it('treats a rejected save like a failed one', async () => {
      renderWithApi(<OrderPage token={TOKEN} />, {
        fetchCustomerOrder: () => Promise.resolve({ kind: 'loaded', order: makeOrder() }),
        updateCustomerOrder: () => Promise.reject(new Error('boom')),
      });
      fireEvent.click(await screen.findByRole('button', { name: 'שינוי' }));

      click('שמירת השינויים');

      expect((await screen.findByRole('alert')).textContent).toBe(SAVE_FAILED_MESSAGE);
      expect(button('שמירת השינויים')).toBeDefined();
    });

    it('closes on "בלי לשנות" without a request, with focus back on "שינוי"', async () => {
      const calls = await openChange();
      fillIn('הערה (לא חובה)', 'קוד 1234');

      click('בלי לשנות');

      expect(screen.queryByRole('button', { name: 'שמירת השינויים' })).toBeNull();
      expect(document.activeElement).toBe(button('שינוי'));
      const details = within(screen.getByRole('region', { name: 'פרטי ההזמנה' }));
      expect(details.getByText('ליד העגלה הכחולה')).toBeDefined();
      expect(calls.updates).toEqual([]);

      // Opened again, the form starts from the order, not from what was typed before.
      click('שינוי');
      expect(input('הערה (לא חובה)').value).toBe('ליד העגלה הכחולה');
    });

    it('says the order closed, and loads it again, when it was collected meanwhile', async () => {
      const calls = await openChange(makeOrder(), {
        load: [
          { kind: 'loaded', order: makeOrder() },
          { kind: 'loaded', order: makeOrder({ status: 'collected' }) },
        ],
        update: { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed },
      });

      click('שמירת השינויים');

      expect(await screen.findByText(t('he', 'orderPage.collected'))).toBeDefined();
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe(CUSTOMER_ORDER_MESSAGES.orderClosed);
      expect(document.activeElement).toBe(alert);
      expect(calls.loads).toEqual([TOKEN, TOKEN]);
      expect(screen.queryByRole('button', { name: 'שמירת השינויים' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'שינוי' })).toBeNull();
    });

    it('says the order was not found when the save answers so', async () => {
      await openChange(makeOrder(), { update: { kind: 'notFound' } });

      click('שמירת השינויים');

      expect((await screen.findByRole('alert')).textContent).toBe(
        CUSTOMER_ORDER_MESSAGES.orderNotFound,
      );
      expect(screen.queryByRole('button', { name: 'שמירת השינויים' })).toBeNull();
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
