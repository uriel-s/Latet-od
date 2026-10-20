import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  ORDER_FORM_ERRORS,
  STREETS,
  searchStreets,
  type CollectorOrder,
  type Region,
  type Street,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import type { CollectorOrderOutcome, CollectorOrderWriteOutcome } from '../api.ts';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { MAX_STREET_RESULTS } from '../streetPicker/StreetPicker.tsx';
import {
  EditOrderScreen,
  NEAR_STREET_HINT,
  ORDER_LOAD_FAILED_MESSAGE,
  REGION_HINT,
} from './EditOrderScreen.tsx';
import { CANCEL_FAILED_MESSAGE, SAVE_FAILED_MESSAGE } from './orderEditing.ts';

/** The first word of a street's name: what Yoel types to find it. */
function firstWord(street: Street): string {
  return street.name.split(' ')[0] ?? street.name;
}

/**
 * A street of the shared list in `region` that the picker shows when the first word of its name
 * is typed, as the only street of that name: a real code and official name, not a hard-coded one.
 */
function pickableStreet(region: Region): Street {
  const street = STREETS.find(
    (candidate) =>
      candidate.region === region &&
      STREETS.filter((other) => other.name === candidate.name).length === 1 &&
      searchStreets(firstWord(candidate))
        .slice(0, MAX_STREET_RESULTS)
        .some((match) => match.code === candidate.code),
  );
  if (street === undefined) throw new Error(`no pickable street in ${region}`);
  return street;
}

const RAMAT_STREET = pickableStreet('ramat');
const OLD_STREET = pickableStreet('old');

/** A waiting order on a listed street in רמת בית שמש; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: RAMAT_STREET.code,
      streetName: RAMAT_STREET.name,
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
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

/** An order whose street the customer wrote by hand: no region, no map point ("בלי מיקום"). */
function makeFreeTextOrder(nearStreetCode?: number): CollectorOrder {
  return makeOrder({
    contact: { name: 'רחל אברהם', phone: '+972541112233' },
    address: {
      streetName: 'סמטת הגפנים',
      houseNumber: '7',
      bottlesSpot: 'privateHouse',
      ...(nearStreetCode === undefined ? {} : { nearStreetCode }),
    },
    region: nearStreetCode === undefined ? undefined : 'old',
    hasLocation: nearStreetCode !== undefined,
  });
}

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
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
  load?: Answer<CollectorOrderOutcome>[];
  /** The answer of updateOrder. Default: saved. */
  update?: Answer<CollectorOrderWriteOutcome>;
  /** The answer of cancelOrder. Default: saved. */
  cancel?: Answer<CollectorOrderWriteOutcome>;
  strict?: boolean;
}

/** What the fakes recorded. */
interface Calls {
  loads: string[];
  updates: [id: string, request: UpdateOrderRequest][];
  cancels: string[];
  unmount: () => void;
}

/** Opens the edit screen of `order` at /app/orders/<id>, with fakes that record every call. */
function renderScreen(
  order: CollectorOrder = makeOrder(),
  { load, update, cancel, strict = false }: RenderOptions = {},
): Calls {
  window.history.replaceState(null, '', `/app/orders/${order.id}`);
  const calls: Omit<Calls, 'unmount'> = { loads: [], updates: [], cancels: [] };
  const nextLoad = answersInTurn(load ?? [{ kind: 'loaded', order }]);
  const saved: CollectorOrderWriteOutcome = { kind: 'saved', order };
  const element = (
    <EditOrderScreen
      id={order.id}
      loadOrder={(id) => {
        calls.loads.push(id);
        return nextLoad();
      }}
      updateOrder={(id, request) => {
        calls.updates.push([id, request]);
        return Promise.resolve(update ?? saved);
      }}
      cancelOrder={(id) => {
        calls.cancels.push(id);
        return Promise.resolve(cancel ?? saved);
      }}
    />
  );
  const { unmount } = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return { ...calls, unmount };
}

/** Renders the edit screen of `order` and waits for its form. */
async function renderLoaded(
  order: CollectorOrder = makeOrder(),
  options: RenderOptions = {},
): Promise<Calls> {
  const calls = renderScreen(order, options);
  await screen.findByRole('button', { name: 'שמירת השינויים' });
  return calls;
}

/** The input labelled `label`. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

/** Types `text` into the input labelled `label`. */
function typeInto(label: string, text: string): void {
  fireEvent.change(input(label), { target: { value: text } });
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'שמירת השינויים' }));
}

/** The one PATCH body sent. */
function onlyRequest(calls: Calls): UpdateOrderRequest {
  expect(calls.updates).toHaveLength(1);
  const [id, request] = calls.updates[0] ?? ['', {}];
  expect(id).toBe('o1');
  return request;
}

/** The text of everything `element` is described by (aria-describedby): its hint and error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** The page has exactly one h1, and it is the screen's name. */
function expectOneH1(): void {
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: 'עריכת הזמנה' })).toBeDefined();
}

/** The radio of a region, by its Hebrew name. */
function regionRadio(name: string): HTMLInputElement {
  return within(screen.getByRole('group', { name: 'אזור' })).getByRole<HTMLInputElement>('radio', {
    name,
  });
}

describe('EditOrderScreen', () => {
  describe('while the order loads', () => {
    it('shows the heading, the way back and a loading status, without a form', () => {
      renderScreen(makeOrder(), { load: [deferred<CollectorOrderOutcome>().promise] });

      expectOneH1();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.getByRole('link', { name: 'חזרה להזמנות' }).getAttribute('href')).toBe(
        '/app/orders',
      );
      expect(screen.queryByLabelText('שם')).toBeNull();
    });

    it('loads the order of its id', async () => {
      const calls = await renderLoaded();

      expect(calls.loads).toEqual(['o1']);
    });
  });

  describe('loaded', () => {
    it('fills the form from the order, the phone left to right', async () => {
      await renderLoaded();

      expectOneH1();
      expect(screen.queryByRole('status')).toBeNull();
      expect(input('שם').value).toBe('דנה כהן');
      const phone = input('טלפון נייד');
      expect(phone.value).toBe('050-1234567');
      expect(phone.getAttribute('dir')).toBe('ltr');
      expect(input('רחוב').value).toBe(RAMAT_STREET.name);
      expect(input('מספר בית').value).toBe('12');
      expect(input('ליד דלת הדירה').checked).toBe(true);
      expect(input('קומה ודירה').value).toBe('קומה 3, דירה 12');
      expect(input('כמות בקבוקים').value).toBe('40');
    });

    it('shows a street written by hand as free text', async () => {
      await renderLoaded(makeFreeTextOrder());

      expect(input('שם הרחוב').value).toBe('סמטת הגפנים');
      expect(input('בכניסה לבית פרטי').checked).toBe(true);
    });

    it('offers "רחוב קרוב" from the list only, explained in plain words', async () => {
      await renderLoaded();

      const nearStreet = input('רחוב קרוב');
      expect(nearStreet.value).toBe('');
      expect(descriptionOf(nearStreet)).toBe(NEAR_STREET_HINT);

      typeInto('רחוב קרוב', 'אין רחוב כזה בכלל');

      // The one "not in the list" button is the street field's own; the near street offers none.
      expect(screen.getAllByRole('button', { name: 'הרחוב שלי לא ברשימה' })).toHaveLength(1);
      expect(screen.getByText(/לא מצאנו רחוב בשם הזה\./).textContent).not.toContain(
        'הרחוב שלי לא ברשימה',
      );
    });

    it("shows the order's near street by its official name", async () => {
      await renderLoaded(makeFreeTextOrder(OLD_STREET.code));

      expect(input('רחוב קרוב').value).toBe(OLD_STREET.name);
    });

    it("checks the order's region, with the hint", async () => {
      await renderLoaded();

      expect(regionRadio('רמת בית שמש').checked).toBe(true);
      expect(regionRadio('בית שמש').checked).toBe(false);
      expect(descriptionOf(screen.getByRole('group', { name: 'אזור' }))).toBe(REGION_HINT);
    });

    it('checks no region for an order without one', async () => {
      await renderLoaded(makeFreeTextOrder());

      expect(regionRadio('רמת בית שמש').checked).toBe(false);
      expect(regionRadio('בית שמש').checked).toBe(false);
    });
  });

  describe('assigning a free-text order', () => {
    it('sends the near street picked, without a region, and returns to the orders', async () => {
      const calls = await renderLoaded(makeFreeTextOrder());
      const historyLength = window.history.length;

      typeInto('רחוב קרוב', firstWord(OLD_STREET));
      fireEvent.click(screen.getByRole('button', { name: OLD_STREET.name }));
      expect(input('רחוב קרוב').value).toBe(OLD_STREET.name);
      save();

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      // Replaced, not pushed: "back" from the list does not reopen the form as it was.
      expect(window.history.length).toBe(historyLength);
      expect(window.history.state).toEqual({ notice: 'השינויים נשמרו.' });
      const request = onlyRequest(calls);
      expect(request).toEqual({
        contact: { name: 'רחל אברהם', phone: '+972541112233' },
        address: { streetName: 'סמטת הגפנים', houseNumber: '7', bottlesSpot: 'privateHouse' },
        bottlesEstimated: 40,
        nearStreetCode: OLD_STREET.code,
      });
      // The api derives the region from the near street; an explicit one would override it.
      expect('region' in request).toBe(false);
    });
  });

  describe('saving', () => {
    it('sends the region Yoel picked by hand', async () => {
      const calls = await renderLoaded();

      fireEvent.click(regionRadio('בית שמש'));
      expect(regionRadio('בית שמש').checked).toBe(true);
      save();

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      const request = onlyRequest(calls);
      expect(request.region).toBe('old');
      expect('nearStreetCode' in request).toBe(false);
    });

    it('sends the edited details, and no near street or region when they did not change', async () => {
      const calls = await renderLoaded(makeFreeTextOrder(OLD_STREET.code));

      typeInto('שם', 'רחל אברהם-לוי');
      typeInto('כמות בקבוקים', '60');
      save();

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      const request = onlyRequest(calls);
      expect(request.contact).toEqual({ name: 'רחל אברהם-לוי', phone: '+972541112233' });
      expect(request.bottlesEstimated).toBe(60);
      expect('nearStreetCode' in request).toBe(false);
      expect('region' in request).toBe(false);
    });

    it('sends null to remove a near street Yoel cleared', async () => {
      const calls = await renderLoaded(makeFreeTextOrder(OLD_STREET.code));

      typeInto('רחוב קרוב', '');
      save();

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      const request = onlyRequest(calls);
      expect('nearStreetCode' in request).toBe(true);
      expect(request.nearStreetCode).toBeNull();
    });

    it('shows "at least 30 bottles" next to the field for 29 and sends nothing', async () => {
      const calls = await renderLoaded();

      typeInto('כמות בקבוקים', '29');
      save();

      const bottles = input('כמות בקבוקים');
      expect(bottles.getAttribute('aria-invalid')).toBe('true');
      expect(descriptionOf(bottles)).toContain(ORDER_FORM_ERRORS.bottlesTooFew);
      expect(document.activeElement).toBe(bottles);
      expect(calls.updates).toEqual([]);
      expect(window.location.pathname).toBe('/app/orders/o1');
    });

    it('shows the duplicate message next to the phone', async () => {
      await renderLoaded(makeOrder(), {
        update: { kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder },
      });

      typeInto('טלפון נייד', '052-7654321');
      save();

      const phone = input('טלפון נייד');
      await waitFor(() => expect(phone.getAttribute('aria-invalid')).toBe('true'));
      expect(descriptionOf(phone)).toContain(CREATE_ORDER_MESSAGES.duplicateOpenOrder);
      expect(phone.value).toBe('052-7654321');
      expect(window.location.pathname).toBe('/app/orders/o1');
    });

    it('shows an api error no field shows above the button', async () => {
      await renderLoaded(makeOrder(), {
        update: { kind: 'invalid', errors: { byField: {}, other: UNKNOWN_FIELD_ERROR } },
      });

      save();

      expect((await screen.findByRole('alert')).textContent).toBe(UNKNOWN_FIELD_ERROR);
    });

    it.each([
      ['closed', COLLECTOR_ORDER_MESSAGES.orderClosed],
      ['notFound', COLLECTOR_ORDER_MESSAGES.orderNotFound],
    ] as const)('shows the message when the save answers %s', async (kind, message) => {
      await renderLoaded(makeOrder(), { update: { kind, message } });

      save();

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(window.location.pathname).toBe('/app/orders/o1');
    });

    it('asks to check the connection when the save fails, and keeps the changes', async () => {
      await renderLoaded(makeOrder(), { update: { kind: 'failed' } });

      typeInto('שם', 'דנה לוי');
      save();

      expect((await screen.findByRole('alert')).textContent).toBe(SAVE_FAILED_MESSAGE);
      expect(input('שם').value).toBe('דנה לוי');
      expect(screen.getByRole('button', { name: 'שמירת השינויים' })).toBeDefined();
    });

    it('goes to the login when the session ended', async () => {
      await renderLoaded(makeOrder(), { update: { kind: 'loggedOut' } });

      save();

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
    });

    it('says "saving" while the request runs and sends one request for two taps', async () => {
      const answer = deferred<CollectorOrderWriteOutcome>();
      const calls = await renderLoaded(makeOrder(), { update: answer.promise });

      save();

      const busy = screen.getByRole('button', { name: 'שומר...' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      expect(calls.updates).toHaveLength(1);

      answer.resolve({ kind: 'saved', order: makeOrder() });

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      expect(calls.updates).toHaveLength(1);
    });
  });

  describe('cancelling', () => {
    it('asks first, in plain words, with focus on the question', async () => {
      const calls = await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      const question = screen.getByText('לבטל את ההזמנה של דנה כהן?');
      expect(document.activeElement).toBe(question);
      expect(screen.getByRole('group', { name: 'לבטל את ההזמנה של דנה כהן?' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'כן, לבטל' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'לא, להשאיר' })).toBeDefined();
      expect(calls.cancels).toEqual([]);
    });

    it('cancels once on "כן, לבטל" and returns to the orders', async () => {
      const answer = deferred<CollectorOrderWriteOutcome>();
      const calls = await renderLoaded(makeOrder(), { cancel: answer.promise });
      const historyLength = window.history.length;
      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      fireEvent.click(screen.getByRole('button', { name: 'כן, לבטל' }));
      const busy = screen.getByRole('button', { name: 'מבטל...' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      expect(calls.cancels).toEqual(['o1']);

      answer.resolve({ kind: 'saved', order: makeOrder({ status: 'cancelled' }) });

      await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
      expect(window.history.length).toBe(historyLength);
      expect(window.history.state).toEqual({ notice: 'ההזמנה בוטלה.' });
      expect(calls.cancels).toEqual(['o1']);
      expect(calls.updates).toEqual([]);
    });

    it('closes the question on "לא, להשאיר" without cancelling, focus back on the button', async () => {
      const calls = await renderLoaded();
      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      fireEvent.click(screen.getByRole('button', { name: 'לא, להשאיר' }));

      expect(screen.queryByText('לבטל את ההזמנה של דנה כהן?')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ביטול ההזמנה' }));
      expect(calls.cancels).toEqual([]);
      expect(window.location.pathname).toBe('/app/orders/o1');
    });

    it.each([
      ['closed', COLLECTOR_ORDER_MESSAGES.orderClosed],
      ['notFound', COLLECTOR_ORDER_MESSAGES.orderNotFound],
    ] as const)('says why when the cancel answers %s', async (kind, message) => {
      await renderLoaded(makeOrder(), { cancel: { kind, message } });
      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      fireEvent.click(screen.getByRole('button', { name: 'כן, לבטל' }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByRole('button', { name: 'כן, לבטל' })).toBeDefined();
      expect(window.location.pathname).toBe('/app/orders/o1');
    });

    it('asks to check the connection when the cancel fails', async () => {
      await renderLoaded(makeOrder(), { cancel: { kind: 'failed' } });
      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      fireEvent.click(screen.getByRole('button', { name: 'כן, לבטל' }));

      expect((await screen.findByRole('alert')).textContent).toBe(CANCEL_FAILED_MESSAGE);
    });

    it('goes to the login when the session ended', async () => {
      await renderLoaded(makeOrder(), { cancel: { kind: 'loggedOut' } });
      fireEvent.click(screen.getByRole('button', { name: 'ביטול ההזמנה' }));

      fireEvent.click(screen.getByRole('button', { name: 'כן, לבטל' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
    });
  });

  describe('an order that is no longer open', () => {
    it.each(['collected', 'cancelled'] as const)(
      'says a %s order is closed, with no form and no cancel',
      async (status) => {
        renderScreen(makeOrder({ status }));

        expect((await screen.findByRole('alert')).textContent).toBe(
          COLLECTOR_ORDER_MESSAGES.orderClosed,
        );
        expectOneH1();
        expect(screen.queryByLabelText('שם')).toBeNull();
        expect(screen.queryByRole('button', { name: 'שמירת השינויים' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'ביטול ההזמנה' })).toBeNull();
        expect(screen.getByRole('link', { name: 'חזרה להזמנות' })).toBeDefined();
      },
    );

    it.each(['pending', 'confirmed'] as const)('can still edit a %s order', async (status) => {
      await renderLoaded(makeOrder({ status }));

      expect(input('שם').value).toBe('דנה כהן');
    });
  });

  describe('when the order is not found', () => {
    it('says so, with the way back and no form', async () => {
      renderScreen(makeOrder(), { load: [{ kind: 'notFound' }] });

      expect((await screen.findByRole('alert')).textContent).toBe(
        COLLECTOR_ORDER_MESSAGES.orderNotFound,
      );
      expectOneH1();
      expect(screen.queryByLabelText('שם')).toBeNull();
      expect(screen.getByRole('link', { name: 'חזרה להזמנות' })).toBeDefined();
    });
  });

  describe('logged out', () => {
    it('goes to the login in place of the screen', async () => {
      const historyLength = window.history.length;
      renderScreen(makeOrder(), { load: [{ kind: 'loggedOut' }] });

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.length).toBe(historyLength);
    });

    it('stays where Yoel went when the answer comes after he left the screen', async () => {
      const answer = deferred<CollectorOrderOutcome>();
      const { unmount } = renderScreen(makeOrder(), { load: [answer.promise] });
      unmount();
      window.history.replaceState(null, '', '/app/rounds');

      answer.resolve({ kind: 'loggedOut' });
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('ignores a save answer that comes after he left the screen', async () => {
      const answer = deferred<CollectorOrderWriteOutcome>();
      const { unmount } = await renderLoaded(makeOrder(), { update: answer.promise });
      save();
      unmount();
      window.history.replaceState(null, '', '/app/rounds');

      answer.resolve({ kind: 'loggedOut' });
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/app/rounds');
    });
  });

  describe('when the load fails', () => {
    it('says so in plain words with a retry, and loads again on "לנסות שוב"', async () => {
      const second = deferred<CollectorOrderOutcome>();
      const calls = renderScreen(makeOrder(), { load: [{ kind: 'failed' }, second.promise] });

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LOAD_FAILED_MESSAGE);
      expect(ORDER_LOAD_FAILED_MESSAGE).toBe(
        'לא הצלחנו לטעון את ההזמנה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
      );
      expectOneH1();
      expect(screen.queryByLabelText('שם')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(calls.loads).toEqual(['o1', 'o1']);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();

      second.resolve({ kind: 'loaded', order: makeOrder() });

      expect(await screen.findByRole('button', { name: 'שמירת השינויים' })).toBeDefined();
      expect(input('שם').value).toBe('דנה כהן');
      expect(screen.queryByRole('button', { name: 'לנסות שוב' })).toBeNull();
      expectOneH1();
    });

    it('treats a rejected load like a failed one', async () => {
      window.history.replaceState(null, '', '/app/orders/o1');
      render(<EditOrderScreen id="o1" loadOrder={() => Promise.reject(new Error('boom'))} />);

      expect((await screen.findByRole('alert')).textContent).toBe(ORDER_LOAD_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/orders/o1');
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the load', async () => {
      // StrictMode mounts, unmounts and mounts again: two loads, and only the second counts.
      const calls = renderScreen(makeOrder(), {
        load: [{ kind: 'loggedOut' }, { kind: 'loaded', order: makeOrder() }],
        strict: true,
      });

      expect(await screen.findByRole('button', { name: 'שמירת השינויים' })).toBeDefined();
      expect(calls.loads).toHaveLength(2);
      expect(window.location.pathname).toBe('/app/orders/o1');
    });
  });
});
