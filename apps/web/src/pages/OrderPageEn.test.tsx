// The customer page for an English order (`order.lang === 'en'`): every text, the date and times,
// the change form and the new-order link in English. The Hebrew page is tested in OrderPage.test.tsx.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
  findStreet,
  streetDisplayName,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
} from '@bottlerun/shared';
import type { CustomerOrderOutcome, CustomerOrderWriteOutcome } from '../api.ts';
import { prefillFromNavigationState } from '../orderForm/savedDetails.ts';
import { OrderPage } from './OrderPage.tsx';

const TOKEN = 'Q'.repeat(43);
const ROUND = { date: '2026-11-12', pickupFrom: '16:00', pickupBy: '18:00' };

function makeOrder(overrides: Partial<CustomerOrder> = {}): CustomerOrder {
  return {
    contact: { name: 'Dana Cohen', phone: '+972501234567' },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'floor 3, apt 12',
    },
    bottlesEstimated: 40,
    status: 'waiting',
    lang: 'en',
    ...overrides,
  };
}

interface Options {
  update?: CustomerOrderWriteOutcome;
  cancel?: CustomerOrderWriteOutcome;
  decline?: CustomerOrderWriteOutcome;
  load?: CustomerOrderOutcome;
}

/** Renders the page and waits for its English heading. Returns the change requests sent. */
async function renderEn(
  order: CustomerOrder,
  { update, cancel, decline, load }: Options = {},
): Promise<CustomerUpdateOrderRequest[]> {
  window.history.replaceState(null, '', `/o/${TOKEN}`);
  const updates: CustomerUpdateOrderRequest[] = [];
  render(
    <OrderPage
      token={TOKEN}
      loadOrder={() => Promise.resolve(load ?? { kind: 'loaded', order })}
      declineOrder={() => Promise.resolve(decline ?? { kind: 'saved', order })}
      cancelOrder={() => Promise.resolve(cancel ?? { kind: 'saved', order })}
      updateOrder={(_token, request) => {
        updates.push(request);
        return Promise.resolve(update ?? { kind: 'saved', order });
      }}
    />,
  );
  await screen.findByRole('heading', { level: 1, name: 'Your order' });
  return updates;
}

/** The element whose whole text is `text`, across the `<bdi>` inside it. */
function wholeText(text: string): HTMLElement {
  return screen.getByText((_content, element) => element?.textContent === text);
}

function statusLine(): string | null {
  return screen.getByText('Order status:', { exact: false }).textContent;
}

afterEach(() => {
  document.documentElement.lang = 'he';
  document.documentElement.dir = 'rtl';
});

describe('OrderPage in English', () => {
  it('sets the document to English left to right, and back to Hebrew when it leaves', async () => {
    window.history.replaceState(null, '', `/o/${TOKEN}`);
    const { unmount } = render(
      <OrderPage
        token={TOKEN}
        loadOrder={() => Promise.resolve({ kind: 'loaded', order: makeOrder() })}
      />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Your order' });
    // The hook sets lang/dir in a passive effect, which can run after the heading is found.
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en');
      expect(document.documentElement.dir).toBe('ltr');
    });

    unmount();

    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('tells the app its language', async () => {
    const seen: string[] = [];
    window.history.replaceState(null, '', `/o/${TOKEN}`);
    render(
      <OrderPage
        token={TOKEN}
        loadOrder={() => Promise.resolve({ kind: 'loaded', order: makeOrder() })}
        onLangChange={(lang) => seen.push(lang)}
      />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Your order' });
    expect(seen).toContain('en');
  });

  it('shows a waiting order with its details', async () => {
    await renderEn(makeOrder());

    expect(statusLine()).toBe('Order status: Waiting for a round');
    expect(screen.getByText('Waiting for a round').closest('.badge')).not.toBeNull();
    expect(screen.getByText(/We will send you a WhatsApp message/)).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Order details' })).toBeDefined();
    const street = streetDisplayName(findStreet(247)!, 'en');
    expect(wholeText(`${street} 12`)).toBeDefined();
    expect(
      screen.getByText('In a building - by the apartment door · floor 3, apt 12'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Change' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel the order' })).toBeDefined();
  });

  it('lays the details out as rows in English too, the phone left to right', async () => {
    await renderEn(makeOrder());

    const details = screen.getByRole('region', { name: 'Order details' });
    const names = Array.from(details.querySelectorAll('dl > div > dt')).map(
      (name) => name.textContent,
    );
    expect(names).toHaveLength(details.querySelectorAll('dl > div > dd').length);
    expect(names[0]).toBe('Name');
    expect(within(details).getByText('050-1234567').closest('[dir="ltr"]')).not.toBeNull();
  });

  it('shows an order in a round with the date, the window and "Not this time", nothing to confirm', async () => {
    await renderEn(makeOrder({ status: 'confirmed', round: ROUND }));

    expect(statusLine()).toBe('Order status: Scheduled');
    expect(wholeText('We will come to collect on Nov 12.')).toBeDefined();
    // The start is said twice: the time to put the bottles out by, and when the window opens.
    expect(
      wholeText('Please put the bottles out by 16:00. We will come between 16:00 and 18:00.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Not this time' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Yes, I will put the bottles out/ })).toBeNull();
  });

  it('shows only the latest time when there is no start time', async () => {
    await renderEn(
      makeOrder({ status: 'confirmed', round: { date: '2026-11-12', pickupBy: '18:00' } }),
    );

    expect(wholeText('Please put the bottles out by 18:00.')).toBeDefined();
  });

  it('shows a legacy pending order like one in a round, with "Not this time"', async () => {
    await renderEn(makeOrder({ status: 'pending', round: ROUND }));

    expect(statusLine()).toBe('Order status: Scheduled');
    expect(wholeText('We will come to collect on Nov 12.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Not this time' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Yes, I will put the bottles out/ })).toBeNull();
  });

  it('shows a collected order with thanks and a new-order button', async () => {
    await renderEn(makeOrder({ status: 'collected' }));

    expect(statusLine()).toBe('Order status: Collected');
    expect(screen.getByText(/The order was collected/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'New order with the same details' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('shows a cancelled order', async () => {
    await renderEn(makeOrder({ status: 'cancelled' }));

    expect(statusLine()).toBe('Order status: Cancelled');
    expect(screen.getByText('Thank you! You can book a new pickup at any time.')).toBeDefined();
  });

  it('opens the English booking form with the same details from the new-order button', async () => {
    await renderEn(makeOrder({ status: 'collected' }));

    fireEvent.click(screen.getByRole('button', { name: 'New order with the same details' }));

    expect(window.location.pathname).toBe('/en');
    const prefill = prefillFromNavigationState(window.history.state);
    expect(prefill?.contact.name).toBe('Dana Cohen');
    expect(prefill?.address.streetCode).toBe(247);
  });

  it('asks in English before cancelling and announces the cancel in English', async () => {
    await renderEn(makeOrder(), {
      cancel: { kind: 'saved', order: makeOrder({ status: 'cancelled' }) },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    expect(screen.getByText('Cancel the order?')).toBeDefined();
    expect(screen.getByRole('button', { name: 'No, keep it' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));

    expect((await screen.findByRole('status')).textContent).toBe('The order was cancelled.');
  });

  it('asks in English before declining', async () => {
    await renderEn(makeOrder({ status: 'confirmed', round: ROUND }));

    fireEvent.click(screen.getByRole('button', { name: 'Not this time' }));

    expect(
      screen.getByText('Not suitable this time? The order will wait for the next round.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Yes, not suitable' })).toBeDefined();
  });

  it('announces a decline in English', async () => {
    await renderEn(makeOrder({ status: 'confirmed', round: ROUND }), {
      decline: { kind: 'saved', order: makeOrder() },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Not this time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, not suitable' }));

    expect((await screen.findByRole('status')).textContent).toBe(
      'Got it. We will get back to you with a new date.',
    );
  });

  it('tells in English that the order closed meanwhile', async () => {
    await renderEn(makeOrder({ status: 'confirmed', round: ROUND }), {
      decline: { kind: 'closed', message: CUSTOMER_ORDER_MESSAGES.orderClosed },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Not this time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, not suitable' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This order is already closed and cannot be changed.',
    );
  });

  describe('the change form', () => {
    async function openChange(order = makeOrder(), options: Options = {}) {
      const updates = await renderEn(order, options);
      fireEvent.click(screen.getByRole('button', { name: 'Change' }));
      return updates;
    }

    it('is in English, filled from the order, with no name or phone', async () => {
      await openChange();

      expect(
        screen.getByRole('heading', { level: 2, name: 'Change the order details' }),
      ).toBeDefined();
      expect(screen.getByText('The phone number cannot be changed here.')).toBeDefined();
      const street = streetDisplayName(findStreet(247)!, 'en');
      expect(screen.getByLabelText<HTMLInputElement>('Street').value).toBe(street);
      expect(screen.getByLabelText<HTMLInputElement>('House number').value).toBe('12');
      expect(screen.getByLabelText<HTMLInputElement>('Number of bottles').value).toBe('40');
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Keep as is' })).toBeDefined();
    });

    it('shows field errors in English', async () => {
      const updates = await openChange();

      fireEvent.change(screen.getByLabelText('House number'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Number of bottles'), { target: { value: '5' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(screen.getByText('Please write a house number')).toBeDefined();
      expect(screen.getByText('At least 20 bottles are needed')).toBeDefined();
      expect(updates).toEqual([]);
    });

    it('warns in English that a new address takes the order out of its round', async () => {
      await openChange(makeOrder({ status: 'confirmed', round: ROUND }));

      fireEvent.change(screen.getByLabelText('House number'), { target: { value: '14' } });

      expect(
        wholeText(
          'Changing the address will take the order out of the round on Nov 12, and we will get back to you with a new date.',
        ),
      ).toBeDefined();
    });

    it('announces a saved change in English', async () => {
      const updates = await openChange();

      fireEvent.change(screen.getByLabelText('Number of bottles'), { target: { value: '50' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect((await screen.findByRole('status')).textContent).toBe('The changes were saved.');
      expect(updates).toHaveLength(1);
    });

    it('shows a failed save in English', async () => {
      await openChange(makeOrder(), { update: { kind: 'failed' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect((await screen.findByRole('alert')).textContent).toBe(
        'We could not save. Please check your internet connection and try again.',
      );
    });
  });
});
