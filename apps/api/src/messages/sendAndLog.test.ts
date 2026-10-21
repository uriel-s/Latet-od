// Tests of sendAndLog.ts (ADR-0003): the customer-page link, the message built from an order, and
// that every outcome of a send (a wa.me link, an automatic send, a failure, a sender that blows
// up, a result the log refuses) is appended to the order's message log without touching its
// status. Runs on the in-memory orders repo and FakeSender (or the real WaMeLinkSender, which
// never touches the network).
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  renderMessage,
  type MessageLogEntry,
  type NewOrder,
  type Order,
  type OutgoingMessage,
} from '@bottlerun/shared';
import { FAKE_PUBLIC_BASE_URL } from '../fakeDeps.ts';
import { InMemoryOrdersRepo } from '../orders/inMemoryOrdersRepo.ts';
import { MADE_ORDER_CREATED_AT, makeNewOrder } from '../orders/makeOrder.ts';
import { FakeSender } from './fakeSender.ts';
import type { SendResult } from './messageSender.ts';
import { orderMessage, orderPageUrl, sendAndLog, type SendAndLogDeps } from './sendAndLog.ts';
import { WaMeLinkSender } from './waMeLinkSender.ts';

/** The fixed clock of every sendAndLog call below. */
const NOW = new Date('2026-11-01T09:15:00.000Z');
const ROUND_DATE = '2026-11-05';

// The customer's data. Distinctive values, so "the log does not contain it" cannot pass by accident.
const NAME = 'רבקה לוינסון';
const PHONE_E164 = '+972547654321';
const PHONE_DIGITS = '0547654321';

/** A message already in the log before the tests' send: an older round's confirmation request. */
const EARLIER_ENTRY: MessageLogEntry = {
  kind: 'confirmRequest',
  at: MADE_ORDER_CREATED_AT,
  mode: 'manual',
  url: 'https://wa.me/972547654321?text=earlier',
};

let orders: InMemoryOrdersRepo;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  orders = new InMemoryOrdersRepo();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A stored `pending` order of {@link NAME} with one earlier message in its log. */
function seed(overrides: Partial<NewOrder> = {}): Promise<Order> {
  return orders.create(
    makeNewOrder({
      contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
      status: 'pending',
      roundId: 'round-7',
      messages: [EARLIER_ENTRY],
      ...overrides,
    }),
  );
}

/** sendAndLog's dependencies: the test's repo, `sender`, and the fixed clock {@link NOW}. */
function depsWith(sender: SendAndLogDeps['sender']): SendAndLogDeps {
  return { orders, sender, now: () => new Date(NOW) };
}

/** The confirmation request of the round of {@link ROUND_DATE} for `order`. */
function confirmRequestFor(order: Order): OutgoingMessage {
  return orderMessage(order, 'confirmRequest', {
    publicBaseUrl: FAKE_PUBLIC_BASE_URL,
    date: ROUND_DATE,
  });
}

/** The stored order with this id; fails the test when there is none. */
async function stored(id: string): Promise<Order> {
  const order = await orders.findById(id);
  if (order === null) throw new Error('no stored order has this id');
  return order;
}

describe('orderPageUrl', () => {
  it('is the customer page /o/<token> on the public origin', () => {
    const token = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';

    expect(orderPageUrl(FAKE_PUBLIC_BASE_URL, token)).toBe(`https://latet-od.test/o/${token}`);
  });

  it('encodes a token that is not base64url, so it cannot change the path', () => {
    expect(orderPageUrl(FAKE_PUBLIC_BASE_URL, 'a/../b?c')).toBe(
      'https://latet-od.test/o/a%2F..%2Fb%3Fc',
    );
  });
});

describe('orderMessage', () => {
  it('builds a confirmation request to the stored phone, with the link to the order page', async () => {
    const order = await seed();

    const message = orderMessage(order, 'confirmRequest', {
      publicBaseUrl: FAKE_PUBLIC_BASE_URL,
      date: ROUND_DATE,
      pickupBy: '08:00',
      personalText: 'נא לשים בשקית',
    });

    expect(message).toStrictEqual({
      kind: 'confirmRequest',
      orderId: order.id,
      to: PHONE_E164,
      vars: {
        name: NAME,
        link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}`,
        date: ROUND_DATE,
        pickupBy: '08:00',
      },
      personalText: 'נא לשים בשקית',
    });
  });

  it('passes pickupFrom to the message vars only when given', async () => {
    const order = await seed();

    const withWindow = orderMessage(order, 'confirmRequest', {
      publicBaseUrl: FAKE_PUBLIC_BASE_URL,
      date: ROUND_DATE,
      pickupFrom: '07:00',
      pickupBy: '08:00',
    });
    const without = orderMessage(order, 'confirmRequest', {
      publicBaseUrl: FAKE_PUBLIC_BASE_URL,
      date: ROUND_DATE,
      pickupBy: '08:00',
    });

    expect(withWindow.vars.pickupFrom).toBe('07:00');
    expect(without.vars).not.toHaveProperty('pickupFrom');
  });

  it('leaves out the optional values that are not given, instead of setting them to undefined', async () => {
    const order = await seed();

    const message = orderMessage(order, 'confirmRequest', { publicBaseUrl: FAKE_PUBLIC_BASE_URL });

    expect(message).toStrictEqual({
      kind: 'confirmRequest',
      orderId: order.id,
      to: PHONE_E164,
      vars: { name: NAME, link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}` },
    });
  });

  it('builds a thank-you without the personal text, even when one is given', async () => {
    const order = await seed({ status: 'collected' });

    const message = orderMessage(order, 'thankYou', {
      publicBaseUrl: FAKE_PUBLIC_BASE_URL,
      personalText: 'נא לשים בשקית',
    });

    expect(message).toStrictEqual({
      kind: 'thankYou',
      orderId: order.id,
      to: PHONE_E164,
      vars: { name: NAME, link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}` },
    });
  });
});

describe('sendAndLog', () => {
  it('appends the manual link to the log, keeping earlier entries and the status', async () => {
    const order = await seed();
    const sender = new FakeSender();
    const message = confirmRequestFor(order);

    const outcome = await sendAndLog(depsWith(sender), order, message);

    const newEntry: MessageLogEntry = {
      kind: 'confirmRequest',
      at: NOW,
      mode: 'manual',
      url: 'https://fake-sender.test/1',
    };
    expect(sender.sent).toEqual([message]);
    expect(outcome.result).toEqual({ mode: 'manual', url: 'https://fake-sender.test/1' });
    expect(outcome.messageIndex).toBe(1);
    const after = await stored(order.id);
    expect(after).toStrictEqual({
      ...order,
      messages: [EARLIER_ENTRY, newEntry],
      updatedAt: NOW,
    });
    expect(after.status).toBe('pending');
    expect(outcome.order).toStrictEqual(after);
  });

  it('appends one message after another when each call gets the order the previous one returned', async () => {
    const order = await seed({ messages: [] });
    const sender = new FakeSender();

    const first = await sendAndLog(depsWith(sender), order, confirmRequestFor(order));
    const thanks = orderMessage(first.order, 'thankYou', { publicBaseUrl: FAKE_PUBLIC_BASE_URL });
    const second = await sendAndLog(depsWith(sender), first.order, thanks);

    expect([first.messageIndex, second.messageIndex]).toEqual([0, 1]);
    expect((await stored(order.id)).messages.map((entry) => entry.kind)).toEqual([
      'confirmRequest',
      'thankYou',
    ]);
  });

  it('with WaMeLinkSender stores a wa.me link whose text holds the order page link', async () => {
    const order = await seed();
    const message = confirmRequestFor(order);

    const outcome = await sendAndLog(depsWith(new WaMeLinkSender()), order, message);

    const entry = (await stored(order.id)).messages[outcome.messageIndex];
    if (entry?.mode !== 'manual') throw new Error('expected a manual entry');
    expect(entry.url.startsWith('https://wa.me/972')).toBe(true);
    const text = decodeURIComponent(entry.url.slice(entry.url.indexOf('?text=') + '?text='.length));
    expect(text).toContain(orderPageUrl(FAKE_PUBLIC_BASE_URL, order.token));
    expect(text).toBe(renderMessage('confirmRequest', message.vars));
  });

  it('stores an automatic send with its provider id', async () => {
    const order = await seed();
    const sender = new FakeSender(() => ({ mode: 'sent', providerId: 'wamid.HBgM' }));

    const outcome = await sendAndLog(depsWith(sender), order, confirmRequestFor(order));

    expect(outcome.result).toEqual({ mode: 'sent', providerId: 'wamid.HBgM' });
    expect((await stored(order.id)).messages[1]).toStrictEqual({
      kind: 'confirmRequest',
      at: NOW,
      mode: 'sent',
      providerId: 'wamid.HBgM',
    });
  });

  it('stores a failure with its reason, and leaves the status as it was', async () => {
    const order = await seed();
    const sender = new FakeSender(() => ({ mode: 'failed', reason: 'invalid_phone' }));

    const outcome = await sendAndLog(depsWith(sender), order, confirmRequestFor(order));

    expect(outcome.result).toEqual({ mode: 'failed', reason: 'invalid_phone' });
    const after = await stored(order.id);
    expect(after.messages[1]).toStrictEqual({
      kind: 'confirmRequest',
      at: NOW,
      mode: 'failed',
      reason: 'invalid_phone',
    });
    expect(after.status).toBe('pending');
  });

  it('stores a sender that rejects as failed / sender_error, logging the error without customer data', async () => {
    const order = await seed();
    // An error whose message quotes the customer, the way a provider's error might.
    const sender = new FakeSender(() => {
      throw new Error(`cannot send to ${PHONE_E164} (${PHONE_DIGITS}), ${NAME}`);
    });

    const outcome = await sendAndLog(depsWith(sender), order, confirmRequestFor(order));

    expect(outcome.result).toEqual({ mode: 'failed', reason: 'sender_error' });
    expect((await stored(order.id)).messages[1]).toStrictEqual({
      kind: 'confirmRequest',
      at: NOW,
      mode: 'failed',
      reason: 'sender_error',
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logText = consoleError.mock.calls
      .flat()
      .map((arg: unknown) => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
      .join('\n');
    for (const secret of [PHONE_E164, PHONE_E164.slice(1), PHONE_DIGITS, NAME, order.token]) {
      expect(logText).not.toContain(secret);
    }
  });

  it('keeps going after a rejecting sender: the next order is sent and logged', async () => {
    const first = await seed();
    const second = await seed({
      contact: { name: 'משה כהן', phone: '+972541111111', method: 'whatsapp' },
    });
    let calls = 0;
    const sender = new FakeSender(() => {
      calls += 1;
      if (calls === 1) throw new Error('provider down');
      return { mode: 'manual', url: 'https://fake-sender.test/ok' };
    });

    await sendAndLog(depsWith(sender), first, confirmRequestFor(first));
    const outcome = await sendAndLog(depsWith(sender), second, confirmRequestFor(second));

    expect(outcome.result).toEqual({ mode: 'manual', url: 'https://fake-sender.test/ok' });
    expect((await stored(first.id)).messages[1]).toMatchObject({ reason: 'sender_error' });
  });

  it.each<{ label: string; result: SendResult }>([
    { label: 'an http url', result: { mode: 'manual', url: 'http://wa.me/972547654321' } },
    { label: 'a javascript: url', result: { mode: 'manual', url: 'javascript:alert(1)' } },
    { label: 'an empty provider id', result: { mode: 'sent', providerId: '' } },
    { label: 'an unknown mode', result: { mode: 'queued' } as unknown as SendResult },
  ])('stores a result the log refuses ($label) as failed / invalid_result', async ({ result }) => {
    const order = await seed();
    const sender = new FakeSender(() => result);

    const outcome = await sendAndLog(depsWith(sender), order, confirmRequestFor(order));

    expect(outcome.result).toEqual({ mode: 'failed', reason: 'invalid_result' });
    expect((await stored(order.id)).messages[1]).toStrictEqual({
      kind: 'confirmRequest',
      at: NOW,
      mode: 'failed',
      reason: 'invalid_result',
    });
  });

  it('defaults to the real clock', async () => {
    const order = await seed();
    const before = Date.now();

    await sendAndLog({ orders, sender: new FakeSender() }, order, confirmRequestFor(order));

    const after = Date.now();
    const at = (await stored(order.id)).messages[1]?.at.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('refuses a message of another order, sending and writing nothing', async () => {
    const order = await seed();
    const other = await seed({
      contact: { name: 'משה כהן', phone: '+972541111111', method: 'whatsapp' },
    });
    const sender = new FakeSender();

    await expect(sendAndLog(depsWith(sender), order, confirmRequestFor(other))).rejects.toThrow(
      'sendAndLog: the message belongs to another order',
    );

    expect(sender.sent).toEqual([]);
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it('throws when the order is no longer stored', async () => {
    // Stored in another repo only, so the test's repo cannot update it.
    const missing = await new InMemoryOrdersRepo().create(makeNewOrder());

    await expect(
      sendAndLog(depsWith(new FakeSender()), missing, confirmRequestFor(missing)),
    ).rejects.toThrow('sendAndLog: the order no longer exists');
  });
});
