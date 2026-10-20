import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CREATE_ORDER_MESSAGES,
  ORDER_FORM_ERRORS,
  STREETS,
  searchStreets,
  type AddOrderRequest,
  type CollectorOrder,
  type Street,
} from '@bottlerun/shared';
import type { CollectorOrderWriteOutcome } from '../api.ts';
import { MAX_STREET_RESULTS } from '../streetPicker/StreetPicker.tsx';
import { AddOrderScreen } from './AddOrderScreen.tsx';

/**
 * A street of the shared list in רמת בית שמש that the picker shows when its whole name is typed,
 * as the only street of that name: a real code and official name, not a hard-coded one.
 */
function pickableStreet(): Street {
  const street = STREETS.find(
    (candidate) =>
      candidate.region === 'ramat' &&
      STREETS.filter((other) => other.name === candidate.name).length === 1 &&
      searchStreets(candidate.name)
        .slice(0, MAX_STREET_RESULTS)
        .some((match) => match.code === candidate.code),
  );
  if (street === undefined) throw new Error('no pickable street');
  return street;
}

const STREET = pickableStreet();

/** The order the api answers with after a successful add. */
const SAVED_ORDER: CollectorOrder = {
  id: 'o9',
  contact: { name: 'רחל כהן', phone: '+972501234567' },
  address: {
    streetCode: STREET.code,
    streetName: STREET.name,
    houseNumber: '12',
    bottlesSpot: 'privateHouse',
  },
  bottlesEstimated: 45,
  status: 'waiting',
  region: 'ramat',
  source: 'collector',
  createdAt: new Date('2026-10-20T08:00:00Z'),
  hasLocation: true,
};

const SAVED: CollectorOrderWriteOutcome = { kind: 'saved', order: SAVED_ORDER };

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Opens the add screen at /app/orders/new with a fake `addOrder` that records every request and
 * answers `outcome`.
 */
function renderScreen(
  outcome: CollectorOrderWriteOutcome | Promise<CollectorOrderWriteOutcome> = SAVED,
): { requests: AddOrderRequest[]; unmount: () => void } {
  window.history.replaceState(null, '', '/app/orders/new');
  const requests: AddOrderRequest[] = [];
  const addOrder = (request: AddOrderRequest): Promise<CollectorOrderWriteOutcome> => {
    requests.push(request);
    return Promise.resolve(outcome);
  };
  const { unmount } = render(<AddOrderScreen addOrder={addOrder} />);
  return { requests, unmount };
}

/** The input labelled `label`. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

/** Types `text` into the input labelled `label`. */
function typeInto(label: string, text: string): void {
  fireEvent.change(input(label), { target: { value: text } });
}

/** Fills the form with a valid order for a customer who phoned, the street picked from the list. */
function fillValidForm(): void {
  typeInto('שם', 'רחל כהן');
  typeInto('טלפון נייד', '050-1234567');
  typeInto('רחוב', STREET.name);
  fireEvent.click(screen.getByRole('button', { name: STREET.name }));
  typeInto('מספר בית', '12');
  fireEvent.click(input('בכניסה לבית פרטי'));
  typeInto('כמות בקבוקים', '45');
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'שמירת ההזמנה' }));
}

/** The text of everything `element` is described by (aria-describedby): its hint and error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('AddOrderScreen', () => {
  it('shows one heading, the way back to the orders, and a blank form', () => {
    renderScreen();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'הוספת הזמנה' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'חזרה להזמנות' }).getAttribute('href')).toBe(
      '/app/orders',
    );
    expect(input('שם').value).toBe('');
    expect(input('רחוב').value).toBe('');
    expect(input('כמות בקבוקים').value).toBe('');
    // The public form's own parts are not here: no spam trap, no privacy line.
    expect(screen.queryByLabelText('אתר אינטרנט')).toBeNull();
    expect(screen.queryByText('הפרטים משמשים רק לתיאום האיסוף')).toBeNull();
  });

  it('adds a valid order, without a honeypot, and returns to the orders', async () => {
    const { requests } = renderScreen();
    const historyLength = window.history.length;

    fillValidForm();
    save();

    await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
    // Replaced, not pushed: "back" from the list does not reopen the form just sent.
    expect(window.history.length).toBe(historyLength);
    expect(requests).toEqual([
      {
        contact: { name: 'רחל כהן', phone: '+972501234567' },
        address: {
          streetCode: STREET.code,
          streetName: STREET.name,
          houseNumber: '12',
          bottlesSpot: 'privateHouse',
        },
        bottlesEstimated: 45,
      },
    ]);
    expect(requests[0] !== undefined && 'website' in requests[0]).toBe(false);
  });

  it('shows each mistake next to its field, focuses the first, and sends nothing', () => {
    const { requests } = renderScreen();

    fillValidForm();
    typeInto('טלפון נייד', '123');
    typeInto('כמות בקבוקים', '29');
    save();

    expect(requests).toEqual([]);
    const phone = input('טלפון נייד');
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(phone);
    const bottles = input('כמות בקבוקים');
    expect(bottles.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(bottles)).toContain(ORDER_FORM_ERRORS.bottlesTooFew);
    expect(window.location.pathname).toBe('/app/orders/new');
  });

  it('asks for the street when none was picked', () => {
    const { requests } = renderScreen();

    fillValidForm();
    typeInto('רחוב', 'משהו אחר');
    save();

    expect(requests).toEqual([]);
    expect(input('רחוב').getAttribute('aria-invalid')).toBe('true');
  });

  it("shows the api's field error next to its field", async () => {
    renderScreen({
      kind: 'invalid',
      errors: { byField: { houseNumber: 'מספר הבית ארוך מדי' } },
    });

    fillValidForm();
    save();

    await waitFor(() => expect(input('מספר בית').getAttribute('aria-invalid')).toBe('true'));
    expect(descriptionOf(input('מספר בית'))).toContain('מספר הבית ארוך מדי');
  });

  it('shows the duplicate message next to the phone and keeps the form', async () => {
    renderScreen({ kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder });

    fillValidForm();
    save();

    const phone = input('טלפון נייד');
    await waitFor(() => expect(phone.getAttribute('aria-invalid')).toBe('true'));
    expect(descriptionOf(phone)).toContain(CREATE_ORDER_MESSAGES.duplicateOpenOrder);
    expect(document.activeElement).toBe(phone);
    expect(input('שם').value).toBe('רחל כהן');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.pathname).toBe('/app/orders/new');
  });

  it('asks to check the connection when the save fails, and keeps the form', async () => {
    renderScreen({ kind: 'failed' });

    fillValidForm();
    save();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
    );
    expect(input('שם').value).toBe('רחל כהן');
    expect(screen.getByRole('button', { name: 'שמירת ההזמנה' })).toBeDefined();
    expect(window.location.pathname).toBe('/app/orders/new');
  });

  it('treats a rejected save like a failed one', async () => {
    window.history.replaceState(null, '', '/app/orders/new');
    render(<AddOrderScreen addOrder={() => Promise.reject(new Error('boom'))} />);

    fillValidForm();
    save();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
    );
  });

  it('goes to the login when the session ended', async () => {
    const historyLength = window.history.length;
    renderScreen({ kind: 'loggedOut' });

    fillValidForm();
    save();

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(window.history.length).toBe(historyLength);
  });

  it('says "saving" while the request runs and sends one request for two taps', async () => {
    const answer = deferred<CollectorOrderWriteOutcome>();
    const { requests } = renderScreen(answer.promise);

    fillValidForm();
    save();

    const busy = screen.getByRole('button', { name: 'שומר...' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    expect(requests).toHaveLength(1);

    answer.resolve(SAVED);

    await waitFor(() => expect(window.location.pathname).toBe('/app/orders'));
    expect(requests).toHaveLength(1);
  });

  it('stays where Yoel went when the answer comes after he left the screen', async () => {
    const answer = deferred<CollectorOrderWriteOutcome>();
    const { unmount } = renderScreen(answer.promise);
    fillValidForm();
    save();
    unmount();
    window.history.replaceState(null, '', '/app/rounds');

    answer.resolve({ kind: 'loggedOut' });
    await new Promise((settle) => setTimeout(settle, 0));

    expect(window.location.pathname).toBe('/app/rounds');
  });
});
