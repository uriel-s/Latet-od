import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CREATE_ORDER_MESSAGES,
  PHONE_ERROR,
  type CreateOrderRequest,
  type CreateOrderResponse,
} from '@bottlerun/shared';
import { NETWORK_ERROR_MESSAGE, type CreateOrderOutcome } from '../api.ts';
import { UNKNOWN_FIELD_ERROR, mapFieldErrors } from './formValues.ts';
import { OrderFormPage } from './OrderFormPage.tsx';
import {
  SAVED_DETAILS_KEY,
  loadSavedDetails,
  orderFormNavigationState,
  saveDetails,
  type OrderPrefill,
} from './savedDetails.ts';

/** A token as the api makes them: 43 base64url characters. */
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

/** The 201 answer for the order {@link fillValidForm} fills in. */
function createdResponse(): CreateOrderResponse {
  return {
    token: TOKEN,
    order: {
      contact: { name: 'רחל כהן', phone: '+972501234567' },
      address: {
        streetCode: 247,
        streetName: 'דרך רבין יצחק',
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
      },
      bottlesEstimated: 45,
    },
  };
}

const CREATED: CreateOrderOutcome = { kind: 'created', response: createdResponse() };

/** A returning customer's saved details, with `overrides` on the contact. */
function makePrefill(contact: Partial<OrderPrefill['contact']> = {}): OrderPrefill {
  return {
    contact: { name: 'משה לוי', phone: '+972527654321', ...contact },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '7ב',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
    },
  };
}

/** A promise the test settles by hand, to look at the form while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Renders the form with a fake `submitOrder` that records every request and answers `outcome`.
 * Returns the requests, in order.
 */
function renderForm(outcome: CreateOrderOutcome | Promise<CreateOrderOutcome> = CREATED): {
  requests: CreateOrderRequest[];
  container: HTMLElement;
  unmount: () => void;
} {
  const requests: CreateOrderRequest[] = [];
  const submitOrder = (request: CreateOrderRequest): Promise<CreateOrderOutcome> => {
    requests.push(request);
    return Promise.resolve(outcome);
  };
  const { container, unmount } = render(<OrderFormPage submitOrder={submitOrder} />);
  return { requests, container, unmount };
}

/** The input labelled `label`. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

/** Types `text` into the input labelled `label`, as a customer would. */
function typeInto(label: string, text: string): void {
  fireEvent.change(input(label), { target: { value: text } });
}

/** Fills every required field with valid values, except the street. */
function fillValidFormExceptStreet(): void {
  typeInto('שם', 'רחל כהן');
  typeInto('טלפון נייד', '050-1234567');
  typeInto('מספר בית', '12');
  fireEvent.click(input('בכניסה לבית פרטי'));
  typeInto('כמות בקבוקים', '45');
}

/** Fills the form with a valid order: Rabin street (code 247) picked from the list. */
function fillValidForm(): void {
  fillValidFormExceptStreet();
  typeInto('רחוב', 'רבין');
  fireEvent.click(screen.getByRole('button', { name: 'דרך רבין יצחק' }));
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'שליחת הזמנה' }));
}

/** The text of everything `element` is described by (aria-describedby): its hint and error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('OrderFormPage', () => {
  it('sends a valid order and shows the thank-you screen with a link to the order page', async () => {
    const { requests } = renderForm();

    fillValidForm();
    submit();

    const link = await screen.findByRole('link', { name: 'לצפייה בהזמנה או לביטול' });
    expect(link.getAttribute('href')).toBe(`/o/${TOKEN}`);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'תודה!' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'שליחת הזמנה' })).toBeNull();
    expect(requests).toEqual([
      {
        contact: { name: 'רחל כהן', phone: '+972501234567' },
        address: {
          streetCode: 247,
          streetName: 'דרך רבין יצחק',
          houseNumber: '12',
          bottlesSpot: 'privateHouse',
        },
        bottlesEstimated: 45,
        website: '',
      },
    ]);
  });

  it('shows "at least 20 bottles" next to the field for 19 and sends nothing', () => {
    const { requests } = renderForm();
    fillValidForm();
    typeInto('כמות בקבוקים', '19');

    submit();

    const bottles = input('כמות בקבוקים');
    expect(descriptionOf(bottles)).toContain('צריך לפחות 20 בקבוקים');
    expect(bottles.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(bottles);
    expect(requests).toEqual([]);
  });

  // Class and aria only: jsdom loads no CSS, so the colour itself is checked on a real phone.
  it('greys the send button, with the reason, until the bottles reach 20', () => {
    renderForm();
    fillValidForm();
    typeInto('כמות בקבוקים', '19');

    const button = screen.getByRole('button', { name: 'שליחת הזמנה' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.className).toContain('button-not-ready');
    expect(descriptionOf(button)).toBe('כדי לשלוח צריך לפחות 20 בקבוקים');

    typeInto('כמות בקבוקים', '20');
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.className).not.toContain('button-not-ready');
    expect(button.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('כדי לשלוח צריך לפחות 20 בקבוקים')).toBeNull();
  });

  it('greys the send button while the bottles field is empty', () => {
    renderForm();

    const button = screen.getByRole('button', { name: 'שליחת הזמנה' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.className).toContain('button-not-ready');
    expect(descriptionOf(button)).toBe('כדי לשלוח צריך לפחות 20 בקבוקים');
  });

  it('keeps "שולח..." plain, without the reason, if the bottles drop below 20 while sending', async () => {
    const answer = deferred<CreateOrderOutcome>();
    renderForm(answer.promise);
    fillValidForm();
    submit();

    typeInto('כמות בקבוקים', '20');

    const sending = screen.getByRole('button', { name: 'שולח...' });
    expect(sending.className).not.toContain('button-not-ready');
    expect(sending.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('כדי לשלוח צריך לפחות 20 בקבוקים')).toBeNull();

    answer.resolve(CREATED);
    await screen.findByRole('heading', { level: 1, name: 'תודה!' });
  });

  it('shows every mistake of an empty form next to its field and focuses the first', () => {
    const { requests } = renderForm();

    submit();

    expect(descriptionOf(input('שם'))).toBe('נא לכתוב שם');
    expect(descriptionOf(input('טלפון נייד'))).toContain(PHONE_ERROR);
    expect(descriptionOf(input('רחוב'))).toBe('נא לבחור רחוב או לכתוב אותו');
    expect(descriptionOf(input('מספר בית'))).toBe('נא לכתוב מספר בית');
    const spots = screen.getByRole('group', { name: 'איפה הבקבוקים' });
    expect(descriptionOf(spots)).toBe('נא לבחור איפה הבקבוקים');
    expect(input('בכניסה לבית פרטי').getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(input('כמות בקבוקים'))).toContain('נא לכתוב מספר בקבוקים');
    expect(document.activeElement).toBe(input('שם'));
    expect(requests).toEqual([]);
  });

  it('clears only the error of the field being edited', () => {
    renderForm();
    submit();

    typeInto('שם', 'ר');

    expect(input('שם').getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('נא לכתוב שם')).toBeNull();
    expect(descriptionOf(input('מספר בית'))).toBe('נא לכתוב מספר בית');
  });

  it('shows the official street for a word of its name', () => {
    renderForm();

    typeInto('רחוב', 'רבין');

    expect(screen.getByRole('button', { name: 'דרך רבין יצחק' })).toBeDefined();
  });

  it('sends a street written by hand as a name without a street code', async () => {
    const { requests } = renderForm();
    fillValidFormExceptStreet();

    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));
    typeInto('שם הרחוב', 'הרימון');
    submit();

    await screen.findByRole('heading', { level: 1, name: 'תודה!' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.address).toEqual({
      streetName: 'הרימון',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
    });
    expect(requests[0]?.address).not.toHaveProperty('streetCode');
  });

  it('asks for the floor and apartment only when the bottles wait at the apartment door', () => {
    renderForm();
    expect(screen.queryByLabelText('קומה ודירה')).toBeNull();

    fireEvent.click(input('בבניין - ליד דלת הדירה'));
    expect(input('קומה ודירה')).toBeDefined();
    expect(descriptionOf(input('קומה ודירה'))).toBe("למשל: כניסה ב', קומה 3, דירה 12");

    fireEvent.click(input('למטה בכניסה לבניין'));
    expect(screen.queryByLabelText('קומה ודירה')).toBeNull();
  });

  it('requires the floor and apartment for the apartment door and sends nothing without it', () => {
    const { requests } = renderForm();
    fillValidForm();
    fireEvent.click(input('בבניין - ליד דלת הדירה'));

    submit();

    const floorApt = input('קומה ודירה');
    expect(descriptionOf(floorApt)).toContain('נא לכתוב קומה ודירה');
    expect(document.activeElement).toBe(floorApt);
    expect(requests).toEqual([]);
  });

  it('fills in the details saved in this browser, but not the number of bottles', () => {
    saveDetails(makePrefill());

    renderForm();

    expect(input('שם').value).toBe('משה לוי');
    expect(input('טלפון נייד').value).toBe('052-7654321');
    expect(input('רחוב').value).toBe('דרך רבין יצחק');
    expect(input('מספר בית').value).toBe('7ב');
    expect(input('בבניין - ליד דלת הדירה').checked).toBe(true);
    expect(input('קומה ודירה').value).toBe('קומה 3, דירה 12');
    expect(input('כמות בקבוקים').value).toBe('');
  });

  it('saves the details after a successful order, so the next visit is filled in', async () => {
    const { unmount } = renderForm();
    fillValidForm();
    submit();
    await screen.findByRole('heading', { level: 1, name: 'תודה!' });

    unmount();
    renderForm();

    expect(localStorage.getItem(SAVED_DETAILS_KEY)).not.toBeNull();
    expect(input('שם').value).toBe('רחל כהן');
    expect(input('טלפון נייד').value).toBe('050-1234567');
    expect(input('רחוב').value).toBe('דרך רבין יצחק');
    expect(input('מספר בית').value).toBe('12');
    expect(input('בכניסה לבית פרטי').checked).toBe(true);
    expect(input('כמות בקבוקים').value).toBe('');
  });

  it('fills in the details passed in the navigation state, ahead of the saved ones', () => {
    saveDetails(makePrefill({ name: 'שמור בדפדפן' }));
    window.history.replaceState(
      orderFormNavigationState(makePrefill({ name: 'מעמוד ההזמנה' })),
      '',
      '/',
    );

    renderForm();

    expect(input('שם').value).toBe('מעמוד ההזמנה');
    expect(input('רחוב').value).toBe('דרך רבין יצחק');
    expect(input('כמות בקבוקים').value).toBe('');
  });

  it('drops the navigation state after an order, so a reload fills in the saved details', async () => {
    window.history.replaceState(orderFormNavigationState(makePrefill()), '', '/');
    renderForm();
    typeInto('כמות בקבוקים', '45');

    submit();

    await screen.findByRole('heading', { level: 1, name: 'תודה!' });
    expect(window.history.state).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(loadSavedDetails()?.contact.name).toBe('רחל כהן');
  });

  it('shows "already has an open order" next to the phone field and focuses it', async () => {
    renderForm({ kind: 'duplicate', message: CREATE_ORDER_MESSAGES.duplicateOpenOrder });
    fillValidForm();

    submit();

    const phone = input('טלפון נייד');
    await waitFor(() => expect(descriptionOf(phone)).toContain('כבר יש הזמנה פתוחה למספר הזה.'));
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(phone);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input('שם').value).toBe('רחל כהן');
  });

  it('says "sending" while the request runs and ignores a second tap', async () => {
    const answer = deferred<CreateOrderOutcome>();
    const { requests } = renderForm(answer.promise);
    fillValidForm();

    submit();
    const sending = screen.getByRole('button', { name: 'שולח...' });
    expect(sending.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sending);
    fireEvent.click(sending);
    expect(requests).toHaveLength(1);

    answer.resolve(CREATED);
    await screen.findByRole('heading', { level: 1, name: 'תודה!' });
    expect(requests).toHaveLength(1);
  });

  it('shows the network error above the button, keeps the values, and can send again', async () => {
    const { requests } = renderForm({ kind: 'failed' });
    fillValidForm();

    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(NETWORK_ERROR_MESSAGE);
    expect(input('שם').value).toBe('רחל כהן');
    expect(input('טלפון נייד').value).toBe('050-1234567');
    expect(input('רחוב').value).toBe('דרך רבין יצחק');
    expect(input('כמות בקבוקים').value).toBe('45');
    const button = screen.getByRole('button', { name: 'שליחת הזמנה' });
    expect(button.getAttribute('aria-disabled')).toBeNull();

    submit();
    await waitFor(() => expect(requests).toHaveLength(2));
    // The same answer again: the message is shown anew, once.
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('shows the rate-limit message above the button', async () => {
    renderForm({ kind: 'rateLimited', message: CREATE_ORDER_MESSAGES.rateLimited });
    fillValidForm();

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(CREATE_ORDER_MESSAGES.rateLimited);
    expect(input('כמות בקבוקים').value).toBe('45');
  });

  it('shows a refusal of a field the form does not know above the button', async () => {
    renderForm({ kind: 'invalid', errors: mapFieldErrors({ 'contact.email': 'לא ידוע' }) });
    fillValidForm();

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(UNKNOWN_FIELD_ERROR);
  });

  it("shows the api's refusal of the phone next to the phone field", async () => {
    renderForm({ kind: 'invalid', errors: mapFieldErrors({ 'contact.phone': PHONE_ERROR }) });
    fillValidForm();

    submit();

    const phone = input('טלפון נייד');
    await waitFor(() => expect(phone.getAttribute('aria-invalid')).toBe('true'));
    expect(descriptionOf(phone)).toContain(PHONE_ERROR);
    expect(document.activeElement).toBe(phone);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has a honeypot input that people never reach', () => {
    const { container } = renderForm();

    const honeypot = container.querySelector<HTMLInputElement>('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot?.tabIndex).toBe(-1);
    expect(honeypot?.getAttribute('autocomplete')).toBe('off');
    expect(honeypot?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'אתר אינטרנט' })).toBeNull();
  });

  it('sends what a bot typed into the honeypot, for the api to judge', async () => {
    const { container, requests } = renderForm();
    fillValidForm();
    const honeypot = container.querySelector('input[name="website"]');
    if (honeypot === null) throw new Error('honeypot input missing');

    fireEvent.change(honeypot, { target: { value: 'https://spam.example' } });
    submit();

    await screen.findByRole('heading', { level: 1, name: 'תודה!' });
    expect(requests[0]?.website).toBe('https://spam.example');
  });

  it('opens the numeric keyboard for the phone and the number of bottles', () => {
    renderForm();

    expect(input('טלפון נייד').inputMode).toBe('numeric');
    expect(input('טלפון נייד').type).toBe('tel');
    expect(input('כמות בקבוקים').inputMode).toBe('numeric');
    expect(input('מספר בית').inputMode).toBe('');
  });

  it('shows the privacy line and the hints of the phone and the number of bottles', () => {
    renderForm();

    expect(screen.getByText('הפרטים משמשים רק לתיאום האיסוף')).toBeDefined();
    expect(descriptionOf(input('טלפון נייד'))).toBe('למשל 050-1234567');
    expect(descriptionOf(input('כמות בקבוקים'))).toBe('לפחות 20 בקבוקים');
  });
});
