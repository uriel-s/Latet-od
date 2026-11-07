// The English booking form at /en: the same form in English, left to right, with the language
// button, English errors, and `lang: 'en'` sent with the order. The Hebrew form is tested in
// OrderFormPage.test.tsx.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_BOTTLES, type CreateOrderRequest } from '@bottlerun/shared';
import { App } from '../App.tsx';
import type { CreateOrderOutcome } from '../api.ts';
import { OrderFormPage } from './OrderFormPage.tsx';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function renderEnglishForm(outcome: CreateOrderOutcome): { requests: CreateOrderRequest[] } {
  const requests: CreateOrderRequest[] = [];
  render(
    <OrderFormPage
      lang="en"
      submitOrder={(request) => {
        requests.push(request);
        return Promise.resolve(outcome);
      }}
    />,
  );
  acceptNotice();
  return { requests };
}

/** Presses "I understand, continue": the rules notice gives way to the form. */
function acceptNotice(): void {
  fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }));
}

function typeInto(label: string, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

function fillValidForm(): void {
  typeInto('Name', 'Rachel Cohen');
  typeInto('Mobile phone', '050-1234567');
  // Latin search finds the street; its button shows the English name.
  typeInto('Street', 'rabin');
  fireEvent.click(screen.getByRole('button', { name: 'Derekh Rabin Yitzhak' }));
  typeInto('House number', '12');
  fireEvent.click(screen.getByLabelText('At the entrance of a private house'));
  typeInto('Number of bottles', '45');
}

const CREATED: CreateOrderOutcome = {
  kind: 'created',
  response: {
    token: TOKEN,
    order: {
      contact: { name: 'Rachel Cohen', phone: '+972501234567' },
      address: {
        streetCode: 247,
        streetName: 'דרך רבין יצחק',
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
      },
      bottlesEstimated: 45,
    },
  },
};

describe('the English booking form', () => {
  it('shows the rules notice in English first, then the form', () => {
    render(<OrderFormPage lang="en" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Please note!' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('link', { name: 'עברית' }).getAttribute('href')).toBe('/');

    acceptNotice();

    expect(screen.getByRole('heading', { level: 1, name: 'Book a bottle pickup' })).toBeDefined();
    expect(screen.getByLabelText('Name')).toBeDefined();
  });

  it('groups the fields in cards titled in English and offers the spot as radios', () => {
    renderEnglishForm(CREATED);
    for (const name of ['Details', 'Address', 'Bottles']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeDefined();
    }
    expect(
      screen.getByRole('radio', { name: 'Downstairs at the building entrance' }),
    ).toBeDefined();
  });

  it('sends a full order with lang en and confirms in English', async () => {
    const { requests } = renderEnglishForm(CREATED);

    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send order' }));

    const link = await screen.findByRole('link', { name: 'View or cancel the order' });
    expect(link.getAttribute('href')).toBe(`/o/${TOKEN}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Thank you!' })).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      lang: 'en',
      // The order still stores the code and the official Hebrew name.
      address: { streetCode: 247, streetName: 'דרך רבין יצחק' },
    });
  });

  it('shows field errors in English, the phone error too', () => {
    renderEnglishForm(CREATED);

    typeInto('Mobile phone', '123');
    typeInto('Number of bottles', String(MIN_BOTTLES));
    fireEvent.click(screen.getByRole('button', { name: 'Send order' }));

    expect(screen.getByText('Please write your name')).toBeDefined();
    expect(screen.getByText('Invalid mobile number. For example: 050-1234567')).toBeDefined();
    expect(screen.getByText('Please choose a street or type it')).toBeDefined();
    expect(screen.getByText('Please choose where the bottles are')).toBeDefined();
  });

  it('shows the api errors and the network error in English', async () => {
    renderEnglishForm({ kind: 'duplicate', message: 'כבר יש הזמנה פתוחה למספר הזה.' });
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send order' }));
    expect(
      await screen.findByText('There is already an open order for this number.'),
    ).toBeDefined();
    cleanup();

    renderEnglishForm({ kind: 'failed' });
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send order' }));
    expect(
      await screen.findByText(
        'We could not send. Please check your internet connection and try again.',
      ),
    ).toBeDefined();
  });

  it('switches language from the rules notice itself, before accepting it', () => {
    window.history.replaceState(null, '', '/en');
    render(<App />);

    fireEvent.click(screen.getByRole('link', { name: 'עברית' }));

    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'שימו לב!' })).toBeDefined();
  });

  it('switches between the languages with the big button and sets lang and dir', () => {
    window.history.replaceState(null, '', '/en');
    render(<App />);

    // The button is on the rules notice too, so the language can be changed before accepting.
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('heading', { level: 1, name: 'Please note!' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'כניסת מנהל' })).toBeNull();
    acceptNotice();
    expect(screen.getByRole('heading', { level: 1, name: 'Book a bottle pickup' })).toBeDefined();

    fireEvent.click(screen.getByRole('link', { name: 'עברית' }));
    expect(window.location.pathname).toBe('/');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    // The other language's page starts with its own notice.
    expect(screen.getByRole('heading', { level: 1, name: 'שימו לב!' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'הבנתי, להזמנה' }));
    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();

    fireEvent.click(screen.getByRole('link', { name: 'English' }));
    expect(window.location.pathname).toBe('/en');
    expect(screen.getByRole('heading', { level: 1, name: 'Please note!' })).toBeDefined();
  });
});
